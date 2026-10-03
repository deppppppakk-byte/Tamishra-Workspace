import postgres from "postgres";
import { koshOpsPoolJobTypes, type KoshOpsWorkerPool } from "./kosh-ops-pool-claim.js";
import {
  enqueueKoshOpsJob,
  listKoshOpsJobs,
  type KoshOpsJob,
  type KoshOpsJobType
} from "./kosh-ops-store.js";

export type KoshOpsDedicatedPool = Exclude<KoshOpsWorkerPool, "all">;

export type KoshOpsPoolPolicy = {
  pool: KoshOpsDedicatedPool;
  maxQueued: number;
  queueAgeSloMs: number;
  starvationAgeMs: number;
};

let sql: ReturnType<typeof postgres> | null = null;

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

export function poolForKoshOpsJobType(type: KoshOpsJobType): KoshOpsDedicatedPool {
  for (const [pool, types] of Object.entries(koshOpsPoolJobTypes)) {
    if ((types as readonly KoshOpsJobType[]).includes(type)) return pool as KoshOpsDedicatedPool;
  }
  throw Object.assign(new Error("operations_pool_not_mapped"), { status: 500, type });
}

function policyDefaults(pool: KoshOpsDedicatedPool) {
  if (pool === "general") return { maxQueued: 1000, sloSeconds: 120, starvationSeconds: 300 };
  if (pool === "storage") return { maxQueued: 500, sloSeconds: 600, starvationSeconds: 1200 };
  if (pool === "recovery") return { maxQueued: 100, sloSeconds: 900, starvationSeconds: 1800 };
  if (pool === "database") return { maxQueued: 100, sloSeconds: 900, starvationSeconds: 1800 };
  return { maxQueued: 200, sloSeconds: 300, starvationSeconds: 600 };
}

export function koshOpsPoolPolicy(pool: KoshOpsDedicatedPool): KoshOpsPoolPolicy {
  const defaults = policyDefaults(pool);
  const prefix = `KOSH_OPS_POOL_${pool.toUpperCase()}`;
  const maxQueued = boundedInteger(process.env[`${prefix}_MAX_QUEUED`], defaults.maxQueued, 1, 100_000);
  const sloSeconds = boundedInteger(process.env[`${prefix}_QUEUE_AGE_SLO_SECONDS`], defaults.sloSeconds, 10, 86_400);
  const starvationSeconds = boundedInteger(
    process.env[`${prefix}_STARVATION_SECONDS`],
    Math.max(defaults.starvationSeconds, sloSeconds),
    sloSeconds,
    7 * 86_400
  );
  return {
    pool,
    maxQueued,
    queueAgeSloMs: sloSeconds * 1000,
    starvationAgeMs: starvationSeconds * 1000
  };
}

function scopedMemoryStats(pool: KoshOpsDedicatedPool, jobs: KoshOpsJob[]) {
  const types = new Set<KoshOpsJobType>(koshOpsPoolJobTypes[pool]);
  const queued = jobs.filter((item) => item.state === "queued" && types.has(item.type));
  const now = Date.now();
  const oldest = queued.reduce(
    (value, item) => Math.min(value, new Date(item.createdAt).getTime()),
    now
  );
  return {
    queued: queued.length,
    oldestQueuedAgeMs: queued.length ? Math.max(0, now - oldest) : 0
  };
}

async function postgresPoolStats(pool: KoshOpsDedicatedPool) {
  const db = database();
  if (!db) throw new Error("database_not_configured");
  let rows;
  if (pool === "general") {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_ms
      FROM kosh_ops_jobs WHERE type IN ('alerts.evaluate','notification.deliver','pages.domain.verify','secret.rotation.audit')`;
  } else if (pool === "storage") {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_ms
      FROM kosh_ops_jobs WHERE type IN ('storage.lifecycle','replication.verify')`;
  } else if (pool === "recovery") {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_ms
      FROM kosh_ops_jobs WHERE type = 'recovery.drill'`;
  } else if (pool === "database") {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_ms
      FROM kosh_ops_jobs WHERE type = 'database.backup'`;
  } else {
    rows = await db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_ms
      FROM kosh_ops_jobs WHERE type IN ('extension.execute','load.test','failure.probe')`;
  }
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    queued: Number(row.queued ?? 0),
    oldestQueuedAgeMs: Math.max(0, Number(row.oldest_ms ?? 0))
  };
}

export async function getKoshOpsPoolSloEvidence(pool: KoshOpsDedicatedPool) {
  const policy = koshOpsPoolPolicy(pool);
  const stats = database()
    ? await postgresPoolStats(pool)
    : scopedMemoryStats(pool, await listKoshOpsJobs(undefined, 1000));
  const ratio = policy.maxQueued > 0 ? stats.queued / policy.maxQueued : 0;
  return {
    pool,
    checkedAt: new Date().toISOString(),
    policy,
    ...stats,
    queueUtilization: ratio,
    queueAgeSloBreached: stats.oldestQueuedAgeMs > policy.queueAgeSloMs,
    starvationRisk: stats.oldestQueuedAgeMs > policy.starvationAgeMs,
    admissionBlocked: stats.queued >= policy.maxQueued,
    status: stats.oldestQueuedAgeMs > policy.starvationAgeMs || stats.queued >= policy.maxQueued
      ? "critical" as const
      : stats.oldestQueuedAgeMs > policy.queueAgeSloMs || ratio >= 0.8
        ? "degraded" as const
        : "healthy" as const
  };
}

export async function assertKoshOpsPoolAdmission(type: KoshOpsJobType) {
  const pool = poolForKoshOpsJobType(type);
  const evidence = await getKoshOpsPoolSloEvidence(pool);
  if (evidence.admissionBlocked) {
    throw Object.assign(new Error("kosh_ops_pool_queue_backpressure"), {
      status: 429,
      retryAfterSeconds: 30,
      pool,
      queued: evidence.queued,
      limit: evidence.policy.maxQueued
    });
  }
  return evidence;
}

export async function enqueueKoshOpsJobWithPoolAdmission(
  input: Parameters<typeof enqueueKoshOpsJob>[0]
) {
  await assertKoshOpsPoolAdmission(input.type);
  return enqueueKoshOpsJob(input);
}
