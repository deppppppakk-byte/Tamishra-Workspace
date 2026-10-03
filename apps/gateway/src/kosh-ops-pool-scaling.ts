import postgres from "postgres";
import {
  koshOpsPoolJobTypes,
  type KoshOpsWorkerPool
} from "./kosh-ops-pool-claim.js";
import { koshOpsPoolPolicy } from "./kosh-ops-pool-policy.js";
import {
  listKoshOpsJobs,
  type KoshOpsJob,
  type KoshOpsJobType
} from "./kosh-ops-store.js";
import {
  listKoshOpsWorkers,
  type KoshOpsWorkerRecord
} from "./kosh-ops-worker-registry.js";

export type KoshOpsDedicatedPool = Exclude<KoshOpsWorkerPool, "all">;

export const koshOpsDedicatedPools: readonly KoshOpsDedicatedPool[] = [
  "general",
  "storage",
  "recovery",
  "database",
  "isolated"
];

type PoolScalingState = {
  pool: KoshOpsDedicatedPool;
  lastAppliedAt: string | null;
  lastDesiredWorkers: number | null;
  lastReason: string | null;
  idleSince: string | null;
  lastPressureAt: string | null;
  updatedAt: string | null;
};

type PoolQueueStats = {
  queued: number;
  leased: number;
  failed: number;
  retrying: number;
  deadLettered: number;
  oldestQueuedAgeMs: number;
};

