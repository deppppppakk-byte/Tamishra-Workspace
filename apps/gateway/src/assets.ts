import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveWorkspaceIdentity } from "./identity.js";
import { createBinaryAssetStore } from "./binary-assets-store.js";

type JsonObject = Record<string, unknown>;

const store = createBinaryAssetStore();
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const MAX_REQUEST_BYTES = 24 * 1024 * 1024;

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
    if (size > MAX_REQUEST_BYTES) {
      throw Object.assign(new Error("request_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function assetIdFromPath(pathname: string) {
  const match = pathname.match(/^\/v1\/assets\/([A-Za-z0-9_.:-]+)$/);
  return match?.[1] ?? null;
}

export async function handleAssetsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/assets/")) return false;

  const assetId = assetIdFromPath(url.pathname);
  if (!assetId) {
    sendJson(response, 404, { error: "not_found" }, origin, allowedOrigins);
    return true;
  }

  try {
    await store.ready();
  } catch (error) {
    console.error("Binary asset store initialization failed", error);
    sendJson(response, 503, { error: "asset_store_unavailable" }, origin, allowedOrigins);
    return true;
  }

  const identity = await resolveWorkspaceIdentity(request);
  if (!identity) {
    sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
    return true;
  }

  if (
    ["PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    request.headers.origin &&
    !allowedOrigins.has(request.headers.origin)
  ) {
    sendJson(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET") {
    const stored = await store.get(identity.user.id, assetId);
    if (!stored) {
      sendJson(response, 404, { error: "asset_not_found" }, origin, allowedOrigins);
      return true;
    }

    sendJson(
      response,
      200,
      {
        persistence: store.kind,
        asset: {
          id: stored.assetId,
          revision: stored.revision,
          name: stored.name,
          type: stored.mimeType,
          size: stored.sizeBytes,
          bytesBase64: stored.bytes.toString("base64"),
          metadata: stored.metadata,
          createdAt: stored.createdAt,
          updatedAt: stored.updatedAt
        }
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "PUT") {
    try {
      const body = await readJson(request);
      const name = String(body.name ?? "").trim();
      const mimeType = String(body.type ?? "").trim();
      const bytesBase64 = String(body.bytesBase64 ?? "");
      const metadata =
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata as JsonObject
          : {};
      const revision =
        body.revision === undefined || body.revision === null
          ? undefined
          : Number(body.revision);

      if (!name || !bytesBase64 || mimeType !== "application/pdf") {
        throw Object.assign(new Error("invalid_asset"), { status: 400 });
      }
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
        throw Object.assign(new Error("invalid_revision"), { status: 400 });
      }

      const bytes = Buffer.from(bytesBase64, "base64");
      if (!bytes.length || bytes.length > MAX_PDF_BYTES) {
        throw Object.assign(new Error("pdf_too_large"), { status: 413 });
      }

      const stored = await store.put(
        identity.user.id,
        assetId,
        { name, mimeType, bytes, metadata },
        revision
      );

      sendJson(
        response,
        200,
        {
          persistence: store.kind,
          asset: {
            id: stored.assetId,
            revision: stored.revision,
            name: stored.name,
            type: stored.mimeType,
            size: stored.sizeBytes,
            metadata: stored.metadata,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt
          }
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
          error: error instanceof Error ? error.message : "asset_save_failed",
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

  if (request.method === "PATCH") {
    try {
      const body = await readJson(request);
      const revision =
        body.revision === undefined || body.revision === null
          ? undefined
          : Number(body.revision);
      const metadata =
        body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata as JsonObject
          : null;

      if (!metadata) {
        throw Object.assign(new Error("invalid_metadata"), { status: 400 });
      }
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
        throw Object.assign(new Error("invalid_revision"), { status: 400 });
      }

      const current = await store.get(identity.user.id, assetId);
      if (!current) {
        throw Object.assign(new Error("asset_not_found"), { status: 404 });
      }

      const stored = await store.put(
        identity.user.id,
        assetId,
        {
          name: current.name,
          mimeType: current.mimeType,
          bytes: current.bytes,
          metadata
        },
        revision
      );

      sendJson(
        response,
        200,
        {
          persistence: store.kind,
          asset: {
            id: stored.assetId,
            revision: stored.revision,
            name: stored.name,
            type: stored.mimeType,
            size: stored.sizeBytes,
            metadata: stored.metadata,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt
          }
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
          error: error instanceof Error ? error.message : "asset_metadata_save_failed",
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

  if (request.method === "DELETE") {
    await store.delete(identity.user.id, assetId);
    sendJson(response, 200, { deleted: true }, origin, allowedOrigins);
    return true;
  }

  sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
  return true;
}
