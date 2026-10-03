import { createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { KoshStorageClass } from "./kosh-storage-policy.js";

export type KoshObjectStorageBackend = "local" | "google-drive";

export type KoshObjectLocator = {
  backend: KoshObjectStorageBackend;
  objectId: string;
  storageClass: KoshStorageClass;
  sizeBytes: number;
  sha256: string;
};

type PutKoshObjectInput = {
  storageClass: KoshStorageClass;
  repositoryId: string;
  logicalId: string;
  filename: string;
  mediaType: string;
  bytes: Buffer;
  sha256: string;
  localPath: string;
};

type PutKoshObjectFileInput = Omit<PutKoshObjectInput, "bytes"> & {
  sourcePath: string;
  sizeBytes: number;
};

type CachedToken = {
  value: string;
  expiresAt: number;
};

let cachedToken: CachedToken | null = null;

function clean(value: string, maxLength: number) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .trim()
    .slice(0, maxLength);
}

function configuredBackend(): KoshObjectStorageBackend {
  const value = (process.env.KOSH_OBJECT_STORAGE_BACKEND ?? "local")
    .trim()
    .toLowerCase();
  if (value === "google-drive" || value === "gdrive" || value === "drive") {
    return "google-drive";
  }
  return "local";
}

export function koshObjectStorageBackend() {
  return configuredBackend();
}

function driveFolderId(storageClass: KoshStorageClass) {
  const specific =
    storageClass === "package"
      ? process.env.KOSH_GOOGLE_DRIVE_PACKAGES_FOLDER_ID
      : storageClass === "release"
        ? process.env.KOSH_GOOGLE_DRIVE_RELEASES_FOLDER_ID
        : storageClass === "artifact"
          ? process.env.KOSH_GOOGLE_DRIVE_ARTIFACTS_FOLDER_ID
          : process.env.KOSH_GOOGLE_DRIVE_BACKUPS_FOLDER_ID;
  const value = specific?.trim() || process.env.KOSH_GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();
  if (!value) {
    throw Object.assign(new Error("kosh_google_drive_folder_required"), {
      status: 503,
      storageClass
    });
  }
  return value;
}

function requestTimeoutMs() {
  const configured = Number(process.env.KOSH_GOOGLE_DRIVE_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(configured)
    ? Math.max(10_000, Math.min(15 * 60_000, Math.floor(configured)))
    : 120_000;
}

function resumableChunkBytes() {
  const configured = Number(process.env.KOSH_GOOGLE_DRIVE_CHUNK_MB ?? 8);
  const mb = Number.isFinite(configured)
    ? Math.max(1, Math.min(64, Math.floor(configured)))
    : 8;
  return mb * 1024 * 1024;
}

async function googleAccessToken() {
  const direct = process.env.KOSH_GOOGLE_DRIVE_ACCESS_TOKEN?.trim();
  if (direct) return direct;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const clientId = process.env.KOSH_GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.KOSH_GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.KOSH_GOOGLE_DRIVE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw Object.assign(new Error("kosh_google_drive_oauth_required"), {
      status: 503
    });
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }),
    signal: AbortSignal.timeout(requestTimeoutMs())
  });
  const payload = await response.json() as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw Object.assign(
      new Error(payload.error || "kosh_google_drive_token_failed"),
      { status: 503 }
    );
  }

  const ttl = Math.max(300, Number(payload.expires_in) || 3600);
  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + ttl * 1000
  };
  return cachedToken.value;
}

async function googleRequest(url: string, init: RequestInit = {}) {
  const token = await googleAccessToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs())
  });
}

function driveStorageName(input: {
  repositoryId: string;
  logicalId: string;
  filename: string;
}) {
  const filename = clean(input.filename, 160) || "object.bin";
  const repositoryId = clean(input.repositoryId, 80) || "repository";
  const logicalId = clean(input.logicalId, 80) || "object";
  return `${repositoryId}__${logicalId}__${filename}`;
}

