import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

export type KoshRunnerExecutor = "container" | "host";
export type KoshRunnerStatus = "online" | "draining" | "offline";

export type StoredKoshRunnerNode = {
  id: string;
  executor: KoshRunnerExecutor;
  labels: string[];
  capacity: number;
  activeJobs: number;
  version: string;
  os: string;
  arch: string;
  status: KoshRunnerStatus;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type KoshRunnerCredentialScope = "repository.read";

type StoredRunnerCredential = {
  tokenHash: string;
  jobId: string;
  repositoryId: string;
  scope: KoshRunnerCredentialScope;
  expiresAt: string;
  createdAt: string;
};

export interface KoshRunnerControlStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  heartbeatRunner(input: {
    id: string;
    executor: KoshRunnerExecutor;
    labels: string[];
    capacity: number;
    activeJobs: number;
    version: string;
    os: string;
    arch: string;
    status: KoshRunnerStatus;
  }): Promise<StoredKoshRunnerNode>;
  listRunners(): Promise<StoredKoshRunnerNode[]>;
  issueCredential(input: {
    jobId: string;
    repositoryId: string;
    scope: KoshRunnerCredentialScope;
    ttlSeconds: number;
  }): Promise<{ token: string; expiresAt: string }>;
  authenticateCredential(token: string): Promise<{
    jobId: string;
    repositoryId: string;
    scope: KoshRunnerCredentialScope;
    expiresAt: string;
  } | null>;
  revokeJobCredentials(jobId: string): Promise<void>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function newToken() {
  return "kosh_job_" + randomBytes(32).toString("base64url");
}

function clampCapacity(value: number) {
  return Math.max(1, Math.min(64, Math.floor(value) || 1));
}

class MemoryKoshRunnerControlStore implements KoshRunnerControlStore {
  readonly kind = "ephemeral-memory" as const;
  private runners = new Map<string, StoredKoshRunnerNode>();
  private credentials = new Map<string, StoredRunnerCredential>();

  async ready() {}

  async heartbeatRunner(input: {
    id: string;
    executor: KoshRunnerExecutor;
    labels: string[];
    capacity: number;
    activeJobs: number;
    version: string;
    os: string;
    arch: string;
    status: KoshRunnerStatus;
  }) {
    const current = this.runners.get(input.id);
    const timestamp = now();
    const value: StoredKoshRunnerNode = {
      id: input.id,
      executor: input.executor,
      labels: [...new Set(input.labels)].slice(0, 64),
      capacity: clampCapacity(input.capacity),
      activeJobs: Math.max(
        0,
        Math.min(clampCapacity(input.capacity), Math.floor(input.activeJobs) || 0)
      ),
      version: input.version,
      os: input.os,
      arch: input.arch,
      status: input.status,
      lastSeenAt: timestamp,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.runners.set(value.id, value);
    return clone(value);
  }

  async listRunners() {
    const staleBefore = Date.now() - 120_000;
    return [...this.runners.values()]
      .map((runner) => ({
        ...runner,
        status:
          new Date(runner.lastSeenAt).getTime() < staleBefore
            ? "offline" as const
            : runner.status
      }))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map(clone);
  }

  async issueCredential(input: {
    jobId: string;
    repositoryId: string;
    scope: KoshRunnerCredentialScope;
    ttlSeconds: number;
  }) {
    const token = newToken();
    const expiresAt = new Date(
      Date.now() + Math.max(60, Math.min(1800, input.ttlSeconds)) * 1000
    ).toISOString();
    this.credentials.set(hashToken(token), {
      tokenHash: hashToken(token),
      jobId: input.jobId,
      repositoryId: input.repositoryId,
      scope: input.scope,
      expiresAt,
      createdAt: now()
    });
    return { token, expiresAt };
  }

  async authenticateCredential(token: string) {
    if (!token.startsWith("kosh_job_")) return null;
    const key = hashToken(token);
    const value = this.credentials.get(key);
    if (!value) return null;
    if (new Date(value.expiresAt).getTime() <= Date.now()) {
      this.credentials.delete(key);
      return null;
    }
    return clone({
      jobId: value.jobId,
      repositoryId: value.repositoryId,
      scope: value.scope,
      expiresAt: value.expiresAt
    });
  }

  async revokeJobCredentials(jobId: string) {
    for (const [key, value] of this.credentials) {
      if (value.jobId === jobId) this.credentials.delete(key);
    }
  }
}

function iso(value: unknown) {
  if (!value) return now();
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? now() : date.toISOString();
}

function runnerFromRow(row: Record<string, unknown>): StoredKoshRunnerNode {
  return {
    id: String(row.id),
    executor: String(row.executor) as KoshRunnerExecutor,
    labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
    capacity: Number(row.capacity),
    activeJobs: Number(row.active_jobs),
    version: String(row.version ?? ""),
    os: String(row.os ?? ""),
    arch: String(row.arch ?? ""),
    status: String(row.status) as KoshRunnerStatus,
    lastSeenAt: iso(row.last_seen_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

class PostgresKoshRunnerControlStore implements KoshRunnerControlStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_runner_nodes (
      id TEXT PRIMARY KEY,
      executor TEXT NOT NULL,
      labels JSONB NOT NULL DEFAULT '[]'::jsonb,
      capacity INTEGER NOT NULL DEFAULT 1,
      active_jobs INTEGER NOT NULL DEFAULT 0,
      version TEXT NOT NULL DEFAULT '',
      os TEXT NOT NULL DEFAULT '',
      arch TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'online',
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(executor IN ('container','host')),
      CHECK(status IN ('online','draining','offline'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_runner_nodes_seen_idx
      ON kosh_runner_nodes(last_seen_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_runner_credentials (
      token_hash TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(scope IN ('repository.read'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_runner_credentials_job_idx
      ON kosh_runner_credentials(job_id, expires_at)`;

    this.initialized = true;
  }

  async heartbeatRunner(input: {
    id: string;
    executor: KoshRunnerExecutor;
    labels: string[];
    capacity: number;
    activeJobs: number;
    version: string;
    os: string;
    arch: string;
    status: KoshRunnerStatus;
  }) {
    await this.ready();
    const capacity = clampCapacity(input.capacity);
    const activeJobs = Math.max(
      0,
      Math.min(capacity, Math.floor(input.activeJobs) || 0)
    );
    const rows = await this.sql`
      INSERT INTO kosh_runner_nodes(
        id, executor, labels, capacity, active_jobs,
        version, os, arch, status, last_seen_at
      )
      VALUES(
        ${input.id}, ${input.executor},
        ${JSON.stringify([...new Set(input.labels)].slice(0, 64))}::jsonb,
        ${capacity}, ${activeJobs}, ${input.version}, ${input.os},
        ${input.arch}, ${input.status}, NOW()
      )
      ON CONFLICT(id)
      DO UPDATE SET
        executor = EXCLUDED.executor,
        labels = EXCLUDED.labels,
        capacity = EXCLUDED.capacity,
        active_jobs = EXCLUDED.active_jobs,
        version = EXCLUDED.version,
        os = EXCLUDED.os,
        arch = EXCLUDED.arch,
        status = EXCLUDED.status,
        last_seen_at = NOW(),
        updated_at = NOW()
      RETURNING *
    `;
    return runnerFromRow(rows[0] as Record<string, unknown>);
  }

  async listRunners() {
    await this.ready();
    const rows = await this.sql`
      SELECT
        id, executor, labels, capacity, active_jobs, version, os, arch,
        CASE
          WHEN last_seen_at < NOW() - INTERVAL '120 seconds' THEN 'offline'
          ELSE status
        END AS status,
        last_seen_at, created_at, updated_at
      FROM kosh_runner_nodes
      ORDER BY last_seen_at DESC
      LIMIT 1000
    `;
    return rows.map((row) => runnerFromRow(row as Record<string, unknown>));
  }

  async issueCredential(input: {
    jobId: string;
    repositoryId: string;
    scope: KoshRunnerCredentialScope;
    ttlSeconds: number;
  }) {
    await this.ready();
    const token = newToken();
    const ttl = Math.max(60, Math.min(1800, input.ttlSeconds));
    const rows = await this.sql`
      INSERT INTO kosh_runner_credentials(
        token_hash, job_id, repository_id, scope, expires_at
      )
      VALUES(
        ${hashToken(token)}, ${input.jobId}, ${input.repositoryId},
        ${input.scope}, NOW() + (${ttl} * INTERVAL '1 second')
      )
      RETURNING expires_at
    `;
    return {
      token,
      expiresAt: iso((rows[0] as Record<string, unknown>).expires_at)
    };
  }

  async authenticateCredential(token: string) {
    if (!token.startsWith("kosh_job_")) return null;
    await this.ready();
    const rows = await this.sql`
      SELECT job_id, repository_id, scope, expires_at
      FROM kosh_runner_credentials
      WHERE token_hash = ${hashToken(token)}
        AND expires_at > NOW()
      LIMIT 1
    `;
    if (!rows[0]) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      jobId: String(row.job_id),
      repositoryId: String(row.repository_id),
      scope: String(row.scope) as KoshRunnerCredentialScope,
      expiresAt: iso(row.expires_at)
    };
  }

  async revokeJobCredentials(jobId: string) {
    await this.ready();
    await this.sql`
      DELETE FROM kosh_runner_credentials
      WHERE job_id = ${jobId} OR expires_at <= NOW()
    `;
  }
}

let singleton: KoshRunnerControlStore | null = null;

export function getKoshRunnerControlStore(): KoshRunnerControlStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshRunnerControlStore(
        postgres(databaseUrl, { max: 5, prepare: false })
      )
    : new MemoryKoshRunnerControlStore();
  return singleton;
}
