import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshOpsJobType =
  | "storage.lifecycle"
  | "replication.verify"
  | "recovery.drill"
  | "alerts.evaluate"
  | "notification.deliver"
  | "pages.domain.verify"
  | "extension.execute"
  | "load.test"
  | "database.backup"
  | "secret.rotation.audit"
  | "failure.probe";

export type KoshOpsJobState =
  | "queued"
  | "leased"
  | "succeeded"
  | "failed"
  | "cancelled";

export type KoshOpsJob = {
  id: string;
  repositoryId: string | null;
  type: KoshOpsJobType;
  state: KoshOpsJobState;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  priority: number;
  idempotencyKey: string | null;
  availableAt: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  deadLetteredAt: string | null;
  finishedAt: string | null;
  createdByUserId: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

type EnqueueInput = {
  repositoryId?: string | null;
  type: KoshOpsJobType;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  priority?: number;
  idempotencyKey?: string | null;
  availableAt?: string;
  createdByUserId?: string | null;
  createdByName?: string;
};

const memoryJobs = new Map<string, KoshOpsJob>();
let memoryClaimLock: Promise<void> = Promise.resolve();
let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 4, prepare: false });
  return sql;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function leaseMs() {
  return boundedInteger(process.env.KOSH_OPS_LEASE_SECONDS, 120, 30, 1800) * 1000;
}

function maxQueuedJobs() {
  return boundedInteger(process.env.KOSH_OPS_MAX_QUEUED, 10_000, 100, 1_000_000);
}

function maxRepositoryQueuedJobs() {
  return boundedInteger(process.env.KOSH_OPS_MAX_REPOSITORY_QUEUED, 1_000, 10, 100_000);
}

function nowIso() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeIdempotencyKey(value: unknown) {
  const key = String(value ?? "").trim();
  return key ? key.slice(0, 200) : null;
}

function timestamp(value: unknown) {
  return value ? new Date(String(value)).toISOString() : null;
}

function jobFromRow(row: Record<string, unknown>): KoshOpsJob {
  const json = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {};
      } catch {
        return {};
      }
    }
    return {};
  };
  return {
    id: String(row.id),
    repositoryId: row.repository_id == null ? null : String(row.repository_id),
    type: String(row.type) as KoshOpsJobType,
    state: String(row.state) as KoshOpsJobState,
    payload: json(row.payload),
    result: row.result == null ? null : json(row.result),
    error: row.error == null ? null : String(row.error),
    attempt: Number(row.attempt) || 0,
    maxAttempts: Number(row.max_attempts) || 1,
    priority: boundedInteger(row.priority, 50, 0, 100),
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
    availableAt: timestamp(row.available_at) ?? nowIso(),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseExpiresAt: timestamp(row.lease_expires_at),
    deadLetteredAt: timestamp(row.dead_lettered_at),
    finishedAt: timestamp(row.finished_at),
    createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id),
    createdByName: String(row.created_by_name ?? "Kosh Operations"),
    createdAt: timestamp(row.created_at) ?? nowIso(),
    updatedAt: timestamp(row.updated_at) ?? nowIso()
  };
}

