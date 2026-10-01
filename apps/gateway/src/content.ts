import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveWorkspaceIdentity } from "./identity.js";
import { createWorkspaceContentStore } from "./content-state-store.js";

type JsonObject = Record<string, unknown>;

const store = createWorkspaceContentStore();
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const ALLOWED_NAMESPACES = new Set(["notes", "forms"]);

function sendJson(
  response: ServerResponse,
  status: number,
  body: JsonObject,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function namespaceFromPath(pathname: string) {
  const match = pathname.match(/^\/v1\/content\/([a-z0-9-]+)$/);
  return match?.[1] ?? null;
}

export async function handleContentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/content/")) return false;

  const namespace = namespaceFromPath(url.pathname);
  if (!namespace || !ALLOWED_NAMESPACES.has(namespace)) {
    sendJson(response, 404, { error: "not_found" }, origin, allowedOrigins);
    return true;
  }

  try {
    await store.ready();
  } catch (error) {
    console.error("Content store initialization failed", error);
    sendJson(response, 503, { error: "content_store_unavailable" }, origin, allowedOrigins);
    return true;
  }

  const identity = await resolveWorkspaceIdentity(request);
  if (!identity) {
    sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
    return true;
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    request.headers.origin &&
    !allowedOrigins.has(request.headers.origin)
  ) {
    sendJson(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET") {
    const stored = await store.get(identity.user.id, namespace);
    sendJson(
      response,
      200,
      {
        persistence: store.kind,
        revision: stored?.revision ?? 0,
        updatedAt: stored?.updatedAt ?? null,
        state: stored?.payload ?? {}
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "PUT") {
    try {
      const body = await readJson(request);
      const state = body.state;

      if (!state || typeof state !== "object" || Array.isArray(state)) {
        throw Object.assign(new Error("invalid_state"), { status: 400 });
      }

      const revision =
        body.revision === undefined || body.revision === null
          ? undefined
          : Number(body.revision);

      if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
        throw Object.assign(new Error("invalid_revision"), { status: 400 });
      }

      const stored = await store.put(
        identity.user.id,
        namespace,
        state as JsonObject,
        revision
      );

      sendJson(
        response,
        200,
        {
          persistence: store.kind,
          revision: stored.revision,
          updatedAt: stored.updatedAt,
          state: stored.payload
        },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      const status = Number((error as { status?: number }).status ?? 500);
      sendJson(
        response,
        status,
        {
          error: error instanceof Error ? error.message : "content_save_failed",
          currentRevision: Number(
            (error as { currentRevision?: number }).currentRevision ?? 0
          )
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
  return true;
}
