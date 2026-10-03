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
  availableAt: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
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

function leaseMs() {
  const seconds = Number(process.env.KOSH_OPS_LEASE_SECONDS ?? 120);
  return Math.max(30, Math.min(1800, Number.isFinite(seconds) ? seconds : 120)) * 1000;
}

function nowIso() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
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
  const timestamp = (value: unknown) => value ? new Date(String(value)).toISOString() : null;
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
    availableAt: timestamp(row.available_at) ?? nowIso(),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseExpiresAt: timestamp(row.lease_expires_at),
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
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner TEXT NULL,
    lease_token TEXT NULL,
    lease_expires_at TIMESTAMPTZ NULL,
    created_by_user_id TEXT NULL,
    created_by_name TEXT NOT NULL DEFAULT 'Kosh Operations',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK(state IN ('queued','leased','succeeded','failed','cancelled')),
    CHECK(max_attempts >= 1 AND max_attempts <= 20),
    CHECK(attempt >= 0)
  )`;
  await db`CREATE INDEX IF NOT EXISTS kosh_ops_jobs_claim_idx
    ON kosh_ops_jobs(state, available_at, created_at)`;
  await db`CREATE INDEX IF NOT EXISTS kosh_ops_jobs_repo_idx
    ON kosh_ops_jobs(repository_id, created_at DESC)`;
  initialized = true;
}

export function koshOpsStoreBackend() {
  return database() ? "postgres" as const : "ephemeral-memory" as const;
}

export async function enqueueKoshOpsJob(input: EnqueueInput) {
  const maxAttempts = Math.max(1, Math.min(20, Math.floor(input.maxAttempts ?? 3)));
  const id = randomUUID();
  const createdAt = nowIso();
  const item: KoshOpsJob = {
    id,
    repositoryId: input.repositoryId ?? null,
    type: input.type,
    state: "queued",
    payload: clone(input.payload ?? {}),
    result: null,
    error: null,
    attempt: 0,
    maxAttempts,
    availableAt: input.availableAt ?? createdAt,
    leaseOwner: null,
    leaseToken: null,
    leaseExpiresAt: null,
    createdByUserId: input.createdByUserId ?? null,
    createdByName: input.createdByName?.trim() || "Kosh Operations",
    createdAt,
    updatedAt: createdAt
  };

  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_queue_requires_database"), { status: 503 });
    }
    memoryJobs.set(id, item);
    return clone(item);
  }
  await readyKoshOpsStore();
  const rows = await db`
    INSERT INTO kosh_ops_jobs(
      id, repository_id, type, state, payload, max_attempts, available_at,
      created_by_user_id, created_by_name
    ) VALUES(
      ${id}, ${item.repositoryId}, ${item.type}, 'queued', ${JSON.stringify(item.payload)}::jsonb,
      ${item.maxAttempts}, ${item.availableAt}, ${item.createdByUserId}, ${item.createdByName}
    )
    RETURNING *
  `;
  return jobFromRow(rows[0] as Record<string, unknown>);
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

function recoverExpiredMemoryLeases() {
  const now = Date.now();
  for (const job of memoryJobs.values()) {
    if (
      job.state === "leased" &&
      job.leaseExpiresAt &&
      new Date(job.leaseExpiresAt).getTime() <= now
    ) {
      job.state = job.attempt >= job.maxAttempts ? "failed" : "queued";
      job.error = "operation_lease_expired";
      job.leaseOwner = null;
      job.leaseToken = null;
      job.leaseExpiresAt = null;
      job.availableAt = new Date(now + Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempt - 1))).toISOString();
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
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return null;
      job.state = "leased";
      job.attempt += 1;
      job.leaseOwner = owner;
      job.leaseToken = randomBytes(24).toString("base64url");
      job.leaseExpiresAt = new Date(Date.now() + leaseMs()).toISOString();
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
          available_at = CASE
            WHEN attempt >= max_attempts THEN available_at
            ELSE NOW() + LEAST(INTERVAL '60 seconds', INTERVAL '1 second' * POWER(2, GREATEST(0, attempt - 1)))
          END,
          updated_at = NOW()
      WHERE state = 'leased' AND lease_expires_at <= NOW()`;

    const rows = await tx`
      SELECT * FROM kosh_ops_jobs
      WHERE state = 'queued' AND available_at <= NOW()
      ORDER BY available_at ASC, created_at ASC
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
          updated_at = NOW()
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
    item.updatedAt = nowIso();
    return true;
  }
  await readyKoshOpsStore();
  const rows = await db`
    UPDATE kosh_ops_jobs
    SET state = 'succeeded', result = ${JSON.stringify(result)}::jsonb, error = NULL,
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
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
        lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
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
    item.updatedAt = nowIso();
    return true;
  }
  await readyKoshOpsStore();
  const rows = await db`
    UPDATE kosh_ops_jobs
    SET state = 'cancelled', lease_owner = NULL, lease_token = NULL,
        lease_expires_at = NULL, updated_at = NOW()
    WHERE id = ${id} AND state IN ('queued','leased')
    RETURNING id
  `;
  return rows.length > 0;
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