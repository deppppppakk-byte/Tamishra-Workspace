import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveWorkspaceIdentity } from "./identity.js";
import { createDocsWorkspaceStore } from "./docs-workspace-store.js";

type JsonObject = Record<string, unknown>;

const store = createDocsWorkspaceStore();
const MAX_BODY_BYTES = 12 * 1024 * 1024;

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

function mutationOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>
) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

export async function handleDocsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/docs")) return false;

  try {
    await store.ready();
  } catch (error) {
    console.error("Docs store initialization failed", error);
    sendJson(response, 503, { error: "docs_store_unavailable" }, origin, allowedOrigins);
    return true;
  }

  const identity = await resolveWorkspaceIdentity(request);
  if (!identity) {
    sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
    return true;
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    !mutationOriginAllowed(request, allowedOrigins)
  ) {
    sendJson(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/docs/workspace") {
    const stored = await store.get(identity.user.id);
    sendJson(
      response,
      200,
      {
        persistence: store.kind,
        revision: stored?.revision ?? 0,
        updatedAt: stored?.updatedAt ?? null,
        workspace: stored?.payload ?? {
          records: [],
          folders: [],
          versions: [],
          grants: [],
          comments: [],
          suggestions: []
        }
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "PUT" && url.pathname === "/v1/docs/workspace") {
    try {
      const body = await readJson(request);
      const workspace = body.workspace;
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
        throw Object.assign(new Error("invalid_workspace"), { status: 400 });
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
        workspace as JsonObject,
        revision
      );

      sendJson(
        response,
        200,
        {
          persistence: store.kind,
          revision: stored.revision,
          updatedAt: stored.updatedAt,
          workspace: stored.payload
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
          error: error instanceof Error ? error.message : "docs_workspace_save_failed",
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

  sendJson(response, 404, { error: "not_found" }, origin, allowedOrigins);
  return true;
}
