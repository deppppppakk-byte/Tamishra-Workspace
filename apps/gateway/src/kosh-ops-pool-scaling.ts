import postgres from "postgres";
import {
  koshOpsPoolJobTypes,
  type KoshOpsWorkerPool
} from "./kosh-ops-pool-claim.js";
import { getKoshOpsSchedulerLeadership } from "./kosh-ops-scheduler-leader.js";
import { listKoshOpsWorkers } from "./kosh-ops-worker-registry.js";

export type KoshOpsDedicatedPool = Exclude<KoshOpsWorkerPool, "all">;

export const koshOpsDedicatedPools: readonly KoshOpsDedicatedPool[] = [
  "general",
  "storage",
  "recovery",
  "database",
  "isolated"
];

let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 2, prepare: false });
  return sql;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function envName(pool: KoshOpsDedicatedPool, suffix: string) {
  return `KOSH_OPS_POOL_${pool.toUpperCase()}_${suffix}`;
}

function workerPool(releaseVersion: string): KoshOpsWorkerPool {
  const match = String(releaseVersion ?? "").match(/(?:^|;)pool=(all|general|storage|recovery|database|isolated)(?:;|$)/i);
  return (match?.[1]?.toLowerCase() as KoshOpsWorkerPool | undefined) ?? "all";
}

export function koshOpsPoolAutoscalePolicy() {
  const assumedConcurrency = boundedInteger(process.env.KOSH_OPS_AUTOSCALE_ASSUMED_CONCURRENCY, 2, 1, 64);
  const targetQueuedPerSlot = boundedInteger(process.env.KOSH_OPS_AUTOSCALE_TARGET_QUEUED_PER_SLOT, 2, 1, 100);
  const scaleDownIdleSlots = boundedInteger(process.env.KOSH_OPS_AUTOSCALE_SCALE_DOWN_IDLE_SLOTS, 4, 0, 1000);
  const cooldownMs = boundedInteger(process.env.KOSH_OPS_AUTOSCALE_COOLDOWN_SECONDS, 180, 30, 3600) * 1000;
  const scaleDownStabilizationMs = boundedInteger(
    process.env.KOSH_OPS_AUTOSCALE_SCALE_DOWN_STABILIZATION_SECONDS,
    600,
    60,
    86_400
  ) * 1000;

  return {
    enabled: process.env.KOSH_OPS_POOL_AUTOSCALE_ENABLED === "true",
    assumedConcurrency,
    targetQueuedPerSlot,
    scaleDownIdleSlots,
    cooldownMs,
    scaleDownStabilizationMs,
    pools: Object.fromEntries(
      koshOpsDedicatedPools.map((pool) => {
        const defaultMin = pool === "general" || pool === "storage" ? 1 : 0;
        return [
          pool,
          {
            minWorkers: boundedInteger(process.env[envName(pool, "MIN_WORKERS")], defaultMin, 0, 1000),
            maxWorkers: boundedInteger(process.env[envName(pool, "MAX_WORKERS")], 20, 1, 1000)
          }
        ];
      })
    ) as Record<KoshOpsDedicatedPool, { minWorkers: number; maxWorkers: number }>
  };
}

