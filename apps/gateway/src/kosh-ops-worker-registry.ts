import postgres from "postgres";

export type KoshOpsWorkerRequestedState = "active" | "draining" | "disabled";

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
  requestedState: KoshOpsWorkerRequestedState;
  desiredConcurrency: number | null;
  controlReason: string | null;
  controlUpdatedAt: string | null;
  controlUpdatedBy: string | null;
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

export type KoshOpsWorkerControl = {
  requestedState: KoshOpsWorkerRequestedState;
  desiredConcurrency: number | null;
  reason?: string | null;
  updatedBy?: string | null;
};

type MemoryWorker = Omit<KoshOpsWorkerRecord, "status">;
const memoryWorkers = new Map<string, MemoryWorker>();
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
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requestedState(value: unknown): KoshOpsWorkerRequestedState {
  return value === "draining" || value === "disabled" ? value : "active";
}

function withStatus(input: MemoryWorker): KoshOpsWorkerRecord {
  return {
    ...input,
    status: Date.now() - new Date(input.lastSeenAt).getTime() <= koshOpsWorkerStaleMs() ? "online" : "stale"
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
    startedAt: timestamp(row.started_at) ?? new Date().toISOString(),
    lastSeenAt: timestamp(row.last_seen_at) ?? new Date().toISOString(),
    requestedState: requestedState(row.requested_state),
    desiredConcurrency: row.desired_concurrency == null ? null : boundedInteger(row.desired_concurrency, 1, 1, 64),
    controlReason: row.control_reason == null ? null : String(row.control_reason),
    controlUpdatedAt: timestamp(row.control_updated_at),
    controlUpdatedBy: row.control_updated_by == null ? null : String(row.control_updated_by)
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
    requested_state TEXT NOT NULL DEFAULT 'active',
    desired_concurrency INTEGER NULL,
    control_reason TEXT NULL,
    control_updated_at TIMESTAMPTZ NULL,
    control_updated_by TEXT NULL,
    CHECK(concurrency >= 1 AND concurrency <= 64),
    CHECK(active_jobs >= 0 AND active_jobs <= 64)
  )`;
  await db`ALTER TABLE kosh_ops_workers ADD COLUMN IF NOT EXISTS requested_state TEXT NOT NULL DEFAULT 'active'`;
  await db`ALTER TABLE kosh_ops_workers ADD COLUMN IF NOT EXISTS desired_concurrency INTEGER NULL`;
  await db`ALTER TABLE kosh_ops_workers ADD COLUMN IF NOT EXISTS control_reason TEXT NULL`;
  await db`ALTER TABLE kosh_ops_workers ADD COLUMN IF NOT EXISTS control_updated_at TIMESTAMPTZ NULL`;
  await db`ALTER TABLE kosh_ops_workers ADD COLUMN IF NOT EXISTS control_updated_by TEXT NULL`;
  await db`CREATE INDEX IF NOT EXISTS kosh_ops_workers_seen_idx ON kosh_ops_workers(last_seen_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS kosh_ops_workers_control_idx ON kosh_ops_workers(requested_state, last_seen_at DESC)`;
  initialized = true;
}

export async function heartbeatKoshOpsWorker(input: HeartbeatInput) {
  const workerId = clean(input.workerId, 200);
  if (!workerId) throw new Error("worker_id_required");
  const now = new Date().toISOString();
  const heartbeat = {
    workerId,
    hostname: clean(input.hostname, 200) || "unknown",
    processId: boundedInteger(input.processId, 0, 0, 2_147_483_647),
    releaseVersion: clean(input.releaseVersion, 120) || "unknown",
    concurrency: boundedInteger(input.concurrency, 1, 1, 64),
    activeJobs: boundedInteger(input.activeJobs, 0, 0, 64),
    scheduler: Boolean(input.scheduler),
    startedAt: timestamp(input.startedAt) ?? now,
    lastSeenAt: now
  };
  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") throw Object.assign(new Error("kosh_ops_worker_registry_requires_database"), { status: 503 });
    const existing = memoryWorkers.get(workerId);
    const item: MemoryWorker = {
      ...heartbeat,
      requestedState: existing?.requestedState ?? "active",
      desiredConcurrency: existing?.desiredConcurrency ?? null,
      controlReason: existing?.controlReason ?? null,
      controlUpdatedAt: existing?.controlUpdatedAt ?? null,
      controlUpdatedBy: existing?.controlUpdatedBy ?? null
    };
    memoryWorkers.set(workerId, item);
    return withStatus(item);
  }
  await readyKoshOpsWorkerRegistry();
  const rows = await db`
    INSERT INTO kosh_ops_workers(worker_id, hostname, process_id, release_version, concurrency, active_jobs, scheduler, started_at, last_seen_at)
    VALUES(${heartbeat.workerId}, ${heartbeat.hostname}, ${heartbeat.processId}, ${heartbeat.releaseVersion}, ${heartbeat.concurrency}, ${heartbeat.activeJobs}, ${heartbeat.scheduler}, ${heartbeat.startedAt}, NOW())
    ON CONFLICT(worker_id) DO UPDATE SET
      hostname = EXCLUDED.hostname,
      process_id = EXCLUDED.process_id,
      release_version = EXCLUDED.release_version,
      concurrency = EXCLUDED.concurrency,
      active_jobs = EXCLUDED.active_jobs,
      scheduler = EXCLUDED.scheduler,
      started_at = EXCLUDED.started_at,
      last_seen_at = NOW()
    RETURNING *
  `;
  return fromRow(rows[0] as Record<string, unknown>);
}

export async function listKoshOpsWorkers(limit = 200) {
  const take = boundedInteger(limit, 200, 1, 1000);
  const db = database();
  if (!db) return [...memoryWorkers.values()].map(withStatus).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, take);
  await readyKoshOpsWorkerRegistry();
  const rows = await db`SELECT * FROM kosh_ops_workers ORDER BY last_seen_at DESC LIMIT ${take}`;
  return rows.map((row) => fromRow(row as Record<string, unknown>));
}

export async function getKoshOpsWorker(workerId: string) {
  const id = clean(workerId, 200);
  if (!id) return null;
  const db = database();
  if (!db) {
    const item = memoryWorkers.get(id);
    return item ? withStatus(item) : null;
  }
  await readyKoshOpsWorkerRegistry();
  const rows = await db`SELECT * FROM kosh_ops_workers WHERE worker_id = ${id} LIMIT 1`;
  return rows[0] ? fromRow(rows[0] as Record<string, unknown>) : null;
}

export async function getKoshOpsWorkerControl(workerId: string) {
  const worker = await getKoshOpsWorker(workerId);
  return worker
    ? { requestedState: worker.requestedState, desiredConcurrency: worker.desiredConcurrency, known: true as const }
    : { requestedState: "active" as const, desiredConcurrency: null, known: false as const };
}

export async function setKoshOpsWorkerControl(workerId: string, control: KoshOpsWorkerControl) {
  const id = clean(workerId, 200);
  if (!id) throw Object.assign(new Error("worker_id_required"), { status: 400 });
  const nextState = requestedState(control.requestedState);
  const desiredConcurrency = control.desiredConcurrency == null ? null : boundedInteger(control.desiredConcurrency, 1, 1, 64);
  const reason = clean(control.reason, 500) || null;
  const updatedBy = clean(control.updatedBy, 200) || null;
  const now = new Date().toISOString();
  const db = database();
  if (!db) {
    const item = memoryWorkers.get(id);
    if (!item) return null;
    item.requestedState = nextState;
    item.desiredConcurrency = desiredConcurrency;
    item.controlReason = reason;
    item.controlUpdatedAt = now;
    item.controlUpdatedBy = updatedBy;
    return withStatus(item);
  }
  await readyKoshOpsWorkerRegistry();
  const rows = await db`
    UPDATE kosh_ops_workers
    SET requested_state = ${nextState}, desired_concurrency = ${desiredConcurrency}, control_reason = ${reason}, control_updated_at = NOW(), control_updated_by = ${updatedBy}
    WHERE worker_id = ${id}
    RETURNING *
  `;
  return rows[0] ? fromRow(rows[0] as Record<string, unknown>) : null;
}

export async function removeStaleKoshOpsWorker(workerId: string) {
  const id = clean(workerId, 200);
  if (!id) return false;
  const staleBefore = new Date(Date.now() - koshOpsWorkerStaleMs()).toISOString();
  const db = database();
  if (!db) {
    const item = memoryWorkers.get(id);
    if (!item || item.activeJobs > 0 || item.lastSeenAt > staleBefore) return false;
    return memoryWorkers.delete(id);
  }
  await readyKoshOpsWorkerRegistry();
  const rows = await db`DELETE FROM kosh_ops_workers WHERE worker_id = ${id} AND active_jobs = 0 AND last_seen_at < ${staleBefore} RETURNING worker_id`;
  return rows.length > 0;
}

export async function getKoshOpsWorkerFleetSummary() {
  const workers = await listKoshOpsWorkers();
  const online = workers.filter((worker) => worker.status === "online");
  const stale = workers.filter((worker) => worker.status === "stale");
  const active = online.filter((worker) => worker.requestedState === "active");
  const draining = online.filter((worker) => worker.requestedState === "draining");
  const disabled = online.filter((worker) => worker.requestedState === "disabled");
  const schedulers = active.filter((worker) => worker.scheduler);
  const effectiveConcurrency = (worker: KoshOpsWorkerRecord) => Math.min(worker.concurrency, worker.desiredConcurrency ?? worker.concurrency);
  return {
    persistence: database() ? "postgres" as const : "ephemeral-memory" as const,
    checkedAt: new Date().toISOString(),
    online: online.length,
    stale: stale.length,
    active: active.length,
    draining: draining.length,
    disabled: disabled.length,
    schedulerLeaders: schedulers.length,
    totalConcurrency: active.reduce((total, worker) => total + effectiveConcurrency(worker), 0),
    activeJobs: online.reduce((total, worker) => total + worker.activeJobs, 0),
    availableSlots: active.reduce((total, worker) => total + Math.max(0, effectiveConcurrency(worker) - worker.activeJobs), 0),
    healthy: active.length > 0 && schedulers.length === 1,
    schedulerState: schedulers.length === 1 ? "healthy" as const : schedulers.length === 0 ? "missing" as const : "multiple" as const
  };
}
