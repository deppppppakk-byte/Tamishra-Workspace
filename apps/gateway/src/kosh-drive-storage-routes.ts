import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import {
  deleteKoshObject,
  koshObjectStorageBackend,
  putKoshObject,
  readKoshObject
} from "./kosh-object-storage.js";
import { getKoshPackageStore, type StoredKoshPackageVersion } from "./kosh-package-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshReleaseStore, type StoredKoshReleaseAsset } from "./kosh-release-store.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";
import { dispatchKoshWebhooks } from "./kosh-webhooks.js";

const packageStore = getKoshPackageStore();
const releaseStore = getKoshReleaseStore();
const platformStore = getKoshPlatformStore();
const repositoryStore = getKoshStore();
const objectIndex = getKoshObjectIndex();

type JsonBody = Record<string, unknown>;

type Actor = { id: string; displayName: string };

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function validPackageKey(value: string) {
  return value.length > 0 && value.length <= 120 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && !value.includes("..");
}

function validVersion(value: string) {
  return value.length > 0 && value.length <= 100 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._+~-]*$/.test(value);
}

function validChannel(value: string) {
  return value.length > 0 && value.length <= 80 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

function validTag(value: string) {
  return value.length > 0 && value.length <= 180 &&
    !/[\s~^:?*\[]/.test(value) && !value.includes("..") &&
    !value.includes("@{") && !value.startsWith("/") &&
    !value.endsWith("/") && !value.endsWith(".") &&
    !value.endsWith(".lock");
}

function safeFilename(value: string) {
  return value.length > 0 && value.length <= 220 &&
    !value.includes("/") && !value.includes("\\") &&
    value !== "." && value !== ".." && !value.includes("\0");
}

function maxPackageBytes() {
  const configured = Number(process.env.KOSH_PACKAGE_MAX_MB ?? 64);
  const mb = Number.isFinite(configured) ? Math.max(1, Math.min(1024, configured)) : 64;
  return Math.floor(mb * 1024 * 1024);
}

function maxReleaseAssetBytes() {
  const configured = Number(process.env.KOSH_RELEASE_ASSET_MAX_MB ?? 64);
  const mb = Number.isFinite(configured) ? Math.max(1, Math.min(2048, configured)) : 64;
  return Math.floor(mb * 1024 * 1024);
}

function allowedOrigins() {
  return new Set(
    (process.env.WORKSPACE_ALLOWED_ORIGINS ?? process.env.WORKSPACE_WEB_ORIGIN ?? "http://localhost:3000")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown, request: IncomingMessage) {
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

function requireAllowedOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    origin && !allowedOrigins().has(origin)
  ) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

async function readBuffer(request: IncomingMessage, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("storage_object_too_large"), { status: 413 });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<JsonBody> {
  const bytes = await readBuffer(request, maxBytes);
  if (!bytes.length) return {};
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

async function authorize(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository,
  permission: "repository.read" | "repository.write" | "packages.publish" | "releases.manage"
) {
  const result = await authorizeKoshRepositoryRequest(request, repository, permission);
  if (!result.decision.allowed) {
    sendJson(
      response,
      result.identity ? 403 : 401,
      {
        error: result.identity ? "repository_permission_denied" : "authentication_required",
        permission,
        role: result.decision.role
      },
      request
    );
    return null;
  }
  return result;
}

async function audit(
  repositoryId: string,
  actor: Actor,
  eventType: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown>
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType,
    resourceId,
    metadata
  });
}

async function driveObjectBytes(
  repositoryId: string,
  storageClass: "package" | "release",
  logicalId: string
) {
  const indexed = await objectIndex.get(repositoryId, storageClass, logicalId);
  if (!indexed || indexed.locator.backend !== "google-drive") return null;
  const bytes = await readKoshObject(indexed.locator, "");
  return { bytes, indexed };
}

function verifyBytes(bytes: Buffer, expectedSize: number, expectedSha256: string) {
  const checksum = sha256(bytes);
  if (bytes.length !== expectedSize || checksum !== expectedSha256) {
    throw Object.assign(new Error("storage_object_integrity_failure"), { status: 500 });
  }
  return checksum;
}

async function sendStoredObject(
  request: IncomingMessage,
  response: ServerResponse,
  filename: string,
  mediaType: string,
  bytes: Buffer,
  checksum: string
) {
  response.statusCode = 200;
  response.setHeader("content-type", mediaType);
  response.setHeader("content-length", String(bytes.length));
  response.setHeader(
    "content-disposition",
    'attachment; filename="' + filename.replace(/["\r\n]/g, "_") + '"'
  );
  response.setHeader("x-kosh-sha256", checksum);
  response.setHeader("etag", '"' + checksum + '"');
  response.setHeader("cache-control", "private, max-age=31536000, immutable");
  const origin = request.headers.origin;
  if (origin && allowedOrigins().has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(bytes);
}

function packageRequestMetadata(request: IncomingMessage, url: URL) {
  const header = (name: string) => {
    const value = request.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] ?? "" : String(value ?? "");
  };
  return {
    packageKey: clean(url.searchParams.get("key") || header("x-kosh-package-key"), 120),
    name: clean(url.searchParams.get("name") || header("x-kosh-package-name"), 180),
    version: clean(url.searchParams.get("version") || header("x-kosh-package-version"), 100),
    filename: clean(url.searchParams.get("filename") || header("x-kosh-package-filename"), 220),
    format: clean(url.searchParams.get("format") || header("x-kosh-package-format"), 80) || "generic",
    mediaType: clean(
      url.searchParams.get("mediaType") || header("x-kosh-package-media-type") || request.headers["content-type"],
      160
    ) || "application/octet-stream",
    channel: clean(url.searchParams.get("channel") || header("x-kosh-package-channel"), 80) || null,
    commitSha: clean(url.searchParams.get("commitSha") || header("x-kosh-commit-sha"), 64) || null,
    runId: clean(url.searchParams.get("runId") || header("x-kosh-run-id"), 240) || null
  };
}

async function publishDrivePackage(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository,
  url: URL,
  actor: Actor
) {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  let metadata = packageRequestMetadata(request, url);
  let bytes: Buffer;
  let extraMetadata: Record<string, unknown> = {};

  if (contentType.includes("application/json")) {
    const body = await readJson(
      request,
      Math.floor(maxPackageBytes() * 1.45) + 1024 * 1024
    );
    metadata = {
      packageKey: clean(body.key, 120),
      name: clean(body.name, 180),
      version: clean(body.version, 100),
      filename: clean(body.filename, 220),
      format: clean(body.format, 80) || "generic",
      mediaType: clean(body.mediaType, 160) || "application/octet-stream",
      channel: clean(body.channel, 80) || null,
      commitSha: clean(body.commitSha, 64) || null,
      runId: clean(body.runId, 240) || null
    };
    bytes = Buffer.from(String(body.base64 ?? ""), "base64");
    extraMetadata =
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata as Record<string, unknown>
        : {};
  } else {
    bytes = await readBuffer(request, maxPackageBytes());
  }

  if (
    !validPackageKey(metadata.packageKey) ||
    !validVersion(metadata.version) ||
    !safeFilename(metadata.filename)
  ) {
    throw Object.assign(new Error("invalid_package_identity"), { status: 400 });
  }
  if (!bytes.length || bytes.length > maxPackageBytes()) {
    throw Object.assign(new Error("package_size_invalid"), { status: 413 });
  }
  if (metadata.channel && !validChannel(metadata.channel)) {
    throw Object.assign(new Error("invalid_package_channel"), { status: 400 });
  }
  if (metadata.commitSha && !/^[0-9a-f]{40}$/i.test(metadata.commitSha)) {
    throw Object.assign(new Error("invalid_package_commit_sha"), { status: 400 });
  }

  const checksum = sha256(bytes);
  const versionId = randomUUID();
  const locator = await putKoshObject({
    storageClass: "package",
    repositoryId: repository.id,
    logicalId: versionId,
    filename: metadata.filename,
    mediaType: metadata.mediaType,
    bytes,
    sha256: checksum,
    localPath: ".kosh/packages/" + repository.id + "/" + versionId + "/" + metadata.filename
  });

  let version: StoredKoshPackageVersion | null = null;
  try {
    version = await packageStore.createVersion({
      id: versionId,
      repositoryId: repository.id,
      packageKey: metadata.packageKey,
      name: metadata.name || metadata.packageKey,
      version: metadata.version,
      filename: metadata.filename,
      format: metadata.format,
      mediaType: metadata.mediaType,
      sizeBytes: bytes.length,
      sha256: checksum,
      state: "published",
      commitSha: metadata.commitSha,
      runId: metadata.runId,
      provenance: {
        source: "google-drive",
        repositoryId: repository.id,
        namespace: repository.namespace,
        repository: repository.slug,
        commitSha: metadata.commitSha,
        runId: metadata.runId,
        sha256: checksum
      },
      metadata: {
        ...extraMetadata,
        storageBackend: "google-drive"
      },
      createdByUserId: actor.id,
      createdByName: actor.displayName
    });
    await objectIndex.put({
      repositoryId: repository.id,
      storageClass: "package",
      logicalId: version.id,
      locator
    });

    let channel = null;
    if (metadata.channel) {
      channel = await packageStore.putChannel({
        repositoryId: repository.id,
        packageKey: version.packageKey,
        channel: metadata.channel,
        versionId: version.id,
        version: version.version,
        updatedByUserId: actor.id,
        updatedByName: actor.displayName
      });
    }

    await audit(repository.id, actor, "package_published", "package", version.id, {
      packageKey: version.packageKey,
      version: version.version,
      filename: version.filename,
      format: version.format,
      sizeBytes: version.sizeBytes,
      sha256: version.sha256,
      storageBackend: "google-drive",
      channel: channel?.channel ?? null
    });
    void dispatchKoshWebhooks(repository.id, "package.published", {
      packageKey: version.packageKey,
      version: version.version,
      filename: version.filename,
      format: version.format,
      sizeBytes: version.sizeBytes,
      sha256: version.sha256,
      channel: channel?.channel ?? null,
      runId: version.runId,
      commitSha: version.commitSha,
      storageBackend: "google-drive"
    }).catch(() => undefined);

    sendJson(response, 201, { version, channel, storage: "google-drive" }, request);
    return true;
  } catch (error) {
    if (version) {
      await packageStore.deleteVersionForRollback(repository.id, version.id).catch(() => undefined);
      await objectIndex.delete(repository.id, "package", version.id).catch(() => undefined);
    }
    await deleteKoshObject(locator, "").catch(() => undefined);
    throw error;
  }
}

async function handlePackageRoute(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository,
  tail: string,
  url: URL
) {
  if (request.method === "POST" && (tail === "" || tail === "publish")) {
    requireAllowedOrigin(request);
    const auth = await authorize(request, response, repository, "packages.publish");
    if (!auth) return true;
    if (!auth.identity) {
      sendJson(response, 401, { error: "authentication_required" }, request);
      return true;
    }
    return publishDrivePackage(request, response, repository, url, {
      id: auth.identity.user.id,
      displayName: auth.identity.user.displayName
    });
  }

  const channelMatch = tail.match(/^([^/]+)\/channels\/([^/]+)(?:\/(download))?$/);
  if (channelMatch) {
    const packageKey = decodeURIComponent(channelMatch[1]);
    const channelName = decodeURIComponent(channelMatch[2]);
    if (!validPackageKey(packageKey) || !validChannel(channelName)) return false;
    const channel = await packageStore.getChannel(repository.id, packageKey, channelName);
    if (!channel) return false;
    const version = await packageStore.getVersionById(repository.id, channel.versionId);
    if (!version) return false;
    const stored = await driveObjectBytes(repository.id, "package", version.id);
    if (!stored) return false;

    if (request.method === "GET" && channelMatch[3] === "download") {
      const auth = await authorize(request, response, repository, "repository.read");
      if (!auth) return true;
      if (version.state === "yanked") {
        sendJson(response, 410, { error: "package_version_yanked" }, request);
        return true;
      }
      verifyBytes(stored.bytes, version.sizeBytes, version.sha256);
      await sendStoredObject(request, response, version.filename, version.mediaType, stored.bytes, version.sha256);
      return true;
    }

    if (request.method === "POST" || request.method === "PUT") {
      requireAllowedOrigin(request);
      const auth = await authorize(request, response, repository, "packages.publish");
      if (!auth) return true;
      if (!auth.identity) return false;
      const body = await readJson(request, 512 * 1024);
      const requestedVersion = await packageStore.getVersion(
        repository.id,
        packageKey,
        clean(body.version, 100)
      );
      if (!requestedVersion) {
        throw Object.assign(new Error("package_version_not_found"), { status: 404 });
      }
      const requestedStored = await driveObjectBytes(repository.id, "package", requestedVersion.id);
      if (!requestedStored) return false;
      if (requestedVersion.state !== "published") {
        throw Object.assign(new Error("package_version_not_promotable"), { status: 409 });
      }
      verifyBytes(requestedStored.bytes, requestedVersion.sizeBytes, requestedVersion.sha256);
      const promoted = await packageStore.putChannel({
        repositoryId: repository.id,
        packageKey,
        channel: channelName,
        versionId: requestedVersion.id,
        version: requestedVersion.version,
        updatedByUserId: auth.identity.user.id,
        updatedByName: auth.identity.user.displayName
      });
      await audit(
        repository.id,
        { id: auth.identity.user.id, displayName: auth.identity.user.displayName },
        "package_channel_promoted",
        "package",
        requestedVersion.id,
        { packageKey, channel: channelName, version: requestedVersion.version }
      );
      sendJson(response, 200, { channel: promoted, version: requestedVersion }, request);
      return true;
    }
  }

  const versionMatch = tail.match(/^([^/]+)\/versions\/([^/]+)(?:\/(download|verify))?$/);
  if (versionMatch && request.method === "GET" && versionMatch[3]) {
    const packageKey = decodeURIComponent(versionMatch[1]);
    const versionName = decodeURIComponent(versionMatch[2]);
    if (!validPackageKey(packageKey) || !validVersion(versionName)) return false;
    const version = await packageStore.getVersion(repository.id, packageKey, versionName);
    if (!version) return false;
    const stored = await driveObjectBytes(repository.id, "package", version.id);
    if (!stored) return false;
    const auth = await authorize(request, response, repository, "repository.read");
    if (!auth) return true;
    if (version.state === "yanked" && versionMatch[3] === "download") {
      sendJson(response, 410, { error: "package_version_yanked" }, request);
      return true;
    }
    const checksum = verifyBytes(stored.bytes, version.sizeBytes, version.sha256);
    if (versionMatch[3] === "verify") {
      sendJson(response, 200, {
        valid: true,
        sizeBytes: stored.bytes.length,
        sha256: checksum,
        expectedSha256: version.sha256,
        storage: "google-drive"
      }, request);
      return true;
    }
    await sendStoredObject(request, response, version.filename, version.mediaType, stored.bytes, checksum);
    return true;
  }

  return false;
}

async function handleReleaseRoute(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository,
  tail: string,
  url: URL
) {
  const releaseMatch = tail.match(/^([^/]+)\/assets(?:\/([^/]+))?(?:\/(verify))?$/);
  if (!releaseMatch) return false;
  const tag = decodeURIComponent(releaseMatch[1]);
  if (!validTag(tag)) return false;
  const release = await releaseStore.getRelease(repository.id, tag);
  if (!release) return false;

  if (request.method === "POST" && !releaseMatch[2]) {
    requireAllowedOrigin(request);
    const auth = await authorize(request, response, repository, "releases.manage");
    if (!auth) return true;
    if (!auth.identity) return false;
    if (release.state !== "draft") {
      throw Object.assign(new Error("release_immutable_after_publish"), { status: 409 });
    }

    const filename = clean(url.searchParams.get("filename"), 220);
    const mediaType = clean(
      url.searchParams.get("mediaType") || request.headers["content-type"],
      160
    ) || "application/octet-stream";
    if (!safeFilename(filename)) {
      throw Object.assign(new Error("release_asset_invalid"), { status: 400 });
    }
    const bytes = await readBuffer(request, maxReleaseAssetBytes());
    if (!bytes.length) {
      throw Object.assign(new Error("release_asset_invalid"), { status: 400 });
    }

    const checksum = sha256(bytes);
    const assetId = randomUUID();
    const locator = await putKoshObject({
      storageClass: "release",
      repositoryId: repository.id,
      logicalId: assetId,
      filename,
      mediaType,
      bytes,
      sha256: checksum,
      localPath: ".kosh/releases/" + repository.id + "/" + release.id + "/" + assetId + "/" + filename
    });

    let asset: StoredKoshReleaseAsset | null = null;
    try {
      asset = await releaseStore.createAsset({
        id: assetId,
        repositoryId: repository.id,
        releaseId: release.id,
        filename,
        mediaType,
        sizeBytes: bytes.length,
        sha256: checksum
      });
      await objectIndex.put({
        repositoryId: repository.id,
        storageClass: "release",
        logicalId: asset.id,
        locator
      });
      await audit(
        repository.id,
        { id: auth.identity.user.id, displayName: auth.identity.user.displayName },
        "release_asset_added",
        "release",
        release.id,
        {
          assetId: asset.id,
          filename: asset.filename,
          sizeBytes: asset.sizeBytes,
          sha256: asset.sha256,
          storageBackend: "google-drive"
        }
      );
      sendJson(response, 201, { ...asset, storage: "google-drive" }, request);
      return true;
    } catch (error) {
      if (asset) {
        await releaseStore.deleteAssetForRollback(release.id, asset.id).catch(() => undefined);
        await objectIndex.delete(repository.id, "release", asset.id).catch(() => undefined);
      }
      await deleteKoshObject(locator, "").catch(() => undefined);
      throw error;
    }
  }

  if (request.method === "GET" && releaseMatch[2]) {
    const assetId = decodeURIComponent(releaseMatch[2]);
    const asset = (await releaseStore.listAssets(release.id)).find((item) => item.id === assetId);
    if (!asset) return false;
    const stored = await driveObjectBytes(repository.id, "release", asset.id);
    if (!stored) return false;
    const auth = await authorize(request, response, repository, "repository.read");
    if (!auth) return true;
    const checksum = verifyBytes(stored.bytes, asset.sizeBytes, asset.sha256);
    if (releaseMatch[3] === "verify") {
      sendJson(response, 200, {
        valid: true,
        sizeBytes: stored.bytes.length,
        sha256: checksum,
        expectedSha256: asset.sha256,
        storage: "google-drive"
      }, request);
      return true;
    }
    await sendStoredObject(request, response, asset.filename, asset.mediaType, stored.bytes, checksum);
    return true;
  }

  return false;
}

export async function handleKoshDriveStorageRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  if (koshObjectStorageBackend() !== "google-drive") return false;
  if (!url.pathname.startsWith("/v1/kosh/repos/")) return false;

  await Promise.all([
    packageStore.ready(),
    releaseStore.ready(),
    platformStore.ready(),
    objectIndex.ready()
  ]);

  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/(packages|releases)(?:\/(.*))?$/
  );
  if (!match) return false;

  const repository = await repositoryStore.get(match[1], match[2]);
  if (!repository) return false;
  const area = match[3];
  const tail = match[4] ?? "";

  try {
    if (area === "packages") {
      return await handlePackageRoute(request, response, repository, tail, url);
    }
    return await handleReleaseRoute(request, response, repository, tail, url);
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status) || 500
        : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "kosh_drive_storage_error" },
      request
    );
    return true;
  }
}
