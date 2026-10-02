import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshDevEnvironmentState =
  | "queued"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "expired";

export type StoredKoshDevEnvironment = {
  id: string;
  repositoryId: string;
  namespace: string;
  repositorySlug: string;
  name: string;
  refName: string;
  commitSha: string;
  image: string;
  network: "none" | "egress";
  cpu: number;
  memoryMb: number;
  pidsLimit: number;
  ttlMinutes: number;
  idleMinutes: number;
  command: string;
  state: KoshDevEnvironmentState;
  runnerId: string | null;
  containerId: string | null;
  leaseHash: string | null;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  expiresAt: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  failureReason: string | null;
};

export interface KoshDevEnvironmentStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  create(input: Omit<StoredKoshDevEnvironment, "id" | "state" | "runnerId" | "containerId" | "leaseHash" | "leaseExpiresAt" | "lastHeartbeatAt" | "createdAt" | "updatedAt" | "failureReason">): Promise<StoredKoshDevEnvironment>;
  get(id: string): Promise<StoredKoshDevEnvironment | null>;
  list(repositoryId: string): Promise<StoredKoshDevEnvironment[]>;
  requestStop(id: string): Promise<StoredKoshDevEnvironment | null>;
  claim(runnerId: string, leaseSeconds: number): Promise<{ environment: StoredKoshDevEnvironment; leaseToken: string } | null>;
  heartbeat(id: string, runnerId: string, leaseToken: string, containerId?: string | null): Promise<StoredKoshDevEnvironment | null>;
  complete(id: string, runnerId: string, leaseToken: string, state: "stopped" | "failed" | "expired", failureReason?: string | null): Promise<StoredKoshDevEnvironment | null>;
}

function now() { return new Date().toISOString(); }
function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
function token() { return "kosh_env_" + randomBytes(32).toString("base64url"); }
function clone<T>(value: T): T { return structuredClone(value); }

class MemoryStore implements KoshDevEnvironmentStore {
  readonly kind = "ephemeral-memory" as const;
  private items = new Map<string, StoredKoshDevEnvironment>();
  async ready() {}
  async create(input: Omit<StoredKoshDevEnvironment, "id" | "state" | "runnerId" | "containerId" | "leaseHash" | "leaseExpiresAt" | "lastHeartbeatAt" | "createdAt" | "updatedAt" | "failureReason">) {
    const timestamp = now();
    const value: StoredKoshDevEnvironment = { ...input, id: randomUUID(), state: "queued", runnerId: null, containerId: null, leaseHash: null, leaseExpiresAt: null, lastHeartbeatAt: null, createdAt: timestamp, updatedAt: timestamp, failureReason: null };
    this.items.set(value.id, value);
    return clone(value);
  }
  async get(id: string) { const value = this.items.get(id); return value ? clone(value) : null; }
  async list(repositoryId: string) {
    return [...this.items.values()].filter((x) => x.repositoryId === repositoryId).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }
  async requestStop(id: string) {
    const value = this.items.get(id);
    if (!value) return null;
    if (["stopped","failed","expired"].includes(value.state)) return clone(value);
    value.state = value.state === "queued" ? "stopped" : "stopping";
    value.updatedAt = now();
    this.items.set(id, value);
    return clone(value);
  }
  async claim(runnerId: string, leaseSeconds: number) {
    const timestamp = Date.now();
    for (const value of this.items.values()) {
      if (new Date(value.expiresAt).getTime() <= timestamp && !["stopped","failed","expired"].includes(value.state)) {
        value.state = "expired"; value.updatedAt = now(); continue;
      }
      if (value.state !== "queued") continue;
      const leaseToken = token();
      value.state = "starting";
      value.runnerId = runnerId;
      value.leaseHash = hash(leaseToken);
      value.leaseExpiresAt = new Date(timestamp + leaseSeconds * 1000).toISOString();
      value.lastHeartbeatAt = now();
      value.updatedAt = now();
      return { environment: clone(value), leaseToken };
    }
    return null;
  }
  async heartbeat(id: string, runnerId: string, leaseToken: string, containerId?: string | null) {
    const value = this.items.get(id);
    if (!value || value.runnerId !== runnerId || value.leaseHash !== hash(leaseToken)) return null;
    if (!value.leaseExpiresAt || new Date(value.leaseExpiresAt).getTime() <= Date.now()) return null;
    value.state = value.state === "starting" ? "running" : value.state;
    value.containerId = containerId ?? value.containerId;
    value.lastHeartbeatAt = now();
    value.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    value.updatedAt = now();
    return clone(value);
  }
  async complete(id: string, runnerId: string, leaseToken: string, state: "stopped" | "failed" | "expired", failureReason?: string | null) {
    const value = this.items.get(id);
    if (!value || value.runnerId !== runnerId || value.leaseHash !== hash(leaseToken)) return null;
    value.state = state; value.failureReason = failureReason ?? null; value.leaseHash = null; value.leaseExpiresAt = null; value.updatedAt = now();
    return clone(value);
  }
}