async function readyPoolScalingState() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_ops_pool_scaling_state (
    pool TEXT PRIMARY KEY,
    desired_workers INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT 'unknown',
    pressure_since TIMESTAMPTZ NULL,
    idle_since TIMESTAMPTZ NULL,
    last_applied_at TIMESTAMPTZ NULL,
    last_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK(pool IN ('general','storage','recovery','database','isolated')),
    CHECK(desired_workers >= 0 AND desired_workers <= 1000)
  )`;
  initialized = true;
}

type PoolScalingState = {
  pool: KoshOpsDedicatedPool;
  desiredWorkers: number;
  reason: string;
  pressureSince: string | null;
  idleSince: string | null;
  lastAppliedAt: string | null;
  lastObservedAt: string;
};

function stateFromRow(row: Record<string, unknown>): PoolScalingState {
  const timestamp = (value: unknown) => value ? new Date(String(value)).toISOString() : null;
  return {
    pool: String(row.pool) as KoshOpsDedicatedPool,
    desiredWorkers: Math.max(0, Number(row.desired_workers) || 0),
    reason: String(row.reason ?? "unknown"),
    pressureSince: timestamp(row.pressure_since),
    idleSince: timestamp(row.idle_since),
    lastAppliedAt: timestamp(row.last_applied_at),
    lastObservedAt: timestamp(row.last_observed_at) ?? new Date().toISOString()
  };
}

async function observePoolScalingState(input: {
  pool: KoshOpsDedicatedPool;
  desiredWorkers: number;
  reason: string;
  pressure: boolean;
  idle: boolean;
  applied?: boolean;
}) {
  const db = database();
  const now = new Date().toISOString();
  if (!db) {
    return {
      pool: input.pool,
      desiredWorkers: input.desiredWorkers,
      reason: input.reason,
      pressureSince: input.pressure ? now : null,
      idleSince: input.idle ? now : null,
      lastAppliedAt: input.applied ? now : null,
      lastObservedAt: now
    } satisfies PoolScalingState;
  }
  await readyPoolScalingState();
  const rows = await db`
    INSERT INTO kosh_ops_pool_scaling_state(
      pool, desired_workers, reason, pressure_since, idle_since, last_applied_at, last_observed_at
    ) VALUES(
      ${input.pool}, ${input.desiredWorkers}, ${input.reason},
      ${input.pressure ? now : null}, ${input.idle ? now : null}, ${input.applied ? now : null}, NOW()
    )
    ON CONFLICT(pool) DO UPDATE SET
      desired_workers = EXCLUDED.desired_workers,
      reason = EXCLUDED.reason,
      pressure_since = CASE
        WHEN ${input.pressure} THEN COALESCE(kosh_ops_pool_scaling_state.pressure_since, NOW())
        ELSE NULL
      END,
      idle_since = CASE
        WHEN ${input.idle} THEN COALESCE(kosh_ops_pool_scaling_state.idle_since, NOW())
        ELSE NULL
      END,
      last_applied_at = CASE
        WHEN ${Boolean(input.applied)} THEN NOW()
        ELSE kosh_ops_pool_scaling_state.last_applied_at
      END,
      last_observed_at = NOW()
    RETURNING *
  `;
  return stateFromRow(rows[0] as Record<string, unknown>);
}

async function queuePressureByPool() {
  const db = database();
  const empty = Object.fromEntries(
    koshOpsDedicatedPools.map((pool) => [pool, { queued: 0, leased: 0, oldestQueuedAgeMs: 0 }])
  ) as Record<KoshOpsDedicatedPool, { queued: number; leased: number; oldestQueuedAgeMs: number }>;
  if (!db) return empty;

  const rows = await db`
    SELECT type, state, COUNT(*)::int AS count,
      MIN(created_at) FILTER (WHERE state = 'queued') AS oldest_queued_at
    FROM kosh_ops_jobs
    WHERE state IN ('queued', 'leased')
    GROUP BY type, state
  `;
  const now = Date.now();
  for (const row of rows) {
    const type = String(row.type);
    const pool = koshOpsDedicatedPools.find((candidate) => koshOpsPoolJobTypes[candidate].includes(type as never));
    if (!pool) continue;
    const count = Math.max(0, Number(row.count) || 0);
    if (row.state === "queued") {
      empty[pool].queued += count;
      if (row.oldest_queued_at) {
        const age = Math.max(0, now - new Date(String(row.oldest_queued_at)).getTime());
        empty[pool].oldestQueuedAgeMs = Math.max(empty[pool].oldestQueuedAgeMs, age);
      }
    } else if (row.state === "leased") {
      empty[pool].leased += count;
    }
  }
  return empty;
}

function poolScalerUrl(pool: KoshOpsDedicatedPool) {
  return process.env[envName(pool, "SCALER_URL")]?.trim() || process.env.KOSH_OPS_SCALER_URL?.trim() || "";
}

async function sendPoolScaleRequest(recommendation: PoolRecommendation) {
  const scalerUrl = poolScalerUrl(recommendation.pool);
  if (!scalerUrl) throw Object.assign(new Error("operations_pool_scaler_not_configured"), { status: 503 });
  const token = process.env.KOSH_OPS_SCALER_TOKEN?.trim();
  if (process.env.NODE_ENV === "production" && !token) {
    throw Object.assign(new Error("operations_scaler_token_required"), { status: 503 });
  }
  const target = new URL(scalerUrl);
  if (target.protocol !== "https:" && process.env.NODE_ENV === "production") {
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
      upstreamStatus: upstream.status,
      pool: recommendation.pool
    });
  }
}

type PoolRecommendation = Awaited<ReturnType<typeof getKoshOpsPoolRecommendations>>["pools"][number];

export async function getKoshOpsPoolRecommendations() {
  const [workers, pressure, scheduler] = await Promise.all([
    listKoshOpsWorkers(1000),
    queuePressureByPool(),
    getKoshOpsSchedulerLeadership()
  ]);
  const policy = koshOpsPoolAutoscalePolicy();
  const online = workers.filter((worker) => worker.status === "online" && worker.requestedState === "active");
  const sharedWorkers = online.filter((worker) => workerPool(worker.releaseVersion) === "all");
  const sharedAvailableSlots = sharedWorkers.reduce((total, worker) => {
    const effective = Math.min(worker.concurrency, worker.desiredConcurrency ?? worker.concurrency);
    return total + Math.max(0, effective - worker.activeJobs);
  }, 0);

  const pools = koshOpsDedicatedPools.map((pool) => {
    const poolWorkers = online.filter((worker) => workerPool(worker.releaseVersion) === pool);
    const totalConcurrency = poolWorkers.reduce(
      (total, worker) => total + Math.min(worker.concurrency, worker.desiredConcurrency ?? worker.concurrency),
      0
    );
    const activeJobs = poolWorkers.reduce((total, worker) => total + worker.activeJobs, 0);
    const availableSlots = poolWorkers.reduce((total, worker) => {
      const effective = Math.min(worker.concurrency, worker.desiredConcurrency ?? worker.concurrency);
      return total + Math.max(0, effective - worker.activeJobs);
    }, 0);
    const effectiveConcurrency = poolWorkers.length > 0
      ? Math.max(1, Math.round(totalConcurrency / poolWorkers.length))
      : policy.assumedConcurrency;
    const queue = pressure[pool];
    const bounds = policy.pools[pool];
    const targetSlots = queue.leased + Math.ceil(queue.queued / policy.targetQueuedPerSlot);
    const pressureWorkers = Math.ceil(targetSlots / effectiveConcurrency);
    let desiredWorkers = Math.max(bounds.minWorkers, Math.min(bounds.maxWorkers, pressureWorkers || bounds.minWorkers));
    let reason = queue.queued > availableSlots ? "queue_pressure" : "steady";

    if (queue.queued === 0 && availableSlots >= policy.scaleDownIdleSlots) {
      desiredWorkers = Math.max(
        bounds.minWorkers,
        Math.min(desiredWorkers, Math.ceil(Math.max(queue.leased, 0) / effectiveConcurrency))
      );
      reason = desiredWorkers < poolWorkers.length ? "idle_capacity" : "steady";
    }
    if (poolWorkers.length === 0 && queue.queued > 0) {
      desiredWorkers = Math.max(1, bounds.minWorkers, desiredWorkers);
      reason = "no_pool_workers";
    }
    if (!scheduler.active) reason = "scheduler_leader_missing";

    return {
      pool,
      checkedAt: new Date().toISOString(),
      currentWorkers: poolWorkers.length,
      desiredWorkers,
      delta: desiredWorkers - poolWorkers.length,
      reason,
      queue,
      fleet: {
        workers: poolWorkers.length,
        totalConcurrency,
        activeJobs,
        availableSlots
      },
      sharedFallback: {
        workers: sharedWorkers.length,
        availableSlots: sharedAvailableSlots
      },
      policy: bounds,
      scalerConfigured: Boolean(poolScalerUrl(pool))
    };
  });

  return {
    checkedAt: new Date().toISOString(),
    enabled: policy.enabled,
    scheduler,
    sharedFallback: { workers: sharedWorkers.length, availableSlots: sharedAvailableSlots },
    policy,
    pools
  };
}

export async function reconcileKoshOpsPools(options: { apply: boolean; automatic?: boolean }) {
  const recommendations = await getKoshOpsPoolRecommendations();
  const now = Date.now();
  const results = [] as Array<{
    pool: KoshOpsDedicatedPool;
    applied: boolean;
    skipped?: string;
    retryAfterMs?: number;
    recommendation: PoolRecommendation;
    scalingState: PoolScalingState;
  }>;

  for (const recommendation of recommendations.pools) {
    const pressure = recommendation.queue.queued > recommendation.fleet.availableSlots ||
      (recommendation.currentWorkers === 0 && recommendation.queue.queued > 0);
    const idle = recommendation.reason === "idle_capacity";
    let state = await observePoolScalingState({
      pool: recommendation.pool,
      desiredWorkers: recommendation.desiredWorkers,
      reason: recommendation.reason,
      pressure,
      idle
    });

    if (!options.apply) {
      results.push({ pool: recommendation.pool, applied: false, skipped: "dry_run", recommendation, scalingState: state });
      continue;
    }
    if (options.automatic && !recommendations.enabled) {
      results.push({ pool: recommendation.pool, applied: false, skipped: "automatic_pool_scaling_disabled", recommendation, scalingState: state });
      continue;
    }
    if (!recommendation.scalerConfigured) {
      results.push({ pool: recommendation.pool, applied: false, skipped: "scaler_not_configured", recommendation, scalingState: state });
      continue;
    }
    if (recommendation.delta === 0) {
      results.push({ pool: recommendation.pool, applied: false, skipped: "already_at_desired_capacity", recommendation, scalingState: state });
      continue;
    }

    const lastAppliedAt = state.lastAppliedAt ? new Date(state.lastAppliedAt).getTime() : 0;
    if (lastAppliedAt && now - lastAppliedAt < recommendations.policy.cooldownMs) {
      results.push({
        pool: recommendation.pool,
        applied: false,
        skipped: "cooldown",
        retryAfterMs: recommendations.policy.cooldownMs - (now - lastAppliedAt),
        recommendation,
        scalingState: state
      });
      continue;
    }

    if (recommendation.delta < 0) {
      const idleSince = state.idleSince ? new Date(state.idleSince).getTime() : now;
      if (now - idleSince < recommendations.policy.scaleDownStabilizationMs) {
        results.push({
          pool: recommendation.pool,
          applied: false,
          skipped: "scale_down_stabilization",
          retryAfterMs: recommendations.policy.scaleDownStabilizationMs - (now - idleSince),
          recommendation,
          scalingState: state
        });
        continue;
      }
    }

    await sendPoolScaleRequest(recommendation);
    state = await observePoolScalingState({
      pool: recommendation.pool,
      desiredWorkers: recommendation.desiredWorkers,
      reason: recommendation.reason,
      pressure,
      idle,
      applied: true
    });
    results.push({ pool: recommendation.pool, applied: true, recommendation, scalingState: state });
  }

  return {
    applied: results.some((item) => item.applied),
    recommendations,
    results
  };
}