export async function readyKoshOpsStore() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_ops_jobs (
    id TEXT PRIMARY KEY,
    repository_id TEXT NULL,
    type TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB NULL,
    error TEXT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    priority INTEGER NOT NULL DEFAULT 50,
    idempotency_key TEXT NULL,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner TEXT NULL,
    lease_token TEXT NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    dead_lettered_at TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL,
    created_by_user_id TEXT NULL,
    created_by_name TEXT NOT NULL DEFAULT 'Kosh Operations',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK(state IN ('queued','leased','succeeded','failed','cancelled')),
    CHECK(max_attempts >= 1 AND max_attempts <= 20),
    CHECK(attempt >= 0),
    CHECK(priority >= 0 AND priority <= 100)
  )`;
  await db`ALTER TABLE kosh_ops_jobs ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 50`;
  await db`ALTER TABLE kosh_ops_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT NULL`;
  await db`ALTER TABLE kosh_ops_jobs ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ NULL`;
  await db`ALTER TABLE kosh_ops_jobs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ NULL`;
  await db`CREATE INDEX IF NOT EXISTS kosh_ops_jobs_claim_v2_idx
    ON kosh_ops_jobs(state, priority DESC, available_at, created_at)`;
  await db`CREATE INDEX IF NOT EXISTS kosh_ops_jobs_repo_idx
    ON kosh_ops_jobs(repository_id, created_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS kosh_ops_jobs_dead_letter_idx
    ON kosh_ops_jobs(repository_id, dead_lettered_at DESC)
    WHERE dead_lettered_at IS NOT NULL`;
  await db`CREATE UNIQUE INDEX IF NOT EXISTS kosh_ops_jobs_idempotency_idx
    ON kosh_ops_jobs(COALESCE(repository_id, '__platform__'), idempotency_key)
    WHERE idempotency_key IS NOT NULL`;
  initialized = true;
}

export function koshOpsStoreBackend() {
  return database() ? "postgres" as const : "ephemeral-memory" as const;
}

async function withMemoryClaimLock<T>(run: () => Promise<T>) {
  const previous = memoryClaimLock;
  let release!: () => void;
  memoryClaimLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

function sameScope(item: KoshOpsJob, repositoryId: string | null) {
  return item.repositoryId === repositoryId;
}

function assertMemoryCapacity(repositoryId: string | null) {
  const queued = [...memoryJobs.values()].filter((item) => item.state === "queued");
  if (queued.length >= maxQueuedJobs()) {
    throw Object.assign(new Error("kosh_ops_queue_backpressure"), {
      status: 429,
      retryAfterSeconds: 30,
      queued: queued.length,
      limit: maxQueuedJobs()
    });
  }
  const scoped = queued.filter((item) => sameScope(item, repositoryId)).length;
  if (scoped >= maxRepositoryQueuedJobs()) {
    throw Object.assign(new Error("kosh_ops_repository_queue_backpressure"), {
      status: 429,
      retryAfterSeconds: 30,
      queued: scoped,
      limit: maxRepositoryQueuedJobs()
    });
  }
}

export async function enqueueKoshOpsJob(input: EnqueueInput) {
  const repositoryId = input.repositoryId ?? null;
  const maxAttempts = boundedInteger(input.maxAttempts, 3, 1, 20);
  const priority = boundedInteger(input.priority, 50, 0, 100);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const createdAt = nowIso();

  const createItem = () => ({
    id: randomUUID(),
    repositoryId,
    type: input.type,
    state: "queued" as const,
    payload: clone(input.payload ?? {}),
    result: null,
    error: null,
    attempt: 0,
    maxAttempts,
    priority,
    idempotencyKey,
    availableAt: input.availableAt ?? createdAt,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    deadLetteredAt: null,
    finishedAt: null,
    createdByUserId: input.createdByUserId ?? null,
    createdByName: input.createdByName?.trim() || "Kosh Operations",
    createdAt,
    updatedAt: createdAt
  } satisfies KoshOpsJob);

  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_queue_requires_database"), { status: 503 });
    }
    return withMemoryClaimLock(async () => {
      if (idempotencyKey) {
        const existing = [...memoryJobs.values()].find(
          (item) => sameScope(item, repositoryId) && item.idempotencyKey === idempotencyKey
        );
        if (existing) return clone(existing);
      }
      assertMemoryCapacity(repositoryId);
      const item = createItem();
      memoryJobs.set(item.id, item);
      return clone(item);
    });
  }

  await readyKoshOpsStore();
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('kosh_ops_enqueue'))`;
    if (idempotencyKey) {
      const existing = repositoryId === null
        ? await tx`SELECT * FROM kosh_ops_jobs
            WHERE repository_id IS NULL AND idempotency_key = ${idempotencyKey}
            LIMIT 1`
        : await tx`SELECT * FROM kosh_ops_jobs
            WHERE repository_id = ${repositoryId} AND idempotency_key = ${idempotencyKey}
            LIMIT 1`;
      if (existing[0]) return jobFromRow(existing[0] as Record<string, unknown>);
    }

    const globalRows = await tx`SELECT COUNT(*)::int AS count FROM kosh_ops_jobs WHERE state = 'queued'`;
    const globalQueued = Number(globalRows[0]?.count ?? 0);
    if (globalQueued >= maxQueuedJobs()) {
      throw Object.assign(new Error("kosh_ops_queue_backpressure"), {
        status: 429,
        retryAfterSeconds: 30,
        queued: globalQueued,
        limit: maxQueuedJobs()
      });
    }

    const scopedRows = repositoryId === null
      ? await tx`SELECT COUNT(*)::int AS count FROM kosh_ops_jobs
          WHERE state = 'queued' AND repository_id IS NULL`
      : await tx`SELECT COUNT(*)::int AS count FROM kosh_ops_jobs
          WHERE state = 'queued' AND repository_id = ${repositoryId}`;
    const scopedQueued = Number(scopedRows[0]?.count ?? 0);
    if (scopedQueued >= maxRepositoryQueuedJobs()) {
      throw Object.assign(new Error("kosh_ops_repository_queue_backpressure"), {
        status: 429,
        retryAfterSeconds: 30,
        queued: scopedQueued,
        limit: maxRepositoryQueuedJobs()
      });
    }

    const item = createItem();
    const rows = await tx`
      INSERT INTO kosh_ops_jobs(
        id, repository_id, type, state, payload, max_attempts, priority,
        idempotency_key, available_at, created_by_user_id, created_by_name
      ) VALUES(
        ${item.id}, ${item.repositoryId}, ${item.type}, 'queued', ${JSON.stringify(item.payload)}::jsonb,
        ${item.maxAttempts}, ${item.priority}, ${item.idempotencyKey}, ${item.availableAt},
        ${item.createdByUserId}, ${item.createdByName}
      )
      RETURNING *
    `;
    return jobFromRow(rows[0] as Record<string, unknown>);
  });
}