function fromRow(row: Record<string, unknown>): StoredKoshDevEnvironment {
  const iso = (v: unknown) => v ? new Date(String(v)).toISOString() : null;
  return {
    id: String(row.id), repositoryId: String(row.repository_id), namespace: String(row.namespace), repositorySlug: String(row.repository_slug),
    name: String(row.name), refName: String(row.ref_name), commitSha: String(row.commit_sha), image: String(row.image),
    network: String(row.network) as "none"|"egress", cpu: Number(row.cpu), memoryMb: Number(row.memory_mb), pidsLimit: Number(row.pids_limit),
    ttlMinutes: Number(row.ttl_minutes), idleMinutes: Number(row.idle_minutes), command: String(row.command), state: String(row.state) as KoshDevEnvironmentState,
    runnerId: row.runner_id ? String(row.runner_id) : null, containerId: row.container_id ? String(row.container_id) : null,
    leaseHash: row.lease_hash ? String(row.lease_hash) : null, leaseExpiresAt: iso(row.lease_expires_at), lastHeartbeatAt: iso(row.last_heartbeat_at),
    expiresAt: iso(row.expires_at)!, createdByUserId: String(row.created_by_user_id), createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!, failureReason: row.failure_reason ? String(row.failure_reason) : null
  };
}

class PostgresStore implements KoshDevEnvironmentStore {
  readonly kind = "postgres" as const;
  private initialized = false;
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  async ready() {
    if (this.initialized) return;
    await this.sql`CREATE TABLE IF NOT EXISTS kosh_dev_environments (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      repository_slug TEXT NOT NULL,
      name TEXT NOT NULL,
      ref_name TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      image TEXT NOT NULL,
      network TEXT NOT NULL,
      cpu DOUBLE PRECISION NOT NULL,
      memory_mb INTEGER NOT NULL,
      pids_limit INTEGER NOT NULL,
      ttl_minutes INTEGER NOT NULL,
      idle_minutes INTEGER NOT NULL,
      command TEXT NOT NULL,
      state TEXT NOT NULL,
      runner_id TEXT,
      container_id TEXT,
      lease_hash TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_heartbeat_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(network IN ('none','egress')),
      CHECK(state IN ('queued','starting','running','stopping','stopped','failed','expired'))
    )`;
    await this.sql`CREATE INDEX IF NOT EXISTS kosh_dev_env_repo_idx ON kosh_dev_environments(repository_id, created_at DESC)`;
    await this.sql`CREATE INDEX IF NOT EXISTS kosh_dev_env_claim_idx ON kosh_dev_environments(state, created_at)`;
    this.initialized = true;
  }
  async create(input: Omit<StoredKoshDevEnvironment, "id" | "state" | "runnerId" | "containerId" | "leaseHash" | "leaseExpiresAt" | "lastHeartbeatAt" | "createdAt" | "updatedAt" | "failureReason">) {
    await this.ready();
    const rows = await this.sql`INSERT INTO kosh_dev_environments(
      id, repository_id, namespace, repository_slug, name, ref_name, commit_sha, image, network, cpu, memory_mb, pids_limit,
      ttl_minutes, idle_minutes, command, state, expires_at, created_by_user_id, created_by_name
    ) VALUES(
      ${randomUUID()}, ${input.repositoryId}, ${input.namespace}, ${input.repositorySlug}, ${input.name}, ${input.refName}, ${input.commitSha},
      ${input.image}, ${input.network}, ${input.cpu}, ${input.memoryMb}, ${input.pidsLimit}, ${input.ttlMinutes}, ${input.idleMinutes},
      ${input.command}, 'queued', ${input.expiresAt}, ${input.createdByUserId}, ${input.createdByName}
    ) RETURNING *`;
    return fromRow(rows[0] as Record<string, unknown>);
  }
  async get(id: string) { await this.ready(); const rows = await this.sql`SELECT * FROM kosh_dev_environments WHERE id=${id} LIMIT 1`; return rows[0] ? fromRow(rows[0] as Record<string, unknown>) : null; }
  async list(repositoryId: string) { await this.ready(); const rows = await this.sql`SELECT * FROM kosh_dev_environments WHERE repository_id=${repositoryId} ORDER BY created_at DESC LIMIT 500`; return rows.map((r)=>fromRow(r as Record<string, unknown>)); }
  async requestStop(id: string) {
    await this.ready();
    const rows = await this.sql`UPDATE kosh_dev_environments SET state = CASE WHEN state='queued' THEN 'stopped' ELSE 'stopping' END, updated_at=NOW()
      WHERE id=${id} AND state NOT IN ('stopped','failed','expired') RETURNING *`;
    return rows[0] ? fromRow(rows[0] as Record<string, unknown>) : this.get(id);
  }
  async claim(runnerId: string, leaseSeconds: number) {
    await this.ready();
    const leaseToken = token();
    const leaseHash = hash(leaseToken);
    const rows = await this.sql`
      WITH candidate AS (
        SELECT id FROM kosh_dev_environments
        WHERE state='queued' AND expires_at > NOW()
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE kosh_dev_environments e
      SET state='starting', runner_id=${runnerId}, lease_hash=${leaseHash},
          lease_expires_at=NOW() + (${leaseSeconds} * INTERVAL '1 second'),
          last_heartbeat_at=NOW(), updated_at=NOW()
      FROM candidate WHERE e.id=candidate.id
      RETURNING e.*
    `;
    return rows[0] ? { environment: fromRow(rows[0] as Record<string, unknown>), leaseToken } : null;
  }
  async heartbeat(id: string, runnerId: string, leaseToken: string, containerId?: string | null) {
    await this.ready();
    const rows = await this.sql`UPDATE kosh_dev_environments SET
      state = CASE WHEN state='starting' THEN 'running' ELSE state END,
      container_id = COALESCE(${containerId ?? null}, container_id),
      last_heartbeat_at=NOW(), lease_expires_at=NOW()+INTERVAL '60 seconds', updated_at=NOW()
      WHERE id=${id} AND runner_id=${runnerId} AND lease_hash=${hash(leaseToken)} AND lease_expires_at > NOW()
      RETURNING *`;
    return rows[0] ? fromRow(rows[0] as Record<string, unknown>) : null;
  }
  async complete(id: string, runnerId: string, leaseToken: string, state: "stopped"|"failed"|"expired", failureReason?: string | null) {
    await this.ready();
    const rows = await this.sql`UPDATE kosh_dev_environments SET state=${state}, failure_reason=${failureReason ?? null}, lease_hash=NULL, lease_expires_at=NULL, updated_at=NOW()
      WHERE id=${id} AND runner_id=${runnerId} AND lease_hash=${hash(leaseToken)} RETURNING *`;
    return rows[0] ? fromRow(rows[0] as Record<string, unknown>) : null;
  }
}

let singleton: KoshDevEnvironmentStore | null = null;
export function getKoshDevEnvironmentStore(): KoshDevEnvironmentStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl ? new PostgresStore(postgres(databaseUrl,{max:5,prepare:false})) : new MemoryStore();
  return singleton;
}
