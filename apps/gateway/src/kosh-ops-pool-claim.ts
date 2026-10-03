import { randomBytes } from "node:crypto";
import postgres from "postgres";
import {
  claimKoshOpsJob,
  type KoshOpsJob,
  type KoshOpsJobType
} from "./kosh-ops-store.js";

export type KoshOpsWorkerPool =
  | "all"
  | "general"
  | "storage"
  | "recovery"
  | "database"
  | "isolated";

export const koshOpsWorkerPools: readonly KoshOpsWorkerPool[] = [
  "all",
  "general",
  "storage",
  "recovery",
  "database",
  "isolated"
];

export const koshOpsPoolJobTypes: Readonly<Record<Exclude<KoshOpsWorkerPool, "all">, readonly KoshOpsJobType[]>> = {
  general: [
    "alerts.evaluate",
    "notification.deliver",
    "pages.domain.verify",
    "secret.rotation.audit"
  ],
  storage: ["storage.lifecycle", "replication.verify"],
  recovery: ["recovery.drill"],
  database: ["database.backup"],
  isolated: ["extension.execute", "load.test", "failure.probe"]
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

function leaseMs() {
  return boundedInteger(process.env.KOSH_OPS_LEASE_SECONDS, 120, 30, 1800) * 1000;
}

function timestamp(value: unknown) {
  return value ? new Date(String(value)).toISOString() : null;
}

function jsonObject(value: unknown) {
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
}

function jobFromRow(row: Record<string, unknown>): KoshOpsJob {
  return {
    id: String(row.id),
    repositoryId: row.repository_id == null ? null : String(row.repository_id),
    type: String(row.type) as KoshOpsJobType,
    state: String(row.state) as KoshOpsJob["state"],
    payload: jsonObject(row.payload),
    result: row.result == null ? null : jsonObject(row.result),
    error: row.error == null ? null : String(row.error),
    attempt: Number(row.attempt) || 0,
    maxAttempts: Number(row.max_attempts) || 1,
    priority: boundedInteger(row.priority, 50, 0, 100),
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
    availableAt: timestamp(row.available_at) ?? new Date().toISOString(),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseExpiresAt: timestamp(row.lease_expires_at),
    deadLetteredAt: timestamp(row.dead_lettered_at),
    finishedAt: timestamp(row.finished_at),
    createdByUserId: row.created_by_user_id == null ? null : String(row.created_by_user_id),
    createdByName: String(row.created_by_name ?? "Kosh Operations"),
    createdAt: timestamp(row.created_at) ?? new Date().toISOString(),
    updatedAt: timestamp(row.updated_at) ?? new Date().toISOString()
  };
}

export function parseKoshOpsWorkerPool(value: unknown): KoshOpsWorkerPool {
  const normalized = String(value ?? "all").trim().toLowerCase();
  return koshOpsWorkerPools.includes(normalized as KoshOpsWorkerPool)
    ? normalized as KoshOpsWorkerPool
    : "all";
}

export function koshOpsPoolSupportsType(pool: KoshOpsWorkerPool, type: KoshOpsJobType) {
  return pool === "all" || koshOpsPoolJobTypes[pool].includes(type);
}

async function recoverExpiredLeases(db: postgres.TransactionSql<{}>) {
  await db`UPDATE kosh_ops_jobs
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
}

async function selectPoolCandidate(
  tx: postgres.TransactionSql<{}>,
  pool: Exclude<KoshOpsWorkerPool, "all">
) {
  if (pool === "general") {
    return tx`SELECT * FROM kosh_ops_jobs
      WHERE state = 'queued' AND available_at <= NOW()
        AND type IN ('alerts.evaluate','notification.deliver','pages.domain.verify','secret.rotation.audit')
      ORDER BY priority DESC, available_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED LIMIT 1`;
  }
  if (pool === "storage") {
    return tx`SELECT * FROM kosh_ops_jobs
      WHERE state = 'queued' AND available_at <= NOW()
        AND type IN ('storage.lifecycle','replication.verify')
      ORDER BY priority DESC, available_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED LIMIT 1`;
  }
  if (pool === "recovery") {
    return tx`SELECT * FROM kosh_ops_jobs
      WHERE state = 'queued' AND available_at <= NOW()
        AND type = 'recovery.drill'
      ORDER BY priority DESC, available_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED LIMIT 1`;
  }
  if (pool === "database") {
    return tx`SELECT * FROM kosh_ops_jobs
      WHERE state = 'queued' AND available_at <= NOW()
        AND type = 'database.backup'
      ORDER BY priority DESC, available_at ASC, created_at ASC
      FOR UPDATE SKIP LOCKED LIMIT 1`;
  }
  return tx`SELECT * FROM kosh_ops_jobs
    WHERE state = 'queued' AND available_at <= NOW()
      AND type IN ('extension.execute','load.test','failure.probe')
    ORDER BY priority DESC, available_at ASC, created_at ASC
    FOR UPDATE SKIP LOCKED LIMIT 1`;
}

export async function claimKoshOpsJobForPool(
  workerId: string,
  pool: KoshOpsWorkerPool
) {
  if (pool === "all") return claimKoshOpsJob(workerId);

  const owner = workerId.trim().slice(0, 160);
  if (!owner) throw new Error("worker_id_required");
  const db = database();
  if (!db) {
    throw Object.assign(new Error("kosh_ops_pool_claim_requires_database"), { status: 503 });
  }

  return db.begin(async (tx) => {
    await recoverExpiredLeases(tx);
    const rows = await selectPoolCandidate(tx, pool);
    if (!rows[0]) return null;

    const id = String(rows[0].id);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + leaseMs()).toISOString();
    const claimed = await tx`
      UPDATE kosh_ops_jobs
      SET state = 'leased', attempt = attempt + 1,
          lease_owner = ${owner}, lease_token = ${token}, lease_expires_at = ${expiresAt},
          dead_lettered_at = NULL, finished_at = NULL, updated_at = NOW()
      WHERE id = ${id} AND state = 'queued'
      RETURNING *
    `;
    return claimed[0] ? jobFromRow(claimed[0] as Record<string, unknown>) : null;
  });
}