function recoverExpiredMemoryLeases() {
  const now = Date.now();
  for (const job of memoryJobs.values()) {
    if (
      job.state === "leased" &&
      job.leaseExpiresAt &&
      new Date(job.leaseExpiresAt).getTime() <= now
    ) {
      const terminal = job.attempt >= job.maxAttempts;
      job.state = terminal ? "failed" : "queued";
      job.error = "operation_lease_expired";
      job.leaseOwner = null;
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.deadLetteredAt = terminal ? nowIso() : null;
      job.finishedAt = terminal ? nowIso() : null;
      job.availableAt = terminal
        ? job.availableAt
        : new Date(now + Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempt - 1))).toISOString();
      job.updatedAt = nowIso();
    }
  }
}

export async function claimKoshOpsJob(workerId: string) {
  const owner = workerId.trim().slice(0, 160);
  if (!owner) throw new Error("worker_id_required");
  const db = database();
  if (!db) {
    return withMemoryClaimLock(async () => {
      recoverExpiredMemoryLeases();
      const now = Date.now();
      const job = [...memoryJobs.values()]
        .filter((item) => item.state === "queued" && new Date(item.availableAt).getTime() <= now)
        .sort((a, b) => b.priority - a.priority || a.availableAt.localeCompare(b.availableAt) || a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return null;
      job.state = "leased";
      job.attempt += 1;
      job.leaseOwner = owner;
      job.leaseToken = randomBytes(24).toString("base64url");
      job.leaseExpiresAt = new Date(Date.now() + leaseMs()).toISOString();
      job.deadLetteredAt = null;
      job.finishedAt = null;
      job.updatedAt = nowIso();
      return clone(job);
    });
  }

  await readyKoshOpsStore();
  return db.begin(async (tx) => {
    await tx`UPDATE kosh_ops_jobs
      SET state = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'queued' END,
          error = 'operation_lease_expired',
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          dead_lettered_at = CASE WHEN attempt >= max_attempts THEN NOW() ELSE NULL END,
          finished_at = CASE WHEN attempt >= max_attempts THEN NOW() ELSE NULL END,
          available_at = CASE
            WHEN attempt >= max_attempts THEN available_at
            ELSE NOW() + LEAST(INTERVAL '60 seconds', INTERVAL '1 second' * POWER(2, GREATEST(0, attempt - 1)))
          END,
          updated_at = NOW()
      WHERE state = 'leased' AND lease_expires_at <= NOW()`;

    const rows = await tx`
      SELECT * FROM kosh_ops_jobs
      WHERE state = 'queued' AND available_at <= NOW()
      ORDER BY priority DESC, available_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!rows[0]) return null;
    const id = String(rows[0].id);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + leaseMs()).toISOString();
    const claimed = await tx`
      UPDATE kosh_ops_jobs
      SET state = 'leased', attempt = attempt + 1,
          lease_owner = ${owner}, lease_token = ${token}, lease_expires_at = ${expiresAt},
          dead_lettered_at = NULL, finished_at = NULL, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return jobFromRow(claimed[0] as Record<string, unknown>);
  });
}

export async function heartbeatKoshOpsJob(id: string, leaseToken: string) {
  const db = database();
  const expiresAt = new Date(Date.now() + leaseMs()).toISOString();
  if (!db) {
    const item = memoryJobs.get(id);
    if (!item || item.state !== "leased" || item.leaseToken !== leaseToken) return false;
    item.leaseExpiresAt = expiresAt;
    item.updatedAt = nowIso();
    return true;
  }
  await readyKoshOpsStore();
  const rows = await db`
    UPDATE kosh_ops_jobs
    SET lease_expires_at = ${expiresAt}, updated_at = NOW()
    WHERE id = ${id} AND state = 'leased' AND lease_token = ${leaseToken}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function completeKoshOpsJob(
  id: string,
  leaseToken: string,
  result: Record<string, unknown>
) {
  const db = database();
  if (!db) {
    const item = memoryJobs.get(id);
    if (!item || item.state !== "leased" || item.leaseToken !== leaseToken) return false;
    item.state = "succeeded";
    item.result = clone(result);
    item.error = null;
    item.leaseOwner = null;
    item.leaseToken = null;
    item.leaseExpiresAt = null;
    item.deadLetteredAt = null;
    item.finishedAt = nowIso();
    item.updatedAt = nowIso();
    return true;
  }
  await readyKoshOpsStore();
  const rows = await db`
    UPDATE kosh_ops_jobs
    SET state = 'succeeded', result = ${JSON.stringify(result)}::jsonb, error = NULL,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        dead_lettered_at = NULL, finished_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND state = 'leased' AND lease_token = ${leaseToken}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function failKoshOpsJob(id: string, leaseToken: string, error: string) {
  const message = error.slice(0, 4000);
  const db = database();
  if (!db) {
    const item = memoryJobs.get(id);
    if (!item || item.state !== "leased" || item.leaseToken !== leaseToken) return false;
    const terminal = item.attempt >= item.maxAttempts;
    item.state = terminal ? "failed" : "queued";
    item.error = message;
    item.availableAt = terminal
      ? item.availableAt
      : new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.max(0, item.attempt - 1))).toISOString();
    item.leaseOwner = null;
    item.leaseToken = null;
    item.leaseExpiresAt = null;
    item.deadLetteredAt = terminal ? nowIso() : null;
    item.finishedAt = terminal ? nowIso() : null;
    item.updatedAt = nowIso();
    return true;
  }
  await readyKoshOpsStore();
  const rows = await db`
    UPDATE kosh_ops_jobs
    SET state = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'queued' END,
        error = ${message},
        available_at = CASE WHEN attempt >= max_attempts THEN available_at
          ELSE NOW() + LEAST(INTERVAL '60 seconds', INTERVAL '1 second' * POWER(2, GREATEST(0, attempt - 1))) END,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
        dead_lettered_at = CASE WHEN attempt >= max_attempts THEN NOW() ELSE NULL END,
        finished_at = CASE WHEN attempt >= max_attempts THEN NOW() ELSE NULL END,
        updated_at = NOW()
    WHERE id = ${id} AND state = 'leased' AND lease_token = ${leaseToken}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function cancelKoshOpsJob(id: string) {
  const db = database();
  if (!db) {
    const item = memoryJobs.get(id);
    if (!item || !["queued", "leased"].includes(item.state)) return false;
    item.state = "cancelled";
    item.leaseOwner = null;
    item.leaseToken = null;
    item.leaseExpiresAt = null;
    item.deadLetteredAt = null;
    item.finishedAt = nowIso();
    item.updatedAt = nowIso();
    return true;
  }
  await readyKoshOpsStore();
  const rows = await db`
    UPDATE kosh_ops_jobs
    SET state = 'cancelled', lease_owner = NULL, lease_token = NULL,
        lease_expires_at = NULL, dead_lettered_at = NULL, finished_at = NOW(), updated_at = NOW()
    WHERE id = ${id} AND state IN ('queued','leased')
    RETURNING id
  `;
  return rows.length > 0;
}

export async function requeueKoshOpsJob(id: string) {
  const db = database();
  if (!db) {
    return withMemoryClaimLock(async () => {
      const item = memoryJobs.get(id);
      if (!item || item.state !== "failed") return false;
      assertMemoryCapacity(item.repositoryId);
      item.state = "queued";
      item.attempt = 0;
      item.error = null;
      item.result = null;
      item.availableAt = nowIso();
      item.leaseOwner = null;
      item.leaseToken = null;
      item.leaseExpiresAt = null;
      item.deadLetteredAt = null;
      item.finishedAt = null;
      item.updatedAt = nowIso();
      return true;
    });
  }
  await readyKoshOpsStore();
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('kosh_ops_enqueue'))`;
    const targetRows = await tx`SELECT repository_id FROM kosh_ops_jobs WHERE id = ${id} AND state = 'failed' LIMIT 1`;
    if (!targetRows[0]) return false;
    const repositoryId = targetRows[0].repository_id == null ? null : String(targetRows[0].repository_id);
    const globalRows = await tx`SELECT COUNT(*)::int AS count FROM kosh_ops_jobs WHERE state = 'queued'`;
    if (Number(globalRows[0]?.count ?? 0) >= maxQueuedJobs()) {
      throw Object.assign(new Error("kosh_ops_queue_backpressure"), { status: 429, retryAfterSeconds: 30 });
    }
    const scopedRows = repositoryId === null
      ? await tx`SELECT COUNT(*)::int AS count FROM kosh_ops_jobs WHERE state = 'queued' AND repository_id IS NULL`
      : await tx`SELECT COUNT(*)::int AS count FROM kosh_ops_jobs WHERE state = 'queued' AND repository_id = ${repositoryId}`;
    if (Number(scopedRows[0]?.count ?? 0) >= maxRepositoryQueuedJobs()) {
      throw Object.assign(new Error("kosh_ops_repository_queue_backpressure"), { status: 429, retryAfterSeconds: 30 });
    }
    const rows = await tx`
      UPDATE kosh_ops_jobs
      SET state = 'queued', attempt = 0, error = NULL, result = NULL,
          available_at = NOW(), lease_owner = NULL, lease_token = NULL,
          lease_expires_at = NULL, dead_lettered_at = NULL, finished_at = NULL,
          updated_at = NOW()
      WHERE id = ${id} AND state = 'failed'
      RETURNING id
    `;
    return rows.length > 0;
  });
}