let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;
const memoryState = new Map<KoshOpsDedicatedPool, PoolScalingState>();

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 2, prepare: false });
  return sql;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function timestamp(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function defaultState(pool: KoshOpsDedicatedPool): PoolScalingState {
  return {
    pool,
    lastAppliedAt: null,
    lastDesiredWorkers: null,
    lastReason: null,
    idleSince: null,
    lastPressureAt: null,
    updatedAt: null
  };
}

function stateFromRow(pool: KoshOpsDedicatedPool, row?: Record<string, unknown>): PoolScalingState {
  if (!row) return memoryState.get(pool) ?? defaultState(pool);
  return {
    pool,
    lastAppliedAt: timestamp(row.last_applied_at),
    lastDesiredWorkers: row.last_desired_workers == null ? null : Number(row.last_desired_workers),
    lastReason: row.last_reason == null ? null : String(row.last_reason),
    idleSince: timestamp(row.idle_since),
    lastPressureAt: timestamp(row.last_pressure_at),
    updatedAt: timestamp(row.updated_at)
  };
}

async function readyPoolScalingState() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_ops_pool_scaling_state (
    pool TEXT PRIMARY KEY,
    last_applied_at TIMESTAMPTZ NULL,
    last_desired_workers INTEGER NULL,
    last_reason TEXT NULL,
    idle_since TIMESTAMPTZ NULL,
    last_pressure_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK(pool IN ('general','storage','recovery','database','isolated'))
  )`;
  for (const pool of koshOpsDedicatedPools) {
    await db`INSERT INTO kosh_ops_pool_scaling_state(pool)
      VALUES(${pool}) ON CONFLICT(pool) DO NOTHING`;
  }
  initialized = true;
}

async function getPoolScalingState(pool: KoshOpsDedicatedPool) {
  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_pool_scaling_state_requires_database"), { status: 503 });
    }
    return memoryState.get(pool) ?? defaultState(pool);
  }
  await readyPoolScalingState();
  const rows = await db`SELECT * FROM kosh_ops_pool_scaling_state WHERE pool = ${pool}`;
  return stateFromRow(pool, rows[0] as Record<string, unknown> | undefined);
}

async function updatePoolScalingState(
  pool: KoshOpsDedicatedPool,
  input: {
    desiredWorkers?: number | null;
    reason?: string | null;
    applied?: boolean;
    pressure?: boolean;
    idle?: boolean;
  }
) {
  const now = new Date().toISOString();
  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_pool_scaling_state_requires_database"), { status: 503 });
    }
    const previous = memoryState.get(pool) ?? defaultState(pool);
    const next: PoolScalingState = {
      ...previous,
      lastAppliedAt: input.applied ? now : previous.lastAppliedAt,
      lastDesiredWorkers: input.desiredWorkers ?? previous.lastDesiredWorkers,
      lastReason: input.reason ?? previous.lastReason,
      idleSince: input.idle ? (previous.idleSince ?? now) : null,
      lastPressureAt: input.pressure ? now : previous.lastPressureAt,
      updatedAt: now
    };
    memoryState.set(pool, next);
    return next;
  }
  await readyPoolScalingState();
  const rows = await db`UPDATE kosh_ops_pool_scaling_state SET
    last_applied_at = CASE WHEN ${Boolean(input.applied)} THEN NOW() ELSE last_applied_at END,
    last_desired_workers = COALESCE(${input.desiredWorkers ?? null}, last_desired_workers),
    last_reason = COALESCE(${input.reason ?? null}, last_reason),
    idle_since = CASE WHEN ${Boolean(input.idle)} THEN COALESCE(idle_since, NOW()) ELSE NULL END,
    last_pressure_at = CASE WHEN ${Boolean(input.pressure)} THEN NOW() ELSE last_pressure_at END,
    updated_at = NOW()
    WHERE pool = ${pool}
    RETURNING *`;
  return stateFromRow(pool, rows[0] as Record<string, unknown> | undefined);
}

function poolEnv(pool: KoshOpsDedicatedPool, suffix: string) {
  return process.env[`KOSH_OPS_AUTOSCALE_${pool.toUpperCase()}_${suffix}`];
}

function poolDefaults(pool: KoshOpsDedicatedPool) {
  if (pool === "general") return { min: 1, max: 20 };
  if (pool === "storage") return { min: 0, max: 8 };
  if (pool === "recovery") return { min: 0, max: 4 };
  if (pool === "database") return { min: 0, max: 4 };
  return { min: 0, max: 4 };
}

export function koshOpsPoolAutoscalePolicy(pool: KoshOpsDedicatedPool) {
  const defaults = poolDefaults(pool);
  return {
    enabled: process.env.KOSH_OPS_POOL_AUTOSCALE_ENABLED === "true" &&
      poolEnv(pool, "ENABLED") !== "false",
    minWorkers: boundedInteger(poolEnv(pool, "MIN_WORKERS"), defaults.min, 0, 1000),
    maxWorkers: boundedInteger(poolEnv(pool, "MAX_WORKERS"), defaults.max, 1, 1000),
    targetQueuedPerSlot: boundedInteger(
      poolEnv(pool, "TARGET_QUEUED_PER_SLOT") ?? process.env.KOSH_OPS_AUTOSCALE_TARGET_QUEUED_PER_SLOT,
      2,
      1,
      100
    ),
    assumedConcurrency: boundedInteger(
      poolEnv(pool, "ASSUMED_CONCURRENCY") ?? process.env.KOSH_OPS_AUTOSCALE_ASSUMED_CONCURRENCY,
      2,
      1,
      64
    ),
    scaleDownIdleSlots: boundedInteger(
      poolEnv(pool, "SCALE_DOWN_IDLE_SLOTS") ?? process.env.KOSH_OPS_AUTOSCALE_SCALE_DOWN_IDLE_SLOTS,
      2,
      0,
      1000
    ),
    cooldownMs: boundedInteger(
      poolEnv(pool, "COOLDOWN_SECONDS") ?? process.env.KOSH_OPS_AUTOSCALE_COOLDOWN_SECONDS,
      180,
      30,
      3600
    ) * 1000,
    scaleDownStabilizationMs: boundedInteger(
      poolEnv(pool, "SCALE_DOWN_STABILIZATION_SECONDS") ?? process.env.KOSH_OPS_AUTOSCALE_SCALE_DOWN_STABILIZATION_SECONDS,
      600,
      60,
      86_400
    ) * 1000
  };
}

function inferWorkerPool(worker: KoshOpsWorkerRecord): KoshOpsWorkerPool {
  const match = worker.releaseVersion.match(/(?:^|;)pool=(all|general|storage|recovery|database|isolated)(?:;|$)/);
  if (match) return match[1] as KoshOpsWorkerPool;
  const prefix = worker.workerId.split(":", 1)[0];
  return (["general", "storage", "recovery", "database", "isolated"] as const).includes(
    prefix as KoshOpsDedicatedPool
  ) ? prefix as KoshOpsDedicatedPool : "all";
}

function effectiveConcurrency(worker: KoshOpsWorkerRecord) {
  return Math.min(worker.concurrency, worker.desiredConcurrency ?? worker.concurrency);
}

async function fleetStats(pool: KoshOpsDedicatedPool) {
  const workers = await listKoshOpsWorkers(1000);
  const online = workers.filter((worker) => worker.status === "online");
  const dedicated = online.filter(
    (worker) => worker.requestedState === "active" && inferWorkerPool(worker) === pool
  );
  const fallbackAll = online.filter(
    (worker) => worker.requestedState === "active" && inferWorkerPool(worker) === "all"
  );
  return {
    currentWorkers: dedicated.length,
    totalConcurrency: dedicated.reduce((sum, worker) => sum + effectiveConcurrency(worker), 0),
    activeJobs: dedicated.reduce((sum, worker) => sum + worker.activeJobs, 0),
    availableSlots: dedicated.reduce(
      (sum, worker) => sum + Math.max(0, effectiveConcurrency(worker) - worker.activeJobs),
      0
    ),
    fallbackAllWorkers: fallbackAll.length,
    fallbackAllAvailableSlots: fallbackAll.reduce(
      (sum, worker) => sum + Math.max(0, effectiveConcurrency(worker) - worker.activeJobs),
      0
    )
  };
}

function queueStatsFromItems(pool: KoshOpsDedicatedPool, items: KoshOpsJob[]): PoolQueueStats {
  const types = new Set<KoshOpsJobType>(koshOpsPoolJobTypes[pool]);
  const scoped = items.filter((item) => types.has(item.type));
  const queued = scoped.filter((item) => item.state === "queued");
  const now = Date.now();
  const oldest = queued.reduce(
    (value, item) => Math.min(value, new Date(item.createdAt).getTime()),
    now
  );
  return {
    queued: queued.length,
    leased: scoped.filter((item) => item.state === "leased").length,
    failed: scoped.filter((item) => item.state === "failed").length,
    retrying: queued.filter((item) => item.attempt > 0).length,
    deadLettered: scoped.filter((item) => item.deadLetteredAt).length,
    oldestQueuedAgeMs: queued.length ? Math.max(0, now - oldest) : 0
  };
}

async function productionQueueStats(pool: KoshOpsDedicatedPool): Promise<PoolQueueStats> {
  const db = database();
  if (!db) {
    return queueStatsFromItems(pool, await listKoshOpsJobs(undefined, 1000));
  }
  await readyPoolScalingState();
  let rows;
  if (pool === "general") {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
      COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
      COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
      FROM kosh_ops_jobs WHERE type IN ('alerts.evaluate','notification.deliver','pages.domain.verify','secret.rotation.audit')`;
  } else if (pool === "storage") {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
      COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
      COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
      FROM kosh_ops_jobs WHERE type IN ('storage.lifecycle','replication.verify')`;
  } else if (pool === "recovery") {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
      COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
      COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
      FROM kosh_ops_jobs WHERE type = 'recovery.drill'`;
  } else if (pool === "database") {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
      COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
      COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
      FROM kosh_ops_jobs WHERE type = 'database.backup'`;
  } else {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
      COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
      COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
      FROM kosh_ops_jobs WHERE type IN ('extension.execute','load.test','failure.probe')`;
  }
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    queued: Number(row.queued ?? 0),
    leased: Number(row.leased ?? 0),
    failed: Number(row.failed ?? 0),
    retrying: Number(row.retrying ?? 0),
    deadLettered: Number(row.dead_lettered ?? 0),
    oldestQueuedAgeMs: Math.max(0, Number(row.oldest_queued_ms ?? 0))
  };
}

