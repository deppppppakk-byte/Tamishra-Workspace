import postgres from "postgres";
import { listKoshOpsJobs } from "./kosh-ops-store.js";
import {
  koshOpsPoolSupportsType,
  parseKoshOpsWorkerPool,
  type KoshOpsWorkerPool
} from "./kosh-ops-pool-claim.js";
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

let sql: ReturnType<typeof postgres> | null = null;

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 2, prepare: false });
  return sql;
}

function recordedPool(worker: KoshOpsWorkerRecord): KoshOpsWorkerPool {
  const match = worker.releaseVersion.match(/(?:^|;)pool=([^;]+)/i);
  return parseKoshOpsWorkerPool(match?.[1] ?? "all");
}

function effectiveConcurrency(worker: KoshOpsWorkerRecord) {
  return Math.min(worker.concurrency, worker.desiredConcurrency ?? worker.concurrency);
}

function summarizeWorkers(workers: KoshOpsWorkerRecord[], pool: KoshOpsWorkerPool) {
  const matching = workers.filter((worker) => recordedPool(worker) === pool);
  const online = matching.filter((worker) => worker.status === "online");
  const active = online.filter((worker) => worker.requestedState === "active");
  const draining = online.filter((worker) => worker.requestedState === "draining");
  const disabled = online.filter((worker) => worker.requestedState === "disabled");
  return {
    pool,
    online: online.length,
    active: active.length,
    stale: matching.length - online.length,
    draining: draining.length,
    disabled: disabled.length,
    totalConcurrency: active.reduce((total, worker) => total + effectiveConcurrency(worker), 0),
    activeJobs: online.reduce((total, worker) => total + worker.activeJobs, 0),
    availableSlots: active.reduce(
      (total, worker) => total + Math.max(0, effectiveConcurrency(worker) - worker.activeJobs),
      0
    )
  };
}

export async function getKoshOpsPoolFleetSummaries() {
  const workers = await listKoshOpsWorkers(1000);
  return {
    checkedAt: new Date().toISOString(),
    shared: summarizeWorkers(workers, "all"),
    pools: Object.fromEntries(
      koshOpsDedicatedPools.map((pool) => [pool, summarizeWorkers(workers, pool)])
    ) as Record<KoshOpsDedicatedPool, ReturnType<typeof summarizeWorkers>>
  };
}

function memoryQueueStats(pool: KoshOpsDedicatedPool, items: Awaited<ReturnType<typeof listKoshOpsJobs>>) {
  const now = Date.now();
  const matching = items.filter((item) => koshOpsPoolSupportsType(pool, item.type));
  const queued = matching.filter((item) => item.state === "queued");
  const leased = matching.filter((item) => item.state === "leased");
  const oldest = queued.reduce(
    (value, item) => Math.min(value, new Date(item.createdAt).getTime()),
    now
  );
  return {
    pool,
    queued: queued.length,
    leased: leased.length,
    retrying: queued.filter((item) => item.attempt > 0).length,
    deadLettered: matching.filter((item) => item.deadLetteredAt).length,
    oldestQueuedAgeMs: queued.length ? Math.max(0, now - oldest) : 0,
    queuedByPriority: {
      high: queued.filter((item) => item.priority >= 75).length,
      normal: queued.filter((item) => item.priority >= 25 && item.priority < 75).length,
      low: queued.filter((item) => item.priority < 25).length
    }
  };
}

async function postgresQueueStats(pool: KoshOpsDedicatedPool) {
  const db = database();
  if (!db) throw new Error("database_not_configured");
  const select = async (predicate: "general" | "storage" | "recovery" | "database" | "isolated") => {
    if (predicate === "general") {
      return db`SELECT
        COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
        COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
        COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 75)::int AS high_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 25 AND priority < 75)::int AS normal_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority < 25)::int AS low_priority,
        COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
        FROM kosh_ops_jobs
        WHERE type IN ('alerts.evaluate','notification.deliver','pages.domain.verify','secret.rotation.audit')`;
    }
    if (predicate === "storage") {
      return db`SELECT
        COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
        COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
        COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 75)::int AS high_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 25 AND priority < 75)::int AS normal_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority < 25)::int AS low_priority,
        COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
        FROM kosh_ops_jobs
        WHERE type IN ('storage.lifecycle','replication.verify')`;
    }
    if (predicate === "recovery") {
      return db`SELECT
        COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
        COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
        COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 75)::int AS high_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 25 AND priority < 75)::int AS normal_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority < 25)::int AS low_priority,
        COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
        FROM kosh_ops_jobs WHERE type = 'recovery.drill'`;
    }
    if (predicate === "database") {
      return db`SELECT
        COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
        COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
        COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 75)::int AS high_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 25 AND priority < 75)::int AS normal_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority < 25)::int AS low_priority,
        COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
        FROM kosh_ops_jobs WHERE type = 'database.backup'`;
    }
    return db`SELECT
      COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
      COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
      COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
      COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
      COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 75)::int AS high_priority,
      COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 25 AND priority < 75)::int AS normal_priority,
      COUNT(*) FILTER (WHERE state = 'queued' AND priority < 25)::int AS low_priority,
      COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
      FROM kosh_ops_jobs WHERE type IN ('extension.execute','load.test','failure.probe')`;
  };

  const rows = await select(pool);
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    pool,
    queued: Number(row.queued ?? 0),
    leased: Number(row.leased ?? 0),
    retrying: Number(row.retrying ?? 0),
    deadLettered: Number(row.dead_lettered ?? 0),
    oldestQueuedAgeMs: Math.max(0, Number(row.oldest_queued_ms ?? 0)),
    queuedByPriority: {
      high: Number(row.high_priority ?? 0),
      normal: Number(row.normal_priority ?? 0),
      low: Number(row.low_priority ?? 0)
    }
  };
}

export async function getKoshOpsPoolQueueStats(pool: KoshOpsDedicatedPool) {
  if (!database()) {
    const items = await listKoshOpsJobs(undefined, 1000);
    return memoryQueueStats(pool, items);
  }
  return postgresQueueStats(pool);
}

export async function getKoshOpsPoolSnapshot() {
  const fleet = await getKoshOpsPoolFleetSummaries();
  const queues = await Promise.all(
    koshOpsDedicatedPools.map(async (pool) => [pool, await getKoshOpsPoolQueueStats(pool)] as const)
  );
  return {
    checkedAt: new Date().toISOString(),
    shared: fleet.shared,
    pools: Object.fromEntries(
      queues.map(([pool, queue]) => [pool, { fleet: fleet.pools[pool], queue }])
    ) as Record<KoshOpsDedicatedPool, { fleet: ReturnType<typeof summarizeWorkers>; queue: Awaited<ReturnType<typeof getKoshOpsPoolQueueStats>> }>
  };
}