export async function getKoshOpsJob(id: string) {
  const db = database();
  if (!db) {
    const item = memoryJobs.get(id);
    return item ? clone(item) : null;
  }
  await readyKoshOpsStore();
  const rows = await db`SELECT * FROM kosh_ops_jobs WHERE id = ${id} LIMIT 1`;
  return rows[0] ? jobFromRow(rows[0] as Record<string, unknown>) : null;
}

export async function listKoshOpsJobs(repositoryId?: string | null, limit = 100) {
  const take = Math.max(1, Math.min(1000, Math.floor(limit)));
  const db = database();
  if (!db) {
    recoverExpiredMemoryLeases();
    return [...memoryJobs.values()]
      .filter((item) => repositoryId === undefined || item.repositoryId === repositoryId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, take)
      .map(clone);
  }
  await readyKoshOpsStore();
  const rows = repositoryId === undefined
    ? await db`SELECT * FROM kosh_ops_jobs ORDER BY created_at DESC LIMIT ${take}`
    : repositoryId === null
      ? await db`SELECT * FROM kosh_ops_jobs WHERE repository_id IS NULL ORDER BY created_at DESC LIMIT ${take}`
      : await db`SELECT * FROM kosh_ops_jobs WHERE repository_id = ${repositoryId} ORDER BY created_at DESC LIMIT ${take}`;
  return rows.map((row) => jobFromRow(row as Record<string, unknown>));
}

