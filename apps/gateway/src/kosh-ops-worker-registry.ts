import postgres from "postgres";

export type KoshOpsWorkerRecord = {
  workerId: string;
  hostname: string;
  processId: number;
  releaseVersion: string;
  concurrency: number;
  activeJobs: number;
  scheduler: boolean;
  startedAt: string;
  lastSeenAt: string;
  status: "online" | "stale";
};

type HeartbeatInput = {
  workerId: string;
  hostname: string;
  processId: number;
  releaseVersion?: string;
  concurrency: number;
  activeJobs: number;
  scheduler: boolean;
  startedAt: string;
};

const memoryWorkers = new Map<string, Omit<KoshOpsWorkerRecord, "status">>();
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
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export function koshOpsWorkerStaleMs() {
  return boundedInteger(process.env.KOSH_OPS_WORKER_STALE_SECONDS, 90, 20, 3600) * 1000;
}

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function timestamp(value: unknown) {
  const date = value ? new Date(String(value)) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function withStatus(input: Omit<KoshOpsWorkerRecord, "status">): KoshOpsWorkerRecord {
  return {
    ...input,
    status: Date.now() - new Date(input.lastSeenAt).getTime() <= koshOpsWorkerStaleMs()
      ? "online"
      : "stale"
  };
}

function fromRow(row: Record<string, unknown>): KoshOpsWorkerRecord {
  return withStatus({
    workerId: String(row.worker_id),
    hostname: String(row.hostname ?? "unknown"),
    processId: Math.max(0, Number(row.process_id) || 0),
    releaseVersion: String(row.release_version ?? "unknown"),
    concurrency: Math.max(1, Number(row.concurrency) || 1),
    activeJobs: Math.max(0, Number(row.active_jobs) || 0),
    scheduler: Boolean(row.scheduler),
    startedAt: timestamp(row.started_at),
    lastSeenAt: timestamp(row.last_seen_at)
  });
}

export async function readyKoshOpsWorkerRegistry() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_ops_workers (
    worker_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    process_id INTEGER NOT NULL,
    release_version TEXT NOT NULL DEFAULT 'unknown',
    concurrency INTEGER NOT NULL,
    active_jobs INTEGER NOT NULL DEFAULT 0,
    scheduler BOOLEAN NOT NULL DEFAULT FALSE,
    started_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK(concurrency >= 1 AND concurrency <= 64),
    CHECK(active_jobs >= 0 AND active_jobs <= 64)
  )`;
  await db`CREATE INDEX IF NOT EXISTS kosh_ops_workers_seen_idx
    ON kosh_ops_workers(last_seen_at DESC)`;
  initialized = true;
}

export async function heartbeatKoshOpsWorker(input: HeartbeatInput) {
  const workerId = clean(input.workerId, 200);
  if (!workerId) throw new Error("worker_id_required");
  const item = {
    workerId,
    hostname: clean(input.hostname, 200) || "unknown",
    processId: boundedInteger(input.processId, 0, 0, 2_147_483_647),
    releaseVersion: clean(input.releaseVersion, 120) || "unknown",
    concurrency: boundedInteger(input.concurrency, 1, 1, 64),
    activeJobs: boundedInteger(input.activeJobs, 0, 0, 64),
    scheduler: Boolean(input.scheduler),
    startedAt: timestamp(input.startedAt),
    lastSeenAt: new Date().toISOString()
  } satisfies Omit<KoshOpsWorkerRecord, "status">;

  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_worker_registry_requires_database"), { status: 503 });
    }
    memoryWorkers.set(workerId, item);
    return withStatus(item);
  }
  await readyKoshOpsWorkerRegistry();
  const rows = await db`
    INSERT INTO kosh_ops_workers(
      worker_id, hostname, process_id, release_version, concurrency,
      active_jobs, scheduler, started_at, last_seen_at
    ) VALUES(
      ${item.workerId}, ${item.hostname}, ${item.processId}, ${item.releaseVersion},
      ${item.concurrency}, ${item.activeJobs}, ${item.scheduler}, ${item.startedAt}, NOW()
    )
    ON CONFLICT(worker_id) DO UPDATE SET
      hostname = EXCLUDED.hostname,
      process_id = EXCLUDED.process_id,
      release_version = EXCLUDED.release_version,
      concurrency = EXCLUDED.concurrency,
      active_jobs = EXCLUDED.active_jobs,
      scheduler = EXCLUDED.scheduler,
      last_seen_at = NOW()
    RETURNING *
  `;
  return fromRow(rows[0] as Record<string, unknown>);
}

export async function listKoshOpsWorkers(limit = 200) {
  const take = boundedInteger(limit, 200, 1, 1000);
  const db = database();
  if (!db) {
    return [...memoryWorkers.values()]
      .map(withStatus)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, take);
  }
  await readyKoshOpsWorkerRegistry();
  const rows = await db`SELECT * FROM kosh_ops_workers ORDER BY last_seen_at DESC LIMIT ${take}`;
  return rows.map((row) => fromRow(row as Record<string, unknown>));
}

export async function getKoshOpsWorkerFleetSummary() {
  const workers = await listKoshOpsWorkers();
  const online = workers.filter((worker) => worker.status === "online");
  const stale = workers.filter((worker) => worker.status === "stale");
  const schedulers = online.filter((worker) => worker.scheduler);
  return {
    persistence: database() ? "postgres" as const : "ephemeral-memory" as const,
    checkedAt: new Date().toISOString(),
    online: online.length,
    stale: stale.length,
    schedulerLeaders: schedulers.length,
    totalConcurrency: online.reduce((total, worker) => total + worker.concurrency, 0),
    activeJobs: online.reduce((total, worker) => total + worker.activeJobs, 0),
    availableSlots: online.reduce(
      (total, worker) => total + Math.max(0, worker.concurrency - worker.activeJobs),
      0
    ),
    healthy: online.length > 0 && schedulers.length === 1,
    schedulerState: schedulers.length === 1 ? "healthy" as const : schedulers.length === 0 ? "missing" as const : "multiple" as const
  };
}
