import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshOpsWorkerFleetSummary } from "./kosh-ops-worker-registry.js";
import { getKoshOpsSchedulerLeadership } from "./kosh-ops-scheduler-leader.js";
import { getKoshOpsQueueStats } from "./kosh-ops-store.js";

type Identity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function platformAdministrator(identity: Identity) {
  const ids = new Set((process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "").split(",").map((v) => v.trim()).filter(Boolean));
  return ids.size > 0
    ? ids.has(identity.user.id)
    : process.env.NODE_ENV !== "production" && identity.memberships.some((item) => ["owner", "admin"].includes(item.membership.role));
}

function json(response: ServerResponse, status: number, body: unknown, origin: string | undefined, allowed: ReadonlySet<string>) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowed.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

function policy() {
  return {
    minWorkers: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_MIN_WORKERS, 1, 1, 1000),
    maxWorkers: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_MAX_WORKERS, 20, 1, 1000),
    targetQueuedPerSlot: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_TARGET_QUEUED_PER_SLOT, 2, 1, 100),
    assumedConcurrency: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_ASSUMED_CONCURRENCY, 2, 1, 64),
    scaleDownIdleSlots: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_SCALE_DOWN_IDLE_SLOTS, 4, 0, 1000)
  };
}

async function recommendation() {
  const [fleet, queueStats, scheduler] = await Promise.all([
    getKoshOpsWorkerFleetSummary(),
    getKoshOpsQueueStats(undefined),
    getKoshOpsSchedulerLeadership()
  ]);
  const config = policy();
  const queued = Number(queueStats.byState.queued ?? 0);
  const leased = Number(queueStats.byState.leased ?? 0);
  const effectiveConcurrency = fleet.online > 0
    ? Math.max(1, Math.round(fleet.totalConcurrency / fleet.online))
    : config.assumedConcurrency;
  const targetSlots = leased + Math.ceil(queued / config.targetQueuedPerSlot);
  const pressureWorkers = Math.ceil(targetSlots / effectiveConcurrency);
  let desiredWorkers = Math.max(config.minWorkers, Math.min(config.maxWorkers, pressureWorkers || config.minWorkers));
  let reason = queued > fleet.availableSlots ? "queue_pressure" : "steady";
  if (queued === 0 && fleet.availableSlots >= config.scaleDownIdleSlots) {
    desiredWorkers = Math.max(config.minWorkers, Math.min(desiredWorkers, Math.ceil(Math.max(leased, 1) / effectiveConcurrency)));
    reason = desiredWorkers < fleet.online ? "idle_capacity" : "steady";
  }
  if (fleet.online === 0) {
    desiredWorkers = Math.max(config.minWorkers, desiredWorkers);
    reason = "no_online_workers";
  }
  if (!scheduler.active) reason = "scheduler_leader_missing";
  return {
    checkedAt: new Date().toISOString(),
    currentWorkers: fleet.online,
    desiredWorkers,
    delta: desiredWorkers - fleet.online,
    reason,
    queue: {
      queued,
      leased,
      oldestQueuedAgeMs: queueStats.oldestQueuedAgeMs,
      retrying: queueStats.retrying,
      deadLettered: queueStats.deadLettered
    },
    fleet,
    scheduler,
    policy: config,
    scalerConfigured: Boolean(process.env.KOSH_OPS_SCALER_URL?.trim())
  };
}

async function readJson(request: IncomingMessage) {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > 16 * 1024) throw Object.assign(new Error("request_body_too_large"), { status: 413 });
  }
  if (!text.trim()) return {} as Record<string, unknown>;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json_body");
  return parsed as Record<string, unknown>;
}

export async function handleKoshOpsFleetControllerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (url.pathname !== "/v1/kosh/systems/workers/capacity") return false;
  if (!new Set(["GET", "POST"]).has(request.method ?? "")) return false;
  const identity = await resolveKoshIdentity(request);
  if (!identity || !platformAdministrator(identity)) {
    json(response, identity ? 403 : 401, { error: identity ? "platform_admin_required" : "authentication_required" }, origin, allowedOrigins);
    return true;
  }
  const current = await recommendation();
  if (request.method === "GET") {
    json(response, 200, current, origin, allowedOrigins);
    return true;
  }
  if (origin && !allowedOrigins.has(origin)) {
    json(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }
  const body = await readJson(request);
  if (body.apply !== true) {
    json(response, 400, { error: "explicit_apply_required", recommendation: current }, origin, allowedOrigins);
    return true;
  }
  const scalerUrl = process.env.KOSH_OPS_SCALER_URL?.trim();
  if (!scalerUrl) {
    json(response, 503, { error: "operations_scaler_not_configured", recommendation: current }, origin, allowedOrigins);
    return true;
  }
  const token = process.env.KOSH_OPS_SCALER_TOKEN?.trim();
  if (process.env.NODE_ENV === "production" && !token) {
    json(response, 503, { error: "operations_scaler_token_required", recommendation: current }, origin, allowedOrigins);
    return true;
  }
  const target = new URL(scalerUrl);
  if (target.protocol !== "https:" && process.env.NODE_ENV === "production") {
    json(response, 503, { error: "operations_scaler_https_required" }, origin, allowedOrigins);
    return true;
  }
  const upstream = await fetch(target, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      product: "Kosh",
      component: "operations-workers",
      desiredWorkers: current.desiredWorkers,
      currentWorkers: current.currentWorkers,
      reason: current.reason,
      checkedAt: current.checkedAt
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!upstream.ok) {
    json(response, 502, { error: "operations_scaler_rejected", status: upstream.status, recommendation: current }, origin, allowedOrigins);
    return true;
  }
  json(response, 202, { applied: true, recommendation: current }, origin, allowedOrigins);
  return true;
}