export async function getKoshOpsPoolRecommendation(pool: KoshOpsDedicatedPool) {
  const [fleet, queue, scalingState] = await Promise.all([
    fleetStats(pool),
    productionQueueStats(pool),
    getPoolScalingState(pool)
  ]);
  const policy = koshOpsPoolAutoscalePolicy(pool);
  const sloPolicy = koshOpsPoolPolicy(pool);
  const effectiveConcurrency = fleet.currentWorkers > 0
    ? Math.max(1, Math.round(fleet.totalConcurrency / fleet.currentWorkers))
    : policy.assumedConcurrency;
  const targetSlots = queue.leased + Math.ceil(queue.queued / policy.targetQueuedPerSlot);
  const pressureWorkers = Math.ceil(targetSlots / effectiveConcurrency);
  let desiredWorkers = Math.max(policy.minWorkers, Math.min(policy.maxWorkers, pressureWorkers));
  let reason = queue.queued > fleet.availableSlots ? "queue_pressure" : "steady";

  if (queue.queued === 0 && queue.leased === 0) {
    desiredWorkers = policy.minWorkers;
    reason = desiredWorkers < fleet.currentWorkers ? "idle_capacity" : "steady";
  }
  if (queue.queued > 0 && fleet.currentWorkers === 0) {
    desiredWorkers = Math.max(1, desiredWorkers);
    reason = fleet.fallbackAllWorkers > 0 ? "dedicated_pool_missing_with_fallback" : "no_pool_workers";
  }

  const queueAgeSloBreached = queue.queued > 0 && queue.oldestQueuedAgeMs >= sloPolicy.queueAgeSloMs;
  const starvationRisk = queue.queued > 0 && queue.oldestQueuedAgeMs >= sloPolicy.starvationAgeMs;
  if (queueAgeSloBreached) {
    desiredWorkers = Math.min(
      policy.maxWorkers,
      Math.max(desiredWorkers, Math.max(1, fleet.currentWorkers + 1))
    );
    reason = starvationRisk ? "queue_age_starvation" : "queue_age_slo_breach";
  }

  const queueUtilization = sloPolicy.maxQueued > 0 ? queue.queued / sloPolicy.maxQueued : 0;
  const sloStatus = starvationRisk || queue.queued >= sloPolicy.maxQueued
    ? "critical" as const
    : queueAgeSloBreached || queueUtilization >= 0.8
      ? "degraded" as const
      : "healthy" as const;

  return {
    pool,
    checkedAt: new Date().toISOString(),
    currentWorkers: fleet.currentWorkers,
    desiredWorkers,
    delta: desiredWorkers - fleet.currentWorkers,
    reason,
    queue,
    fleet,
    policy,
    slo: {
      status: sloStatus,
      queueUtilization,
      queueAgeSloBreached,
      starvationRisk,
      admissionBlocked: queue.queued >= sloPolicy.maxQueued,
      maxQueued: sloPolicy.maxQueued,
      queueAgeSloMs: sloPolicy.queueAgeSloMs,
      starvationAgeMs: sloPolicy.starvationAgeMs
    },
    scalingState,
    scalerConfigured: Boolean(process.env.KOSH_OPS_SCALER_URL?.trim())
  };
}

