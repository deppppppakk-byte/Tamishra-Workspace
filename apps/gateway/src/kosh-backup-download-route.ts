import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { materializeKoshObject } from "./kosh-object-storage.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const objectIndex = getKoshObjectIndex();
const backupRoot = resolve(process.env.KOSH_BACKUP_ROOT?.trim() || ".kosh/backups");

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeStoragePath(root: string, ...segments: string[]) {
  const cleaned = segments.map((value) => {
    const part = value.trim();
    if (
      !part ||
      part.length > 240 ||
      part === "." ||
      part === ".." ||
      part.includes("/") ||
      part.includes("\\") ||
      part.includes("\0")
    ) {
      throw Object.assign(new Error("invalid_storage_segment"), { status: 400 });
    }
    return part;
  });
  const path = resolve(root, ...cleaned);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_storage_path"), { status: 400 });
  }
  return path;
}

async function hashFile(path: string) {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

export async function handleKoshBackupDownloadRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (request.method !== "GET") return false;
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/recovery\/backups\/([^/]+)\/download$/
  );
  if (!match) return false;

  let temporaryPath = "";
  try {
    const repository = await repositoryStore.get(match[1], match[2]);
    if (!repository) {
      json(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
      return true;
    }
    const authorization = await authorizeKoshRepositoryRequest(
      request,
      repository,
      "repository.read"
    );
    if (!authorization.decision.allowed || !authorization.identity) {
      json(
        response,
        authorization.identity ? 403 : 401,
        {
          error: authorization.identity
            ? "repository_permission_denied"
            : "authentication_required",
          permission: "repository.read",
          role: authorization.decision.role
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    await Promise.all([platformStore.ready(), objectIndex.ready()]);
    const backupId = decodeURIComponent(match[3]);
    const backup = await platformStore.getResource(backupId);
    if (!backup || backup.repositoryId !== repository.id || backup.type !== "backup") {
      json(response, 404, { error: "backup_not_found" }, origin, allowedOrigins);
      return true;
    }
    const filename = clean(backup.payload.filename, 240);
    if (!filename) {
      json(response, 409, { error: "backup_file_missing" }, origin, allowedOrigins);
      return true;
    }
    const logicalId = clean(backup.payload.storageLogicalId, 240) || null;
    const indexed = logicalId
      ? await objectIndex.get(repository.id, "backup", logicalId)
      : await objectIndex.get(repository.id, "backup", backup.id);
    const localPath = safeStoragePath(backupRoot, repository.id, filename);
    let path = localPath;
    if (indexed?.locator.backend === "google-drive") {
      await mkdir(safeStoragePath(backupRoot, repository.id), { recursive: true });
      temporaryPath = safeStoragePath(
        backupRoot,
        repository.id,
        "download-" +
          backup.id.slice(0, 80) +
          "-" +
          randomUUID().slice(0, 12) +
          ".bundle"
      );
      await materializeKoshObject(indexed.locator, "", temporaryPath);
      path = temporaryPath;
    }

    const info = await stat(path).catch(() => null);
    if (!info) {
      json(response, 404, { error: "backup_file_missing" }, origin, allowedOrigins);
      return true;
    }
    const checksum = await hashFile(path);
    const expectedSha = clean(backup.payload.sha256, 128);
    const expectedSize = Number(backup.payload.sizeBytes) || 0;
    if (checksum !== expectedSha || info.size !== expectedSize) {
      await platformStore.updateResource(backup.id, {
        state: "invalid",
        payload: {
          ...backup.payload,
          lastVerifiedAt: new Date().toISOString(),
          verificationValid: false
        }
      }).catch(() => null);
      json(response, 409, { error: "backup_verification_failed" }, origin, allowedOrigins);
      return true;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "application/x-git-bundle");
    response.setHeader("content-length", String(info.size));
    response.setHeader(
      "content-disposition",
      'attachment; filename="' + filename.replace(/["\r\n]/g, "_") + '"'
    );
    response.setHeader("x-kosh-sha256", checksum);
    response.setHeader("etag", '"' + checksum + '"');
    response.setHeader("cache-control", "private, no-store");
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "origin");
    }
    await pipeline(createReadStream(path), response);
    return true;
  } catch (error) {
    json(
      response,
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status) || 500
        : 500,
      { error: error instanceof Error ? error.message : "backup_download_failed" },
      origin,
      allowedOrigins
    );
    return true;
  } finally {
    if (temporaryPath) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}