function driveMetadata(input: {
  storageClass: KoshStorageClass;
  repositoryId: string;
  logicalId: string;
  filename: string;
  sha256: string;
}) {
  return {
    name: driveStorageName(input),
    parents: [driveFolderId(input.storageClass)],
    properties: {
      koshRepositoryId: clean(input.repositoryId, 124),
      koshStorageClass: input.storageClass,
      koshLogicalId: clean(input.logicalId, 124),
      koshSha256: input.sha256
    }
  };
}

async function putGoogleDriveObject(input: PutKoshObjectInput): Promise<KoshObjectLocator> {
  const metadata = driveMetadata(input);
  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
  const fileBytes = new Uint8Array(input.bytes.length);
  fileBytes.set(input.bytes);
  form.append(
    "file",
    new Blob([fileBytes.buffer], {
      type: input.mediaType || "application/octet-stream"
    }),
    clean(input.filename, 220) || "object.bin"
  );

  const response = await googleRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size",
    { method: "POST", body: form }
  );
  const payload = await response.json() as {
    id?: string;
    size?: string;
    error?: { message?: string };
  };
  if (!response.ok || !payload.id) {
    throw Object.assign(
      new Error(payload.error?.message || "kosh_google_drive_upload_failed"),
      { status: response.status >= 400 && response.status < 500 ? 502 : 503 }
    );
  }

  return {
    backend: "google-drive",
    objectId: payload.id,
    storageClass: input.storageClass,
    sizeBytes: input.bytes.length,
    sha256: input.sha256
  };
}

async function putGoogleDriveFile(
  input: PutKoshObjectFileInput
): Promise<KoshObjectLocator> {
  const metadata = driveMetadata(input);
  const session = await googleRequest(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size",
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-upload-content-type": input.mediaType || "application/octet-stream",
        "x-upload-content-length": String(input.sizeBytes)
      },
      body: JSON.stringify(metadata)
    }
  );
  if (!session.ok) {
    throw Object.assign(new Error("kosh_google_drive_resumable_start_failed"), {
      status: session.status >= 400 && session.status < 500 ? 502 : 503
    });
  }
  const uploadUrl = session.headers.get("location");
  if (!uploadUrl) {
    throw Object.assign(new Error("kosh_google_drive_resumable_location_missing"), {
      status: 503
    });
  }

  const handle = await open(input.sourcePath, "r");
  const chunkSize = resumableChunkBytes();
  let offset = 0;
  let finalPayload: { id?: string; size?: string } | null = null;
  try {
    while (offset < input.sizeBytes) {
      const length = Math.min(chunkSize, input.sizeBytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, offset);
      if (result.bytesRead <= 0) {
        throw Object.assign(new Error("kosh_object_source_truncated"), {
          status: 500
        });
      }
      const chunk = result.bytesRead === buffer.length
        ? buffer
        : buffer.subarray(0, result.bytesRead);
      const end = offset + result.bytesRead - 1;
      const response = await googleRequest(uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": input.mediaType || "application/octet-stream",
          "content-length": String(result.bytesRead),
          "content-range": `bytes ${offset}-${end}/${input.sizeBytes}`
        },
        body: new Uint8Array(chunk)
      });
      if (response.status === 308) {
        offset += result.bytesRead;
        continue;
      }
      if (!response.ok) {
        throw Object.assign(new Error("kosh_google_drive_resumable_upload_failed"), {
          status: response.status >= 400 && response.status < 500 ? 502 : 503
        });
      }
      finalPayload = await response.json() as { id?: string; size?: string };
      offset += result.bytesRead;
    }
  } finally {
    await handle.close();
  }

  if (!finalPayload?.id || offset !== input.sizeBytes) {
    throw Object.assign(new Error("kosh_google_drive_resumable_upload_incomplete"), {
      status: 503
    });
  }

  return {
    backend: "google-drive",
    objectId: finalPayload.id,
    storageClass: input.storageClass,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256
  };
}

