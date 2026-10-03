import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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

function driveStorageName(input: PutKoshObjectInput) {
  const filename = clean(input.filename, 160) || "object.bin";
  const repositoryId = clean(input.repositoryId, 80) || "repository";
  const logicalId = clean(input.logicalId, 80) || "object";
  return `${repositoryId}__${logicalId}__${filename}`;
}

async function putGoogleDriveObject(input: PutKoshObjectInput): Promise<KoshObjectLocator> {
  const metadata = {
    name: driveStorageName(input),
    parents: [driveFolderId(input.storageClass)],
    properties: {
      koshRepositoryId: clean(input.repositoryId, 124),
      koshStorageClass: input.storageClass,
      koshLogicalId: clean(input.logicalId, 124),
      koshSha256: input.sha256
    }
  };
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

export async function readKoshObject(
  locator: KoshObjectLocator | null,
  localFallbackPath: string
) {
  if (!locator || locator.backend === "local") {
    return readFile(localFallbackPath);
  }
  return readGoogleDriveObject(locator);
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
