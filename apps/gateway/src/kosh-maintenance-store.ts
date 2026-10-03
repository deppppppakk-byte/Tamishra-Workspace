import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

export const koshMaintenanceJobKinds = [
  "storage_reconcile",
  "storage_migrate",
  "storage_gc",
  "replication_verify",
  "recovery_drill",
  "database_backup",
  "notification_delivery",
  "pages_domain_maintenance",
  "extension_execute"
] as const;

export type KoshMaintenanceJobKind = typeof koshMaintenanceJobKinds[number];
export type KoshMaintenanceJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type StoredKoshMaintenanceJob = {
  id: string;
  repositoryId: string | null;
  kind: KoshMaintenanceJobKind;
  status: KoshMaintenanceJobStatus;
  priority: number;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type ClaimedKoshMaintenanceJob = StoredKoshMaintenanceJob & {
  leaseToken: string;
};

type EnqueueInput = {
  repositoryId?: string | null;
  kind: KoshMaintenanceJobKind;
  priority?: number;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  maxAttempts?: number;
  availableAt?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function hashLease(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function leaseToken() {
  return "kosh_job_" + randomBytes(32).toString("base64url");
}

function databaseUrl() {
  return process.env.WORKSPACE_DATABASE_URL?.trim() || "";
}

function jobFromRow(row: Record<string, unknown>): StoredKoshMaintenanceJob {
  return {
    id: String(row.id),
    repositoryId: row.repository_id ? String(row.repository_id) : null,
    kind: String(row.kind) as KoshMaintenanceJobKind,
    status: String(row.status) as KoshMaintenanceJobStatus,
    priority: Number(row.priority) || 0,
    payload: (row.payload && typeof row.payload === "object" ? row.payload : {}) as Record<string, unknown>,
    dedupeKey: row.dedupe_key ? String(row.dedupe_key) : null,
    attempts: Number(row.attempts) || 0,
    maxAttempts: Number(row.max_attempts) || 1,
    availableAt: new Date(String(row.available_at)).toISOString(),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)).toISOString() : null,
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : null,
    completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
    lastError: row.last_error ? String(row.last_error) : null,
    result: row.result && typeof row.result === "object" ? row.result as Record<string, unknown> : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

export interface KoshMaintenanceStore {
  readonly kind: "memory" | "postgres";
  ready(): Promise<void>;
  enqueue(input: EnqueueInput): Promise<StoredKoshMaintenanceJob>;
  claim(workerId: string, leaseSeconds?: number): Promise<ClaimedKoshMaintenanceJob | null>;
  heartbeat(id: string, workerId: string, token: string, leaseSeconds?: number): Promise<boolean>;
  finish(
    id: string,
    workerId: string,
    token: string,
    outcome: "succeeded" | "failed",
    result?: Record<string, unknown> | null,
    error?: string | null
  ): Promise<StoredKoshMaintenanceJob | null>;
  list(repositoryId?: string | null, limit?: number): Promise<StoredKoshMaintenanceJob[]>;
  get(id: string): Promise<StoredKoshMaintenanceJob | null>;
}

class MemoryMaintenanceStore implements KoshMaintenanceStore {
  readonly kind = "memory" as const;
  private jobs = new Map<string, StoredKoshMaintenanceJob & { leaseHash: string | null }>();
  private lock = Promise.resolve();

  async ready() {}

  private async serialized<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async enqueue(input: EnqueueInput) {
    return this.serialized(async () => {
      if (input.dedupeKey) {
        const existing = [...this.jobs.values()].find(
          (item) => item.dedupeKey === input.dedupeKey && ["queued", "running"].includes(item.status)
        );
        if (existing) return structuredClone(existing);
      }
      const stamp = nowIso();
      const job: StoredKoshMaintenanceJob & { leaseHash: string | null } = {
        id: randomUUID(),
        repositoryId: input.repositoryId ?? null,
        kind: input.kind,
        status: "queued",
        priority: clamp(Number(input.priority) || 0, -1000, 1000),
        payload: structuredClone(input.payload ?? {}),
        dedupeKey: input.dedupeKey?.slice(0, 240) || null,
        attempts: 0,
        maxAttempts: clamp(Number(input.maxAttempts) || 3, 1, 20),
        availableAt: input.availableAt ? new Date(input.availableAt).toISOString() : stamp,
        leaseOwner: null,
        leaseExpiresAt: null,
        startedAt: null,
        completedAt: null,
        lastError: null,
        result: null,
        createdAt: stamp,
        updatedAt: stamp,
        leaseHash: null
      };
      this.jobs.set(job.id, job);
      return structuredClone(job);
    });
  }

  async claim(workerId: string, leaseSeconds = 300) {
    return this.serialized(async () => {
      const now = Date.now();
      for (const job of this.jobs.values()) {
        if (
          job.status === "running" &&
          job.leaseExpiresAt &&
          new Date(job.leaseExpiresAt).getTime() <= now &&
          job.attempts < job.maxAttempts
        ) {
          job.status = "queued";
          job.leaseOwner = null;
          job.leaseExpiresAt = null;
          job.leaseHash = null;
          job.availableAt = nowIso();
        }
      }
      const job = [...this.jobs.values()]
        .filter((item) => item.status === "queued" && new Date(item.availableAt).getTime() <= now)
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))[0];
      if (!job) return null;
      const token = leaseToken();
      const stamp = nowIso();
      job.status = "running";
      job.attempts += 1;
      job.leaseOwner = workerId;
      job.leaseExpiresAt = new Date(Date.now() + clamp(leaseSeconds, 30, 3600) * 1000).toISOString();
      job.leaseHash = hashLease(token);
      job.startedAt = job.startedAt ?? stamp;
      job.updatedAt = stamp;
      return { ...structuredClone(job), leaseToken: token };
    });
  }

  async heartbeat(id: string, workerId: string, token: string, leaseSeconds = 300) {
    return this.serialized(async () => {
      const job = this.jobs.get(id);
      if (!job || job.status !== "running" || job.leaseOwner !== workerId || job.leaseHash !== hashLease(token)) {
        return false;
      }
      job.leaseExpiresAt = new Date(Date.now() + clamp(leaseSeconds, 30, 3600) * 1000).toISOString();
      job.updatedAt = nowIso();
      return true;
    });
  }

  async finish(
    id: string,
    workerId: string,
    token: string,
    outcome: "succeeded" | "failed",
    result: Record<string, unknown> | null = null,
    error: string | null = null
  ) {
    return this.serialized(async () => {
      const job = this.jobs.get(id);
      if (!job || job.status !== "running" || job.leaseOwner !== workerId || job.leaseHash !== hashLease(token)) {
        return null;
      }
      const stamp = nowIso();
      if (outcome === "failed" && job.attempts < job.maxAttempts) {
        job.status = "queued";
        job.availableAt = new Date(Date.now() + Math.min(300, 2 ** job.attempts * 5) * 1000).toISOString();
      } else {
        job.status = outcome;
        job.completedAt = stamp;
      }
      job.result = result ? structuredClone(result) : null;
      job.lastError = error?.slice(0, 4000) || null;
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
      job.leaseHash = null;
      job.updatedAt = stamp;
      return structuredClone(job);
    });
  }

  async list(repositoryId?: string | null, limit = 100) {
    return [...this.jobs.values()]
      .filter((item) => repositoryId === undefined || item.repositoryId === repositoryId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, clamp(limit, 1, 500))
      .map((item) => structuredClone(item));
  }

  async get(id: string) {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }
}

class PostgresMaintenanceStore implements KoshMaintenanceStore {
  readonly kind = "postgres" as const;
  private sql: ReturnType<typeof postgres>;
  private initialized = false;

  constructor(url: string) {
    this.sql = postgres(url, { max: 5 });
  }

  async ready() {
    if (this.initialized) return;
    await this.sql`
      CREATE TABLE IF NOT EXISTS kosh_maintenance_jobs (
        id uuid PRIMARY KEY,
        repository_id text NULL,
        kind text NOT NULL,
        status text NOT NULL,
        priority integer NOT NULL DEFAULT 0,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        dedupe_key text NULL,
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3,
        available_at timestamptz NOT NULL DEFAULT now(),
        lease_owner text NULL,
        lease_token_hash text NULL,
        lease_expires_at timestamptz NULL,
        started_at timestamptz NULL,
        completed_at timestamptz NULL,
        last_error text NULL,
        result jsonb NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    await this.sql`CREATE INDEX IF NOT EXISTS kosh_maintenance_jobs_queue_idx ON kosh_maintenance_jobs(status, available_at, priority DESC, created_at)`;
    await this.sql`CREATE INDEX IF NOT EXISTS kosh_maintenance_jobs_repo_idx ON kosh_maintenance_jobs(repository_id, created_at DESC)`;
    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS kosh_maintenance_jobs_dedupe_active_idx ON kosh_maintenance_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued','running')`;
    this.initialized = true;
  }

  async enqueue(input: EnqueueInput) {
    await this.ready();
    const id = randomUUID();
    const dedupeKey = input.dedupeKey?.slice(0, 240) || null;
    const rows = await this.sql`
      INSERT INTO kosh_maintenance_jobs (
        id, repository_id, kind, status, priority, payload, dedupe_key,
        max_attempts, available_at, created_at, updated_at
      ) VALUES (
        ${id}, ${input.repositoryId ?? null}, ${input.kind}, 'queued',
        ${clamp(Number(input.priority) || 0, -1000, 1000)},
        ${this.sql.json(input.payload ?? {})}, ${dedupeKey},
        ${clamp(Number(input.maxAttempts) || 3, 1, 20)},
        ${input.availableAt ? new Date(input.availableAt) : new Date()}, now(), now()
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    if (rows[0]) return jobFromRow(rows[0] as Record<string, unknown>);
    if (!dedupeKey) throw new Error("maintenance_job_enqueue_failed");
    const existing = await this.sql`
      SELECT * FROM kosh_maintenance_jobs
      WHERE dedupe_key = ${dedupeKey} AND status IN ('queued','running')
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!existing[0]) throw new Error("maintenance_job_enqueue_failed");
    return jobFromRow(existing[0] as Record<string, unknown>);
  }

  async claim(workerId: string, leaseSeconds = 300) {
    await this.ready();
    const token = leaseToken();
    const tokenHash = hashLease(token);
    const seconds = clamp(leaseSeconds, 30, 3600);
    const rows = await this.sql.begin(async (sql) => {
      await sql`
        UPDATE kosh_maintenance_jobs
        SET status = 'queued', lease_owner = NULL, lease_token_hash = NULL,
            lease_expires_at = NULL, available_at = now(), updated_at = now()
        WHERE status = 'running' AND lease_expires_at <= now() AND attempts < max_attempts
      `;
      return sql`
        WITH candidate AS (
          SELECT id FROM kosh_maintenance_jobs
          WHERE status = 'queued' AND available_at <= now() AND attempts < max_attempts
          ORDER BY priority DESC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE kosh_maintenance_jobs AS job
        SET status = 'running', attempts = job.attempts + 1,
            lease_owner = ${workerId}, lease_token_hash = ${tokenHash},
            lease_expires_at = now() + (${seconds} * interval '1 second'),
            started_at = COALESCE(job.started_at, now()), updated_at = now()
        FROM candidate
        WHERE job.id = candidate.id
        RETURNING job.*
      `;
    });
    if (!rows[0]) return null;
    return { ...jobFromRow(rows[0] as Record<string, unknown>), leaseToken: token };
  }

  async heartbeat(id: string, workerId: string, token: string, leaseSeconds = 300) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_maintenance_jobs
      SET lease_expires_at = now() + (${clamp(leaseSeconds, 30, 3600)} * interval '1 second'), updated_at = now()
      WHERE id = ${id} AND status = 'running' AND lease_owner = ${workerId}
        AND lease_token_hash = ${hashLease(token)}
      RETURNING id
    `;
    return Boolean(rows[0]);
  }

  async finish(
    id: string,
    workerId: string,
    token: string,
    outcome: "succeeded" | "failed",
    result: Record<string, unknown> | null = null,
    error: string | null = null
  ) {
    await this.ready();
    const tokenHash = hashLease(token);
    const current = await this.sql`
      SELECT * FROM kosh_maintenance_jobs
      WHERE id = ${id} AND status = 'running' AND lease_owner = ${workerId}
        AND lease_token_hash = ${tokenHash}
      LIMIT 1
    `;
    if (!current[0]) return null;
    const row = current[0] as Record<string, unknown>;
    const attempts = Number(row.attempts) || 0;
    const maxAttempts = Number(row.max_attempts) || 1;
    const retry = outcome === "failed" && attempts < maxAttempts;
    const delaySeconds = Math.min(300, 2 ** attempts * 5);
    const rows = await this.sql`
      UPDATE kosh_maintenance_jobs
      SET status = ${retry ? "queued" : outcome},
          available_at = ${retry ? new Date(Date.now() + delaySeconds * 1000) : new Date(String(row.available_at))},
          completed_at = ${retry ? null : new Date()},
          result = ${result ? this.sql.json(result) : null},
          last_error = ${error?.slice(0, 4000) || null},
          lease_owner = NULL, lease_token_hash = NULL, lease_expires_at = NULL,
          updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? jobFromRow(rows[0] as Record<string, unknown>) : null;
  }

  async list(repositoryId?: string | null, limit = 100) {
    await this.ready();
    const capped = clamp(limit, 1, 500);
    const rows = repositoryId === undefined
      ? await this.sql`SELECT * FROM kosh_maintenance_jobs ORDER BY created_at DESC LIMIT ${capped}`
      : repositoryId === null
        ? await this.sql`SELECT * FROM kosh_maintenance_jobs WHERE repository_id IS NULL ORDER BY created_at DESC LIMIT ${capped}`
        : await this.sql`SELECT * FROM kosh_maintenance_jobs WHERE repository_id = ${repositoryId} ORDER BY created_at DESC LIMIT ${capped}`;
    return rows.map((row) => jobFromRow(row as Record<string, unknown>));
  }

  async get(id: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_maintenance_jobs WHERE id = ${id} LIMIT 1`;
    return rows[0] ? jobFromRow(rows[0] as Record<string, unknown>) : null;
  }
}

let singleton: KoshMaintenanceStore | null = null;

export function getKoshMaintenanceStore(): KoshMaintenanceStore {
  if (singleton) return singleton;
  const url = databaseUrl();
  if (!url && process.env.NODE_ENV === "production") {
    throw Object.assign(new Error("workspace_database_required_for_maintenance_jobs"), { status: 503 });
  }
  singleton = url ? new PostgresMaintenanceStore(url) : new MemoryMaintenanceStore();
  return singleton;
}