async function readGoogleDriveObject(locator: KoshObjectLocator) {
  const response = await googleRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(locator.objectId)}?alt=media`,
    { method: "GET" }
  );
  if (!response.ok) {
    throw Object.assign(new Error("kosh_google_drive_object_missing"), {
      status: response.status === 404 ? 404 : 503
    });
  }
  return Buffer.from(await response.arrayBuffer());
}

async function materializeGoogleDriveObject(
  locator: KoshObjectLocator,
  destinationPath: string
) {
  const response = await googleRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(locator.objectId)}?alt=media`,
    { method: "GET" }
  );
  if (!response.ok || !response.body) {
    throw Object.assign(new Error("kosh_google_drive_object_missing"), {
      status: response.status === 404 ? 404 : 503
    });
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await pipeline(
    Readable.fromWeb(response.body as never),
    createWriteStream(destinationPath, { flags: "wx" })
  );
}

async function deleteGoogleDriveObject(locator: KoshObjectLocator) {
  const response = await googleRequest(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(locator.objectId)}`,
    { method: "DELETE" }
  );
  if (!response.ok && response.status !== 404) {
    throw Object.assign(new Error("kosh_google_drive_delete_failed"), {
      status: 503
    });
  }
}

export function parseKoshObjectLocator(value: unknown): KoshObjectLocator | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const backend = String(item.backend ?? "");
  const storageClass = String(item.storageClass ?? "");
  if (
    (backend !== "local" && backend !== "google-drive") ||
    !["artifact", "package", "release", "backup"].includes(storageClass) ||
    !String(item.objectId ?? "")
  ) {
    return null;
  }
  return {
    backend,
    objectId: String(item.objectId),
    storageClass: storageClass as KoshStorageClass,
    sizeBytes: Math.max(0, Number(item.sizeBytes) || 0),
    sha256: String(item.sha256 ?? "")
  };
}

export async function putKoshObject(input: PutKoshObjectInput) {
  if (configuredBackend() === "google-drive") {
    return putGoogleDriveObject(input);
  }

  await mkdir(dirname(input.localPath), { recursive: true });
  await writeFile(input.localPath, input.bytes, { flag: "wx" });
  return {
    backend: "local" as const,
    objectId: input.localPath,
    storageClass: input.storageClass,
    sizeBytes: input.bytes.length,
    sha256: input.sha256
  };
}

export async function putKoshObjectFromFile(input: PutKoshObjectFileInput) {
  if (configuredBackend() === "google-drive") {
    return putGoogleDriveFile(input);
  }

  const source = resolve(input.sourcePath);
  const target = resolve(input.localPath);
  if (source !== target) {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  const info = await stat(target);
  if (info.size !== input.sizeBytes) {
    throw Object.assign(new Error("kosh_object_size_changed"), { status: 500 });
  }
  return {
    backend: "local" as const,
    objectId: target,
    storageClass: input.storageClass,
    sizeBytes: input.sizeBytes,
    sha256: input.sha256
  };
}

export async function readKoshObject(
  locator: KoshObjectLocator | null,
  localFallbackPath: string
) {
  if (!locator || locator.backend === "local") {
    return readFile(localFallbackPath);
  }
  return readGoogleDriveObject(locator);
}

export async function materializeKoshObject(
  locator: KoshObjectLocator | null,
  localFallbackPath: string,
  destinationPath: string
) {
  await rm(destinationPath, { force: true }).catch(() => undefined);
  if (!locator || locator.backend === "local") {
    const source = resolve(localFallbackPath);
    const destination = resolve(destinationPath);
    await mkdir(dirname(destination), { recursive: true });
    if (source !== destination) {
      await copyFile(source, destination);
    }
    return destination;
  }
  await materializeGoogleDriveObject(locator, destinationPath);
  return destinationPath;
}

export async function deleteKoshObject(
  locator: KoshObjectLocator | null,
  localFallbackPath: string
) {
  if (!locator || locator.backend === "local") {
    await rm(localFallbackPath, { force: true }).catch(() => undefined);
    return;
  }
  await deleteGoogleDriveObject(locator);
}
