import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { enqueueKoshOpsJobWithPoolAdmission } from "./kosh-ops-pool-policy.js";
import {
  cancelKoshOpsJob,
  getKoshOpsJob,
  getKoshOpsQueueStats,
  listKoshOpsJobs,
  requeueKoshOpsJob,
  type KoshOpsJobType
} from "./kosh-ops-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const repositoryJobTypes = new Set<KoshOpsJobType>([
  "storage.lifecycle",
  "replication.verify",
  "recovery.drill",
  "alerts.evaluate",
  "notification.deliver",
  "pages.domain.verify",
  "extension.execute",
  "load.test",
  "secret.rotation.audit",
  "failure.probe"
]);
const platformJobTypes = new Set<KoshOpsJobType>([
  "alerts.evaluate",
  "notification.deliver",
  "database.backup",
  "secret.rotation.audit",
  "load.test",
  "failure.probe"
]);

type Identity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  allowedOrigins?: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins?.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes = 256 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(value);
  }
  if (!chunks.length) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json");
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function boundedPriority(value: unknown) {
  const parsed = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(parsed) ? Math.floor(parsed) : 50));
}

function requestIdempotencyKey(request: IncomingMessage, body: Record<string, unknown>) {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  return clean(value ?? body.idempotencyKey, 200) || null;
}

