import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { deleteKoshObject } from "./kosh-object-storage.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { reconcileKoshStorage } from "./kosh-storage-reconciliation.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();

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

async function readJson(request: IncomingMessage, maxBytes = 64 * 1024) {
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
  if (!chunks.length) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_json");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export async function handleKoshStorageOrphanCleanupRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (request.method !== "POST") return false;
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/storage\/reconcile\/orphans\/delete$/
  );
  if (!match) return false;

  try {
    if (origin && !allowedOrigins.has(origin)) {
      throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
    }
    const repository = await repositoryStore.get(match[1], match[2]);
    if (!repository) {
      sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
      return true;
    }
    const authorization = await authorizeKoshRepositoryRequest(
      request,
      repository,
      "repository.manage"
    );
    if (!authorization.identity || !authorization.decision.allowed) {
      sendJson(
        response,
        authorization.identity ? 403 : 401,
        { error: authorization.identity ? "repository_permission_denied" : "authentication_required" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const body = await readJson(request);
    if (clean(body.confirm, 200) !== repository.namespace + "/" + repository.slug) {
      throw Object.assign(new Error("storage_cleanup_confirmation_mismatch"), { status: 400 });
    }
    const requestedIds = Array.isArray(body.objectIds)
      ? [...new Set(body.objectIds.map((item) => clean(item, 240)).filter(Boolean))].slice(0, 100)
      : [];
    if (!requestedIds.length) {
      throw Object.assign(new Error("orphan_object_ids_required"), { status: 400 });
    }

    const before = await reconcileKoshStorage(repository);
    const metadataReferencedRemoteIds = new Set(
      before.items
        .map((item) => item.remote?.id ?? "")
        .filter(Boolean)
    );
    const safeOrphans = new Map(
      before.orphanRemote
        .filter((item) => !metadataReferencedRemoteIds.has(item.id))
        .map((item) => [item.id, item])
    );

    const deleted: string[] = [];
    const skippedRecoverable: string[] = [];
    for (const id of requestedIds) {
      const remote = safeOrphans.get(id);
      if (!remote) {
        if (metadataReferencedRemoteIds.has(id)) skippedRecoverable.push(id);
        continue;
      }
      await deleteKoshObject(
        {
          backend: "google-drive",
          objectId: remote.id,
          storageClass: remote.storageClass,
          sizeBytes: remote.sizeBytes,
          sha256: remote.sha256
        },
        ""
      );
      deleted.push(id);
      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: authorization.identity.user.id,
        actorName: authorization.identity.user.displayName,
        eventType: "storage_orphan_deleted",
        resourceType: "storage_policy",
        resourceId: id,
        metadata: {
          storageClass: remote.storageClass,
          logicalId: remote.logicalId,
          sizeBytes: remote.sizeBytes,
          safetyRule: "not_referenced_by_live_metadata"
        }
      });
    }

    const after = await reconcileKoshStorage(repository);
    sendJson(
      response,
      200,
      {
        deleted,
        skippedRecoverable,
        safeOrphanCount: after.orphanRemote.filter(
          (item) => !after.items.some((candidate) => candidate.remote?.id === item.id)
        ).length,
        report: after
      },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "storage_orphan_cleanup_failed" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