export async function getKoshOpsPoolRecommendations() {
  return Promise.all(koshOpsDedicatedPools.map((pool) => getKoshOpsPoolRecommendation(pool)));
}

async function sendPoolScaleRequest(
  recommendation: Awaited<ReturnType<typeof getKoshOpsPoolRecommendation>>
) {
  const scalerUrl = process.env.KOSH_OPS_SCALER_URL?.trim();
  if (!scalerUrl) throw Object.assign(new Error("operations_scaler_not_configured"), { status: 503 });
  const token = process.env.KOSH_OPS_SCALER_TOKEN?.trim();
  if (process.env.NODE_ENV === "production" && !token) {
    throw Object.assign(new Error("operations_scaler_token_required"), { status: 503 });
  }
  const target = new URL(scalerUrl);
  if (process.env.NODE_ENV === "production" && target.protocol !== "https:") {
    throw Object.assign(new Error("operations_scaler_https_required"), { status: 503 });
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
      component: "operations-worker-pool",
      pool: recommendation.pool,
      desiredWorkers: recommendation.desiredWorkers,
      currentWorkers: recommendation.currentWorkers,
      reason: recommendation.reason,
      checkedAt: recommendation.checkedAt
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!upstream.ok) {
    throw Object.assign(new Error("operations_pool_scaler_rejected"), {
      status: 502,
      upstreamStatus: upstream.status
    });
  }
}