function platformAdministrator(identity: Identity) {
  const ids = new Set(
    (process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return ids.size > 0
    ? ids.has(identity.user.id)
    : process.env.NODE_ENV !== "production" &&
        identity.memberships.some((item) => ["owner", "admin"].includes(item.membership.role));
}

function requireOrigin(
  request: IncomingMessage,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (mutationMethods.has(request.method ?? "") && origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

function normalizeJobType(value: unknown, allowed: ReadonlySet<KoshOpsJobType>) {
  const type = clean(value, 80) as KoshOpsJobType;
  if (!allowed.has(type)) throw Object.assign(new Error("unsupported_operation_job_type"), { status: 400 });
  return type;
}

function safePayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {} as Record<string, unknown>;
  return value as Record<string, unknown>;
}

async function upsertSchedule(input: {
  repositoryId: string | null;
  namespace: string;
  key: string;
  name: string;
  jobType: KoshOpsJobType;
  jobPayload: Record<string, unknown>;
  intervalMinutes: number;
  priority: number;
  enabled: boolean;
  actor: Identity;
}) {
  await platformStore.ready();
  const schedules = await platformStore.listResources("admin_setting", input.repositoryId);
  const existing = schedules.find((item) => item.key === input.key);
  const nextRunAt = new Date(Date.now() + input.intervalMinutes * 60_000).toISOString();
  const payload = {
    kind: "ops_schedule",
    jobType: input.jobType,
    jobPayload: input.jobPayload,
    intervalMinutes: input.intervalMinutes,
    priority: input.priority,
    enabled: input.enabled,
    nextRunAt,
    lastEnqueuedAt: null,
    lastJobId: null
  };
  if (existing) {
    return platformStore.updateResource(existing.id, {
      name: input.name,
      state: input.enabled ? "active" : "disabled",
      payload: { ...existing.payload, ...payload }
    });
  }
  return platformStore.createResource({
    repositoryId: input.repositoryId,
    namespace: input.namespace,
    type: "admin_setting",
    key: input.key,
    name: input.name,
    state: input.enabled ? "active" : "disabled",
    payload,
    createdByUserId: input.actor.user.id,
    createdByName: input.actor.user.displayName
  });
}

async function handlePlatform(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(/^\/v1\/kosh\/systems\/operations(?:\/([^/]+))?$/);
  if (!match) return false;
  requireOrigin(request, origin, allowedOrigins);
  const identity = await resolveKoshIdentity(request);
  if (!identity || !platformAdministrator(identity)) {
    sendJson(response, identity ? 403 : 401, { error: identity ? "platform_admin_required" : "authentication_required" }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET" && !match[1]) {
    const [jobs, stats, schedules] = await Promise.all([
      listKoshOpsJobs(undefined, Number(url.searchParams.get("limit") ?? 100)),
      getKoshOpsQueueStats(undefined),
      platformStore.listResources("admin_setting", null)
    ]);
    sendJson(response, 200, {
      jobs,
      stats,
      schedules: schedules.filter((item) => item.payload.kind === "ops_schedule")
    }, origin, allowedOrigins);
    return true;
  }
  if (request.method === "POST" && match[1] === "cancel") {
    const body = await readJson(request);
    const id = clean(body.id, 100);
    sendJson(response, 200, { cancelled: id ? await cancelKoshOpsJob(id) : false }, origin, allowedOrigins);
    return true;
  }
  if (request.method === "POST" && match[1] === "requeue") {
    const body = await readJson(request);
    const id = clean(body.id, 100);
    sendJson(response, 200, { requeued: id ? await requeueKoshOpsJob(id) : false }, origin, allowedOrigins);
    return true;
  }
  if (request.method !== "POST" || match[1]) {
    sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  const body = await readJson(request);
  const type = normalizeJobType(body.type, platformJobTypes);
  if (body.schedule && typeof body.schedule === "object" && !Array.isArray(body.schedule)) {
    const schedule = body.schedule as Record<string, unknown>;
    const intervalMinutes = Math.max(5, Math.min(30 * 24 * 60, Math.floor(Number(schedule.intervalMinutes) || 60)));
    const key = `ops-schedule:${clean(schedule.key, 120) || type}`;
    const resource = await upsertSchedule({
      repositoryId: null,
      namespace: "system",
      key,
      name: clean(schedule.name, 180) || `Scheduled ${type}`,
      jobType: type,
      jobPayload: safePayload(body.payload),
      intervalMinutes,
      priority: boundedPriority(schedule.priority ?? body.priority),
      enabled: schedule.enabled !== false,
      actor: identity
    });
    sendJson(response, 201, { schedule: resource }, origin, allowedOrigins);
    return true;
  }

  const job = await enqueueKoshOpsJobWithPoolAdmission({
    type,
    payload: safePayload(body.payload),
    maxAttempts: Math.max(1, Math.min(10, Math.floor(Number(body.maxAttempts) || 3))),
    priority: boundedPriority(body.priority),
    idempotencyKey: requestIdempotencyKey(request, body),
    createdByUserId: identity.user.id,
    createdByName: identity.user.displayName
  });
  sendJson(response, 202, { job }, origin, allowedOrigins);
  return true;
}

async function handleRepository(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/operations(?:\/([^/]+))?$/
  );
  if (!match) return false;
  requireOrigin(request, origin, allowedOrigins);
  const repository = await repositoryStore.get(match[1], match[2]);
  if (!repository) {
    sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
    return true;
  }
  const permission = request.method === "GET" ? "repository.read" as const : "repository.manage" as const;
  const authorization = await authorizeKoshRepositoryRequest(request, repository, permission);
  if (!authorization.identity || !authorization.decision.allowed) {
    sendJson(response, authorization.identity ? 403 : 401, {
      error: authorization.identity ? "repository_permission_denied" : "authentication_required",
      permission
    }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET" && !match[3]) {
    const [jobs, stats, schedules] = await Promise.all([
      listKoshOpsJobs(repository.id, Number(url.searchParams.get("limit") ?? 100)),
      getKoshOpsQueueStats(repository.id),
      platformStore.listResources("admin_setting", repository.id)
    ]);
    sendJson(response, 200, {
      repository,
      jobs,
      stats,
      schedules: schedules.filter((item) => item.payload.kind === "ops_schedule")
    }, origin, allowedOrigins);
    return true;
  }
  if (request.method === "POST" && match[3] === "cancel") {
    const body = await readJson(request);
    const id = clean(body.id, 100);
    const target = id ? await getKoshOpsJob(id) : null;
    sendJson(response, 200, {
      cancelled: target?.repositoryId === repository.id ? await cancelKoshOpsJob(id) : false
    }, origin, allowedOrigins);
    return true;
  }
  if (request.method === "POST" && match[3] === "requeue") {
    const body = await readJson(request);
    const id = clean(body.id, 100);
    const target = id ? await getKoshOpsJob(id) : null;
    sendJson(response, 200, {
      requeued: target?.repositoryId === repository.id ? await requeueKoshOpsJob(id) : false
    }, origin, allowedOrigins);
    return true;
  }
  if (request.method !== "POST" || match[3]) {
    sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  const body = await readJson(request);
  const type = normalizeJobType(body.type, repositoryJobTypes);
  if (body.schedule && typeof body.schedule === "object" && !Array.isArray(body.schedule)) {
    const schedule = body.schedule as Record<string, unknown>;
    const intervalMinutes = Math.max(5, Math.min(30 * 24 * 60, Math.floor(Number(schedule.intervalMinutes) || 60)));
    const key = `ops-schedule:${clean(schedule.key, 120) || type}`;
    const resource = await upsertSchedule({
      repositoryId: repository.id,
      namespace: repository.namespace,
      key,
      name: clean(schedule.name, 180) || `Scheduled ${type}`,
      jobType: type,
      jobPayload: safePayload(body.payload),
      intervalMinutes,
      priority: boundedPriority(schedule.priority ?? body.priority),
      enabled: schedule.enabled !== false,
      actor: authorization.identity
    });
    sendJson(response, 201, { schedule: resource }, origin, allowedOrigins);
    return true;
  }

  const job = await enqueueKoshOpsJobWithPoolAdmission({
    repositoryId: repository.id,
    type,
    payload: safePayload(body.payload),
    maxAttempts: Math.max(1, Math.min(10, Math.floor(Number(body.maxAttempts) || 3))),
    priority: boundedPriority(body.priority),
    idempotencyKey: requestIdempotencyKey(request, body),
    createdByUserId: authorization.identity.user.id,
    createdByName: authorization.identity.user.displayName
  });
  sendJson(response, 202, { job }, origin, allowedOrigins);
  return true;
}

export async function handleKoshProductionOperationsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  try {
    if (await handlePlatform(request, response, url, origin, allowedOrigins)) return true;
    return await handleRepository(request, response, url, origin, allowedOrigins);
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    const retryAfterSeconds = typeof error === "object" && error && "retryAfterSeconds" in error
      ? Number((error as { retryAfterSeconds?: number }).retryAfterSeconds) || 0
      : 0;
    if (retryAfterSeconds > 0) response.setHeader("retry-after", String(retryAfterSeconds));
    sendJson(response, status, {
      error: error instanceof Error ? error.message : "operations_request_failed",
      ...(retryAfterSeconds > 0 ? { retryAfterSeconds } : {})
    }, origin, allowedOrigins);
    return true;
  }
}
