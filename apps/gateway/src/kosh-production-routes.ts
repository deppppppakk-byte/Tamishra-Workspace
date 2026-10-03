import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import {
  getKoshMaintenanceStore,
  koshMaintenanceJobKinds,
  type KoshMaintenanceJobKind
} from "./kosh-maintenance-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import {
  executeKoshMaintenanceJob,
  getKoshProductionPolicy,
  putKoshProductionPolicy,
  scheduleKoshProductionMaintenance
} from "./kosh-production-jobs.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const maintenanceStore = getKoshMaintenanceStore();
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type JsonBody = Record<string, unknown>;

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

async function readJson(request: IncomingMessage, maxBytes = 128 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function requireAllowedOrigin(
  request: IncomingMessage,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (mutatingMethods.has(request.method ?? "") && origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

function bearer(request: IncomingMessage) {
  const value = request.headers.authorization?.trim() ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function safeEqual(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function maintenanceAuthorized(request: IncomingMessage) {
  const expected = process.env.KOSH_MAINTENANCE_TOKEN?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  return safeEqual(bearer(request), expected);
}

async function authorizeRepository(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository,
  permission: "repository.read" | "repository.manage",
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const authorization = await authorizeKoshRepositoryRequest(request, repository, permission);
  if (!authorization.identity || !authorization.decision.allowed) {
    sendJson(
      response,
      authorization.identity ? 403 : 401,
      { error: authorization.identity ? "repository_permission_denied" : "authentication_required" },
      origin,
      allowedOrigins
    );
    return null;
  }
  return authorization.identity;
}

function providerPosture() {
  return {
    maintenanceWorker: Boolean(process.env.KOSH_MAINTENANCE_TOKEN?.trim()),
    replicaFilesystem: Boolean(process.env.KOSH_REPLICA_ROOT?.trim()),
    databaseBackup: process.env.KOSH_DATABASE_BACKUP_ENABLED === "true",
    notificationDelivery: Boolean(process.env.KOSH_NOTIFICATION_DELIVERY_HOOK?.trim()),
    pagesDomainMaintenance: Boolean(process.env.KOSH_PAGES_DOMAIN_MAINTENANCE_HOOK?.trim()),
    extensionRuntime: Boolean(process.env.KOSH_EXTENSION_RUNTIME_HOOK?.trim())
  };
}

function validJobKind(value: unknown): value is KoshMaintenanceJobKind {
  return koshMaintenanceJobKinds.includes(String(value) as KoshMaintenanceJobKind);
}

async function repositoryProductionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/production(?:\/(policy|jobs))?$/
  );
  if (!match) return false;
  const repository = await repositoryStore.get(match[1], match[2]);
  if (!repository) {
    sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
    return true;
  }

  requireAllowedOrigin(request, origin, allowedOrigins);
  await Promise.all([maintenanceStore.ready(), platformStore.ready()]);
  const tail = match[3] ?? "";

  if (request.method === "GET" && !tail) {
    const identity = await authorizeRepository(
      request,
      response,
      repository,
      "repository.read",
      origin,
      allowedOrigins
    );
    if (!identity) return true;
    const [policy, jobs, storageEvidence] = await Promise.all([
      getKoshProductionPolicy(repository.id),
      maintenanceStore.list(repository.id, 100),
      platformStore.listResources("storage_policy", repository.id)
    ]);
    sendJson(response, 200, {
      repository: { id: repository.id, namespace: repository.namespace, slug: repository.slug },
      queue: { backend: maintenanceStore.kind, jobs },
      policy,
      providers: providerPosture(),
      evidence: storageEvidence.filter((item) =>
        ["reconciliation:evidence", "replication:evidence"].includes(item.key)
      )
    }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "PUT" && tail === "policy") {
    const identity = await authorizeRepository(
      request,
      response,
      repository,
      "repository.manage",
      origin,
      allowedOrigins
    );
    if (!identity) return true;
    const body = await readJson(request);
    const policy = await putKoshProductionPolicy(repository, identity.user, body);
    sendJson(response, 200, { policy }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET" && tail === "jobs") {
    const identity = await authorizeRepository(
      request,
      response,
      repository,
      "repository.read",
      origin,
      allowedOrigins
    );
    if (!identity) return true;
    sendJson(response, 200, { jobs: await maintenanceStore.list(repository.id, 300) }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "POST" && tail === "jobs") {
    const identity = await authorizeRepository(
      request,
      response,
      repository,
      "repository.manage",
      origin,
      allowedOrigins
    );
    if (!identity) return true;
    const body = await readJson(request);
    if (!validJobKind(body.kind) || body.kind === "database_backup") {
      sendJson(response, 400, { error: "invalid_repository_maintenance_job_kind" }, origin, allowedOrigins);
      return true;
    }
    if (
      body.kind === "storage_gc" &&
      clean(body.confirm, 200) !== repository.namespace + "/" + repository.slug
    ) {
      sendJson(response, 400, { error: "storage_gc_confirmation_mismatch" }, origin, allowedOrigins);
      return true;
    }
    const payload = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
      ? body.payload as Record<string, unknown>
      : {};
    const job = await maintenanceStore.enqueue({
      repositoryId: repository.id,
      kind: body.kind,
      priority: Number(body.priority) || 0,
      maxAttempts: Number(body.maxAttempts) || 3,
      payload,
      dedupeKey: clean(body.dedupeKey, 240) || `manual:${body.kind}:${repository.id}`
    });
    await platformStore.appendAudit({
      repositoryId: repository.id,
      actorUserId: identity.user.id,
      actorName: identity.user.displayName,
      eventType: "maintenance_job_enqueued",
      resourceType: "maintenance_job",
      resourceId: job.id,
      metadata: { kind: job.kind, priority: job.priority }
    });
    sendJson(response, 202, { job }, origin, allowedOrigins);
    return true;
  }

  sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
  return true;
}

async function workerRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/kosh/maintenance/")) return false;
  if (!maintenanceAuthorized(request)) {
    sendJson(response, 401, { error: "maintenance_worker_authentication_required" }, origin, allowedOrigins);
    return true;
  }
  await maintenanceStore.ready();

  if (request.method === "POST" && url.pathname === "/v1/kosh/maintenance/schedule") {
    sendJson(response, 200, await scheduleKoshProductionMaintenance(), origin, allowedOrigins);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/kosh/maintenance/claim") {
    const body = await readJson(request);
    const workerId = clean(body.workerId, 160);
    if (!workerId) {
      sendJson(response, 400, { error: "worker_id_required" }, origin, allowedOrigins);
      return true;
    }
    const job = await maintenanceStore.claim(workerId, Number(body.leaseSeconds) || 300);
    sendJson(response, 200, { job }, origin, allowedOrigins);
    return true;
  }

  const actionMatch = url.pathname.match(
    /^\/v1\/kosh\/maintenance\/jobs\/([0-9a-f-]{36})\/(heartbeat|execute|finish)$/
  );
  if (!actionMatch || request.method !== "POST") {
    sendJson(response, 404, { error: "maintenance_route_not_found" }, origin, allowedOrigins);
    return true;
  }
  const body = await readJson(request);
  const jobId = actionMatch[1];
  const action = actionMatch[2];
  const workerId = clean(body.workerId, 160);
  const leaseToken = clean(body.leaseToken, 512);
  if (!workerId || !leaseToken) {
    sendJson(response, 400, { error: "worker_lease_required" }, origin, allowedOrigins);
    return true;
  }

  if (action === "heartbeat") {
    const renewed = await maintenanceStore.heartbeat(
      jobId,
      workerId,
      leaseToken,
      Number(body.leaseSeconds) || 300
    );
    sendJson(response, renewed ? 200 : 409, { renewed }, origin, allowedOrigins);
    return true;
  }

  const leaseValid = await maintenanceStore.heartbeat(jobId, workerId, leaseToken, 600);
  if (!leaseValid) {
    sendJson(response, 409, { error: "maintenance_job_lease_invalid" }, origin, allowedOrigins);
    return true;
  }
  const job = await maintenanceStore.get(jobId);
  if (!job) {
    sendJson(response, 404, { error: "maintenance_job_not_found" }, origin, allowedOrigins);
    return true;
  }

  if (action === "finish") {
    const outcome = body.outcome === "succeeded" ? "succeeded" : "failed";
    const result = body.result && typeof body.result === "object" && !Array.isArray(body.result)
      ? body.result as Record<string, unknown>
      : null;
    const finished = await maintenanceStore.finish(
      jobId,
      workerId,
      leaseToken,
      outcome,
      result,
      clean(body.error, 4000) || null
    );
    sendJson(response, finished ? 200 : 409, { job: finished }, origin, allowedOrigins);
    return true;
  }

  try {
    const result = await executeKoshMaintenanceJob(job);
    const finished = await maintenanceStore.finish(
      jobId,
      workerId,
      leaseToken,
      "succeeded",
      result && typeof result === "object" && !Array.isArray(result)
        ? result as Record<string, unknown>
        : { result }
    );
    sendJson(response, 200, { job: finished, result }, origin, allowedOrigins);
  } catch (error) {
    const message = error instanceof Error ? error.message : "maintenance_job_failed";
    const finished = await maintenanceStore.finish(
      jobId,
      workerId,
      leaseToken,
      "failed",
      null,
      message
    );
    sendJson(response, 500, { error: message, job: finished }, origin, allowedOrigins);
  }
  return true;
}

export async function handleKoshProductionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  try {
    if (await workerRoute(request, response, url, origin, allowedOrigins)) return true;
    return await repositoryProductionRoute(request, response, url, origin, allowedOrigins);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "kosh_production_error" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