function queueStatsFromItems(items: KoshOpsJob[]) {
  const now = Date.now();
  const byState = Object.fromEntries(
    ["queued", "leased", "succeeded", "failed", "cancelled"].map((state) => [
      state,
      items.filter((item) => item.state === state).length
    ])
  );
  const queued = items.filter((item) => item.state === "queued");
  const oldestQueued = queued.reduce((oldest, item) => Math.min(oldest, new Date(item.createdAt).getTime()), now);
  return {
    backend: koshOpsStoreBackend(),
    total: items.length,
    byState,
    deadLettered: items.filter((item) => item.deadLetteredAt).length,
    retrying: queued.filter((item) => item.attempt > 0).length,
    oldestQueuedAgeMs: queued.length ? Math.max(0, now - oldestQueued) : 0,
    queuedByPriority: {
      high: queued.filter((item) => item.priority >= 75).length,
      normal: queued.filter((item) => item.priority >= 25 && item.priority < 75).length,
      low: queued.filter((item) => item.priority < 25).length
    },
    throughput: {
      lastHour: items.filter((item) => item.state === "succeeded" && new Date(item.finishedAt ?? item.updatedAt).getTime() >= now - 60 * 60_000).length,
      last24Hours: items.filter((item) => item.state === "succeeded" && new Date(item.finishedAt ?? item.updatedAt).getTime() >= now - 24 * 60 * 60_000).length
    },
    limits: {
      globalQueued: maxQueuedJobs(),
      repositoryQueued: maxRepositoryQueuedJobs()
    }
  };
}

