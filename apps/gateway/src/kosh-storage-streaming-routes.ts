import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { streamKoshObject } from "./kosh-object-storage.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";
import { getKoshPackageStore } from "./kosh-package-store.js";
import { getKoshReleaseStore } from "./kosh-release-store.js";
import { getKoshStore } from "./kosh-store.js";

const repositories = getKoshStore();
const packages = getKoshPackageStore();
const releases = getKoshReleaseStore();
const objectIndex = getKoshObjectIndex();

function allowedOrigins() {
  return new Set(
    (process.env.WORKSPACE_ALLOWED_ORIGINS ?? process.env.WORKSPACE_WEB_ORIGIN ?? "http://localhost:3000")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function applyCors(response: ServerResponse, request: IncomingMessage) {
  const origin = request.headers.origin;
  if (origin && allowedOrigins().has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
}

function json(request: IncomingMessage, response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  applyCors(response, request);
  response.end(JSON.stringify(body));
}

function safeAttachmentName(value: string) {
  return value.replace(/["\r\n]/g, "_");
}

async function authorizeRead(
  request: IncomingMessage,
  response: ServerResponse,
  repository: Awaited<ReturnType<typeof repositories.get>> extends infer T ? Exclude<T, null> : never
) {
  const result = await authorizeKoshRepositoryRequest(request, repository, "repository.read");
  if (!result.decision.allowed) {
    json(request, response, result.identity ? 403 : 401, {
      error: result.identity ? "repository_permission_denied" : "authentication_required",
      permission: "repository.read",
      role: result.decision.role
    });
    return false;
  }
  return true;
}

async function sendObject(
  request: IncomingMessage,
  response: ServerResponse,
  input: {
    filename: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
    locator: NonNullable<Awaited<ReturnType<typeof objectIndex.get>>>["locator"];
  }
) {
  response.statusCode = 200;
  response.setHeader("content-type", input.mediaType || "application/octet-stream");
  response.setHeader("content-length", String(input.sizeBytes));
  response.setHeader("content-disposition", `attachment; filename="${safeAttachmentName(input.filename)}"`);
  response.setHeader("x-kosh-sha256", input.sha256);
  response.setHeader("etag", `"${input.sha256}"`);
  response.setHeader("cache-control", "private, max-age=31536000, immutable");
  response.setHeader("x-content-type-options", "nosniff");
  applyCors(response, request);
  try {
    const streamed = await streamKoshObject(input.locator, "", response);
    if (!response.headersSent) response.setHeader("x-kosh-storage-source", streamed.source);
  } catch (error) {
    if (!response.headersSent) {
      json(request, response, 503, {
        error: error instanceof Error ? error.message : "storage_stream_failed"
      });
    } else {
      response.destroy(error instanceof Error ? error : new Error("storage_stream_failed"));
    }
  }
}

async function handlePackage(
  request: IncomingMessage,
  response: ServerResponse,
  repository: Exclude<Awaited<ReturnType<typeof repositories.get>>, null>,
  tail: string
) {
  const versionMatch = tail.match(/^([^/]+)\/versions\/([^/]+)\/download$/);
  if (versionMatch) {
    const packageKey = decodeURIComponent(versionMatch[1]);
    const versionName = decodeURIComponent(versionMatch[2]);
    const version = await packages.getVersion(repository.id, packageKey, versionName);
    if (!version) return false;
    const indexed = await objectIndex.get(repository.id, "package", version.id);
    if (!indexed) return false;
    if (!(await authorizeRead(request, response, repository))) return true;
    if (version.state === "yanked") {
      json(request, response, 410, { error: "package_version_yanked" });
      return true;
    }
    await sendObject(request, response, {
      filename: version.filename,
      mediaType: version.mediaType,
      sizeBytes: version.sizeBytes,
      sha256: version.sha256,
      locator: indexed.locator
    });
    return true;
  }

  const channelMatch = tail.match(/^([^/]+)\/channels\/([^/]+)\/download$/);
  if (!channelMatch) return false;
  const packageKey = decodeURIComponent(channelMatch[1]);
  const channelName = decodeURIComponent(channelMatch[2]);
  const channel = await packages.getChannel(repository.id, packageKey, channelName);
  if (!channel) return false;
  const version = await packages.getVersionById(repository.id, channel.versionId);
  if (!version) return false;
  const indexed = await objectIndex.get(repository.id, "package", version.id);
  if (!indexed) return false;
  if (!(await authorizeRead(request, response, repository))) return true;
  if (version.state === "yanked") {
    json(request, response, 410, { error: "package_version_yanked" });
    return true;
  }
  await sendObject(request, response, {
    filename: version.filename,
    mediaType: version.mediaType,
    sizeBytes: version.sizeBytes,
    sha256: version.sha256,
    locator: indexed.locator
  });
  return true;
}

async function handleRelease(
  request: IncomingMessage,
  response: ServerResponse,
  repository: Exclude<Awaited<ReturnType<typeof repositories.get>>, null>,
  tail: string
) {
  const match = tail.match(/^([^/]+)\/assets\/([^/]+)$/);
  if (!match) return false;
  const tag = decodeURIComponent(match[1]);
  const assetId = decodeURIComponent(match[2]);
  const release = await releases.getRelease(repository.id, tag);
  if (!release) return false;
  const asset = (await releases.listAssets(release.id)).find((item) => item.id === assetId);
  if (!asset) return false;
  const indexed = await objectIndex.get(repository.id, "release", asset.id);
  if (!indexed) return false;
  if (!(await authorizeRead(request, response, repository))) return true;
  await sendObject(request, response, {
    filename: asset.filename,
    mediaType: asset.mediaType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    locator: indexed.locator
  });
  return true;
}

export async function handleKoshStorageStreamingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  if (request.method !== "GET") return false;
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/(packages|releases)\/(.*)$/
  );
  if (!match) return false;
  await Promise.all([packages.ready(), releases.ready(), objectIndex.ready()]);
  const repository = await repositories.get(match[1], match[2]);
  if (!repository) return false;
  return match[3] === "packages"
    ? handlePackage(request, response, repository, match[4])
    : handleRelease(request, response, repository, match[4]);
}
