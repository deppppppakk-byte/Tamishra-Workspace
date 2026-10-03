import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { readKoshObject } from "./kosh-object-storage.js";
import { getKoshPackageStore } from "./kosh-package-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const packageStore = getKoshPackageStore();
const platformStore = getKoshPlatformStore();
const objectIndex = getKoshObjectIndex();

type JsonBody = Record<string, unknown>;

function allowedOrigins() {
  return new Set(
    (
      process.env.WORKSPACE_ALLOWED_ORIGINS ??
      process.env.WORKSPACE_WEB_ORIGIN ??
      "http://localhost:3000"
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown
) {
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

async function readJson(
  request: IncomingMessage,
  maxBytes = 512 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonBody)
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function validPackageKey(value: string) {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    !value.includes("..")
  );
}

function validChannel(value: string) {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
  );
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function handleKoshDriveChannelRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  if (request.method !== "POST" && request.method !== "PUT") return false;

  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/packages\/([^/]+)\/channels\/([^/]+)\/?$/
  );
  if (!match) return false;

  const origin = request.headers.origin;
  if (origin && !allowedOrigins().has(origin)) {
    sendJson(request, response, 403, { error: "origin_not_allowed" });
    return true;
  }

  const repository = await repositoryStore.get(match[1], match[2]);
  if (!repository) return false;

  const packageKey = decodeURIComponent(match[3]);
  const channelName = decodeURIComponent(match[4]);
  if (!validPackageKey(packageKey) || !validChannel(channelName)) {
    sendJson(request, response, 400, { error: "invalid_package_channel" });
    return true;
  }

  const authorization = await authorizeKoshRepositoryRequest(
    request,
    repository,
    "packages.publish"
  );
  if (!authorization.decision.allowed || !authorization.identity) {
    sendJson(
      request,
      response,
      authorization.identity ? 403 : 401,
      {
        error: authorization.identity
          ? "repository_permission_denied"
          : "authentication_required",
        permission: "packages.publish",
        role: authorization.decision.role
      }
    );
    return true;
  }

  try {
    await Promise.all([
      packageStore.ready(),
      platformStore.ready(),
      objectIndex.ready()
    ]);

    const body = await readJson(request);
    const versionName = clean(body.version, 100);
    const version = await packageStore.getVersion(
      repository.id,
      packageKey,
      versionName
    );
    if (!version) return false;

    const stored = await objectIndex.get(
      repository.id,
      "package",
      version.id
    );
    if (!stored || stored.locator.backend !== "google-drive") return false;

    if (version.state !== "published") {
      sendJson(request, response, 409, {
        error: "package_version_not_promotable"
      });
      return true;
    }

    const bytes = await readKoshObject(stored.locator, "");
    const checksum = sha256(bytes);
    if (bytes.length !== version.sizeBytes || checksum !== version.sha256) {
      sendJson(request, response, 500, {
        error: "package_integrity_failure"
      });
      return true;
    }

    const channel = await packageStore.putChannel({
      repositoryId: repository.id,
      packageKey,
      channel: channelName,
      versionId: version.id,
      version: version.version,
      updatedByUserId: authorization.identity.user.id,
      updatedByName: authorization.identity.user.displayName
    });

    await platformStore.appendAudit({
      repositoryId: repository.id,
      actorUserId: authorization.identity.user.id,
      actorName: authorization.identity.user.displayName,
      eventType: "package_channel_promoted",
      resourceType: "package",
      resourceId: version.id,
      metadata: {
        packageKey,
        channel: channelName,
        version: version.version,
        storageBackend: "google-drive"
      }
    });

    sendJson(request, response, 200, {
      channel,
      version,
      storage: "google-drive"
    });
    return true;
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status) || 500
        : 500;
    sendJson(request, response, status, {
      error:
        error instanceof Error
          ? error.message
          : "kosh_drive_channel_error"
    });
    return true;
  }
}