export async function getKoshOpsQueueStats(repositoryId?: string | null) {
  const db = database();
  if (!db) {
    recoverExpiredMemoryLeases();
    const items = [...memoryJobs.values()].filter(
      (item) => repositoryId === undefined || item.repositoryId === repositoryId
    );
    return queueStatsFromItems(items);
  }
  await readyKoshOpsStore();
  const rows = repositoryId === undefined
    ? await db`SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
        COUNT(*) FILTER (WHERE state = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
        COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
        COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 75)::int AS high_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 25 AND priority < 75)::int AS normal_priority,
        COUNT(*) FILTER (WHERE state = 'queued' AND priority < 25)::int AS low_priority,
        COUNT(*) FILTER (WHERE state = 'succeeded' AND COALESCE(finished_at, updated_at) >= NOW() - INTERVAL '1 hour')::int AS throughput_hour,
        COUNT(*) FILTER (WHERE state = 'succeeded' AND COALESCE(finished_at, updated_at) >= NOW() - INTERVAL '24 hours')::int AS throughput_day,
        COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
      FROM kosh_ops_jobs`
    : repositoryId === null
      ? await db`SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
          COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
          COUNT(*) FILTER (WHERE state = 'succeeded')::int AS succeeded,
          COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
          COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
          COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 75)::int AS high_priority,
          COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 25 AND priority < 75)::int AS normal_priority,
          COUNT(*) FILTER (WHERE state = 'queued' AND priority < 25)::int AS low_priority,
          COUNT(*) FILTER (WHERE state = 'succeeded' AND COALESCE(finished_at, updated_at) >= NOW() - INTERVAL '1 hour')::int AS throughput_hour,
          COUNT(*) FILTER (WHERE state = 'succeeded' AND COALESCE(finished_at, updated_at) >= NOW() - INTERVAL '24 hours')::int AS throughput_day,
          COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
        FROM kosh_ops_jobs WHERE repository_id IS NULL`
      : await db`SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE state = 'queued')::int AS queued,
          COUNT(*) FILTER (WHERE state = 'leased')::int AS leased,
          COUNT(*) FILTER (WHERE state = 'succeeded')::int AS succeeded,
          COUNT(*) FILTER (WHERE state = 'failed')::int AS failed,
          COUNT(*) FILTER (WHERE state = 'cancelled')::int AS cancelled,
          COUNT(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_lettered,
          COUNT(*) FILTER (WHERE state = 'queued' AND attempt > 0)::int AS retrying,
          COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 75)::int AS high_priority,
          COUNT(*) FILTER (WHERE state = 'queued' AND priority >= 25 AND priority < 75)::int AS normal_priority,
          COUNT(*) FILTER (WHERE state = 'queued' AND priority < 25)::int AS low_priority,
          COUNT(*) FILTER (WHERE state = 'succeeded' AND COALESCE(finished_at, updated_at) >= NOW() - INTERVAL '1 hour')::int AS throughput_hour,
          COUNT(*) FILTER (WHERE state = 'succeeded' AND COALESCE(finished_at, updated_at) >= NOW() - INTERVAL '24 hours')::int AS throughput_day,
          COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE state = 'queued'))) * 1000, 0) AS oldest_queued_ms
        FROM kosh_ops_jobs WHERE repository_id = ${repositoryId}`;
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  return {
    backend: koshOpsStoreBackend(),
    total: Number(row.total ?? 0),
    byState: {
      queued: Number(row.queued ?? 0),
      leased: Number(row.leased ?? 0),
      succeeded: Number(row.succeeded ?? 0),
      failed: Number(row.failed ?? 0),
      cancelled: Number(row.cancelled ?? 0)
    },
    deadLettered: Number(row.dead_lettered ?? 0),
    retrying: Number(row.retrying ?? 0),
    oldestQueuedAgeMs: Math.max(0, Number(row.oldest_queued_ms ?? 0)),
    queuedByPriority: {
      high: Number(row.high_priority ?? 0),
      normal: Number(row.normal_priority ?? 0),
      low: Number(row.low_priority ?? 0)
    },
    throughput: {
      lastHour: Number(row.throughput_hour ?? 0),
      last24Hours: Number(row.throughput_day ?? 0)
    },
    limits: {
      globalQueued: maxQueuedJobs(),
      repositoryQueued: maxRepositoryQueuedJobs()
    }
  };
}