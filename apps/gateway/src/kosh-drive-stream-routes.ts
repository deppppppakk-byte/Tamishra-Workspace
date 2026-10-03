import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshPackageStore, type StoredKoshPackageVersion } from "./kosh-package-store.js";
import { getKoshReleaseStore, type StoredKoshReleaseAsset } from "./kosh-release-store.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";
import { materializeKoshObjectWithReplica } from "./kosh-storage-replica.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const packageStore = getKoshPackageStore();
const releaseStore = getKoshReleaseStore();
const objectIndex = getKoshObjectIndex();
const streamRoot = resolve(process.env.KOSH_STREAM_ROOT?.trim() || ".kosh/streams");

function safePath(root: string, ...parts: string[]) {
  const path = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (path !== root && !path.startsWith(prefix)) {
    throw Object.assign(new Error("stream_path_invalid"), { status: 400 });
  }
  return path;
}

function allowedOrigins() {
  return new Set(
    (process.env.WORKSPACE_ALLOWED_ORIGINS ?? process.env.WORKSPACE_WEB_ORIGIN ?? "http://localhost:3000")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function sendJson(request: IncomingMessage, response: ServerResponse, status: number, body: unknown) {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  const origin = request.headers.origin;
  if (origin && allowedOrigins().has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
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

async function authorize(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository
) {
  const result = await authorizeKoshRepositoryRequest(request, repository, "repository.read");
  if (!result.decision.allowed || !result.identity) {
    sendJson(
      request,
      response,
      result.identity ? 403 : 401,
      {
        error: result.identity ? "repository_permission_denied" : "authentication_required",
        permission: "repository.read",
        role: result.decision.role
      }
    );
    return false;
  }
  return true;
}

async function sendDriveFile(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    repositoryId: string;
    storageClass: "package" | "release";
    logicalId: string;
    filename: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
  }
) {
  const indexed = await objectIndex.get(input.repositoryId, input.storageClass, input.logicalId);
  if (!indexed || indexed.locator.backend !== "google-drive") return false;
  const directory = safePath(streamRoot, input.repositoryId, input.storageClass);
  const path = safePath(directory, randomUUID() + ".download");
  await mkdir(dirname(path), { recursive: true });
  try {
    const materialized = await materializeKoshObjectWithReplica({
      repositoryId: input.repositoryId,
      storageClass: input.storageClass,
      logicalId: input.logicalId,
      locator: indexed.locator,
      localFallbackPath: "",
      destinationPath: path,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256
    });
    const info = await stat(path);
    const checksum = await hashFile(path);
    if (info.size !== input.sizeBytes || checksum !== input.sha256) {
      sendJson(request, response, 409, { error: "storage_object_integrity_failure" });
      return true;
    }
    response.statusCode = 200;
    response.setHeader("content-type", input.mediaType || "application/octet-stream");
    response.setHeader("content-length", String(info.size));
    response.setHeader(
      "content-disposition",
      'attachment; filename="' + input.filename.replace(/["\r\n]/g, "_") + '"'
    );
    response.setHeader("x-kosh-sha256", checksum);
    response.setHeader("x-kosh-storage-source", materialized.source);
    response.setHeader("etag", '"' + checksum + '"');
    response.setHeader("cache-control", "private, max-age=31536000, immutable");
    const origin = request.headers.origin;
    if (origin && allowedOrigins().has(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "origin");
    }
    await pipeline(createReadStream(path), response);
    return true;
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

async function packageVersionFromRoute(
  repository: StoredKoshRepository,
  tail: string
): Promise<StoredKoshPackageVersion | null> {
  const channelMatch = tail.match(/^([^/]+)\/channels\/([^/]+)\/download$/);
  if (channelMatch) {
    const packageKey = decodeURIComponent(channelMatch[1]);
    const channelName = decodeURIComponent(channelMatch[2]);
    const channel = await packageStore.getChannel(repository.id, packageKey, channelName);
    if (!channel) return null;
    return packageStore.getVersionById(repository.id, channel.versionId);
  }
  const versionMatch = tail.match(/^([^/]+)\/versions\/([^/]+)\/download$/);
  if (!versionMatch) return null;
  return packageStore.getVersion(
    repository.id,
    decodeURIComponent(versionMatch[1]),
    decodeURIComponent(versionMatch[2])
  );
}

async function handlePackage(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository,
  tail: string
) {
  const version = await packageVersionFromRoute(repository, tail);
  if (!version) return false;
  const indexed = await objectIndex.get(repository.id, "package", version.id);
  if (!indexed || indexed.locator.backend !== "google-drive") return false;
  if (!(await authorize(request, response, repository))) return true;
  if (version.state === "yanked") {
    sendJson(request, response, 410, { error: "package_version_yanked" });
    return true;
  }
  return sendDriveFile(request, response, {
    repositoryId: repository.id,
    storageClass: "package",
    logicalId: version.id,
    filename: version.filename,
    mediaType: version.mediaType,
    sizeBytes: version.sizeBytes,
    sha256: version.sha256
  });
}

async function handleRelease(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository,
  tail: string
) {
  const match = tail.match(/^([^/]+)\/assets\/([^/]+)$/);
  if (!match) return false;
  const release = await releaseStore.getRelease(repository.id, decodeURIComponent(match[1]));
  if (!release) return false;
  const asset = (await releaseStore.listAssets(release.id)).find(
    (item: StoredKoshReleaseAsset) => item.id === decodeURIComponent(match[2])
  );
  if (!asset) return false;
  const indexed = await objectIndex.get(repository.id, "release", asset.id);
  if (!indexed || indexed.locator.backend !== "google-drive") return false;
  if (!(await authorize(request, response, repository))) return true;
  return sendDriveFile(request, response, {
    repositoryId: repository.id,
    storageClass: "release",
    logicalId: asset.id,
    filename: asset.filename,
    mediaType: asset.mediaType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256
  });
}

export async function handleKoshDriveStreamRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  if (request.method !== "GET") return false;
  await Promise.all([packageStore.ready(), releaseStore.ready(), objectIndex.ready()]);
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/(packages|releases)(?:\/(.*))?$/
  );
  if (!match) return false;
  const repository = await repositoryStore.get(match[1], match[2]);
  if (!repository) return false;
  const tail = match[4] ?? "";
  try {
    return match[3] === "packages"
      ? await handlePackage(request, response, repository, tail)
      : await handleRelease(request, response, repository, tail);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    sendJson(
      request,
      response,
      status,
      { error: error instanceof Error ? error.message : "drive_stream_failed" }
    );
    return true;
  }
}