export async function reconcileKoshOpsPool(
  pool: KoshOpsDedicatedPool,
  options: { apply: boolean; automatic?: boolean }
) {
  const recommendation = await getKoshOpsPoolRecommendation(pool);
  const now = Date.now();
  const pressure = recommendation.queue.queued > recommendation.fleet.availableSlots ||
    (recommendation.queue.queued > 0 && recommendation.currentWorkers === 0) ||
    recommendation.slo.queueAgeSloBreached;
  const idle = recommendation.reason === "idle_capacity";
  const observedState = await updatePoolScalingState(pool, {
    desiredWorkers: recommendation.desiredWorkers,
    reason: recommendation.reason,
    pressure,
    idle
  });

  if (!options.apply) {
    return { applied: false, skipped: "dry_run", recommendation, scalingState: observedState };
  }
  if (options.automatic && !recommendation.policy.enabled) {
    return { applied: false, skipped: "automatic_scaling_disabled", recommendation, scalingState: observedState };
  }
  if (!recommendation.scalerConfigured) {
    return { applied: false, skipped: "scaler_not_configured", recommendation, scalingState: observedState };
  }
  if (recommendation.delta === 0) {
    return { applied: false, skipped: "already_at_desired_capacity", recommendation, scalingState: observedState };
  }

  const lastAppliedAt = observedState.lastAppliedAt
    ? new Date(observedState.lastAppliedAt).getTime()
    : 0;
  if (lastAppliedAt && now - lastAppliedAt < recommendation.policy.cooldownMs) {
    return {
      applied: false,
      skipped: "cooldown",
      retryAfterMs: recommendation.policy.cooldownMs - (now - lastAppliedAt),
      recommendation,
      scalingState: observedState
    };
  }
  if (recommendation.delta < 0) {
    const idleSince = observedState.idleSince ? new Date(observedState.idleSince).getTime() : now;
    if (now - idleSince < recommendation.policy.scaleDownStabilizationMs) {
      return {
        applied: false,
        skipped: "scale_down_stabilization",
        retryAfterMs: recommendation.policy.scaleDownStabilizationMs - (now - idleSince),
        recommendation,
        scalingState: observedState
      };
    }
  }

  await sendPoolScaleRequest(recommendation);
  const appliedState = await updatePoolScalingState(pool, {
    desiredWorkers: recommendation.desiredWorkers,
    reason: recommendation.reason,
    applied: true,
    pressure,
    idle
  });
  return { applied: true, recommendation, scalingState: appliedState };
}

export async function reconcileKoshOpsPools(options: { apply: boolean; automatic?: boolean }) {
  const results = [];
  for (const pool of koshOpsDedicatedPools) {
    results.push(await reconcileKoshOpsPool(pool, options));
  }
  return {
    enabled: process.env.KOSH_OPS_POOL_AUTOSCALE_ENABLED === "true",
    checkedAt: new Date().toISOString(),
    results
  };
}
