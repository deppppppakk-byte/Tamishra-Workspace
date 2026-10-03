import type { KoshStorageClass } from "./kosh-storage-policy.js";

export type KoshDriveObject = {
  id: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string | null;
  storageClass: KoshStorageClass;
  repositoryId: string;
  logicalId: string;
  sha256: string;
};

type CachedToken = { value: string; expiresAt: number };
let cachedToken: CachedToken | null = null;

function clean(value: string, maxLength: number) {
  return value.replace(/[\u0000-\u001f\u007f]/g, "_").trim().slice(0, maxLength);
}

function timeoutMs() {
  const configured = Number(process.env.KOSH_GOOGLE_DRIVE_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(configured)
    ? Math.max(5_000, Math.min(15 * 60_000, Math.floor(configured)))
    : 120_000;
}

function folderId(storageClass: KoshStorageClass) {
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

async function accessToken() {
  const direct = process.env.KOSH_GOOGLE_DRIVE_ACCESS_TOKEN?.trim();
  if (direct) return direct;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const clientId = process.env.KOSH_GOOGLE_DRIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.KOSH_GOOGLE_DRIVE_CLIENT_SECRET?.trim();
  const refreshToken = process.env.KOSH_GOOGLE_DRIVE_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw Object.assign(new Error("kosh_google_drive_oauth_required"), { status: 503 });
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
    signal: AbortSignal.timeout(timeoutMs())
  });
  const payload = await response.json() as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw Object.assign(new Error(payload.error || "kosh_google_drive_token_failed"), {
      status: 503
    });
  }
  const ttl = Math.max(300, Number(payload.expires_in) || 3600);
  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + ttl * 1000
  };
  return cachedToken.value;
}

async function driveRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await accessToken()}`);
  return fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs())
  });
}

function driveQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export async function listKoshDriveObjects(
  repositoryId: string,
  storageClass: KoshStorageClass
) {
  const parent = folderId(storageClass);
  const repository = clean(repositoryId, 124);
  const query = [
    `'${driveQueryValue(parent)}' in parents`,
    "trashed = false",
    `properties has { key='koshRepositoryId' and value='${driveQueryValue(repository)}' }`,
    `properties has { key='koshStorageClass' and value='${driveQueryValue(storageClass)}' }`
  ].join(" and ");

  const items: KoshDriveObject[] = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: query,
      pageSize: "1000",
      fields: "nextPageToken,files(id,name,size,modifiedTime,properties,trashed)",
      spaces: "drive"
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await driveRequest(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { method: "GET" }
    );
    const payload = await response.json() as {
      nextPageToken?: string;
      files?: Array<{
        id?: string;
        name?: string;
        size?: string;
        modifiedTime?: string;
        properties?: Record<string, string>;
      }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw Object.assign(
        new Error(payload.error?.message || "kosh_google_drive_list_failed"),
        { status: 503 }
      );
    }
    for (const file of payload.files ?? []) {
      const properties = file.properties ?? {};
      if (!file.id) continue;
      items.push({
        id: file.id,
        name: file.name ?? "",
        sizeBytes: Math.max(0, Number(file.size) || 0),
        modifiedAt: file.modifiedTime ?? null,
        storageClass,
        repositoryId: properties.koshRepositoryId ?? repository,
        logicalId: properties.koshLogicalId ?? "",
        sha256: properties.koshSha256 ?? ""
      });
    }
    pageToken = payload.nextPageToken ?? "";
  } while (pageToken);

  return items;
}

export async function probeKoshDriveStorage() {
  const classes: KoshStorageClass[] = ["package", "release", "artifact", "backup"];
  const checks = await Promise.all(
    classes.map(async (storageClass) => {
      try {
        const id = folderId(storageClass);
        const response = await driveRequest(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,trashed`,
          { method: "GET" }
        );
        const payload = await response.json() as {
          id?: string;
          name?: string;
          trashed?: boolean;
          error?: { message?: string };
        };
        return {
          storageClass,
          ok: response.ok && Boolean(payload.id) && payload.trashed !== true,
          folderId: id,
          folderName: payload.name ?? null,
          error: response.ok ? null : payload.error?.message ?? `http_${response.status}`
        };
      } catch (error) {
        return {
          storageClass,
          ok: false,
          folderId: null,
          folderName: null,
          error: error instanceof Error ? error.message : "drive_probe_failed"
        };
      }
    })
  );
  return {
    ok: checks.every((item) => item.ok),
    checkedAt: new Date().toISOString(),
    checks
  };
}
