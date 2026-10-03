import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const repositories = getKoshStore();
const platformStore = getKoshPlatformStore();

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
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

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 256 * 1024) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(bytes);
  }
  if (!chunks.length) return {} as Record<string, unknown>;
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

export async function handleKoshSecretRotationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/secrets\/rotate$/
  );
  if (!match) return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
    return true;
  }
  try {
    if (origin && !allowedOrigins.has(origin)) {
      throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
    }
    const repository = await repositories.get(match[1], match[2]);
    if (!repository) {
      sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
      return true;
    }
    const auth = await authorizeKoshRepositoryRequest(request, repository, "repository.manage");
    if (!auth.identity || !auth.decision.allowed) {
      sendJson(response, auth.identity ? 403 : 401, {
        error: auth.identity ? "repository_permission_denied" : "authentication_required",
        permission: "repository.manage"
      }, origin, allowedOrigins);
      return true;
    }
    if (auth.identity.authType !== "session") {
      sendJson(response, 403, { error: "interactive_session_required" }, origin, allowedOrigins);
      return true;
    }

    const body = await readJson(request);
    const name = clean(body.name, 160);
    const environmentName = clean(body.environmentName, 160) || null;
    const value = String(body.value ?? "");
    if (!name || value.length < 16 || value.length > 128 * 1024) {
      throw Object.assign(new Error("invalid_secret_rotation_payload"), { status: 400 });
    }

    await platformStore.ready();
    const existing = (await platformStore.listSecrets(repository.id)).find(
      (item) => item.name === name && item.environmentName === environmentName
    );
    const previousUpdatedAt = existing?.updatedAt ?? null;
    const rotated = await platformStore.putSecret({
      repositoryId: repository.id,
      environmentName,
      name,
      value,
      createdByUserId: auth.identity.user.id,
      createdByName: auth.identity.user.displayName
    });
    await platformStore.appendAudit({
      repositoryId: repository.id,
      actorUserId: auth.identity.user.id,
      actorName: auth.identity.user.displayName,
      eventType: existing ? "secret_rotated" : "secret_created",
      resourceType: "secret",
      resourceId: rotated.id,
      metadata: {
        name,
        environmentName,
        previousUpdatedAt,
        rotatedAt: rotated.updatedAt,
        valueReturned: false
      }
    });
    sendJson(response, 200, {
      secret: rotated,
      rotated: Boolean(existing),
      valueReturned: false
    }, origin, allowedOrigins);
    return true;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    sendJson(response, status, {
      error: error instanceof Error ? error.message : "secret_rotation_failed"
    }, origin, allowedOrigins);
    return true;
  }
}
