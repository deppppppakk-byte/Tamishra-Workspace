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

export function koshOpsFairSharePolicy() {
  const agingMinutes = boundedInteger(process.env.KOSH_OPS_PRIORITY_AGING_MINUTES, 30, 1, 1440);
  return {
    enabled: process.env.KOSH_OPS_FAIR_SHARE_ENABLED !== "false",
    repositorySoftConcurrency: boundedInteger(
      process.env.KOSH_OPS_REPOSITORY_SOFT_CONCURRENCY,
      4,
      1,
      64
    ),
    priorityBypass: boundedInteger(process.env.KOSH_OPS_FAIR_SHARE_PRIORITY_BYPASS, 95, 1, 100),
    agingSeconds: agingMinutes * 60,
    agingMinutes,
    maxAgingBonus: boundedInteger(process.env.KOSH_OPS_PRIORITY_AGING_MAX_BONUS, 20, 0, 100)
  };
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

async function selectAllCandidate(tx: postgres.TransactionSql<{}>) {
  const policy = koshOpsFairSharePolicy();
  return tx`WITH leased_counts AS (
      SELECT repository_id, COUNT(*)::int AS leased_count
      FROM kosh_ops_jobs
      WHERE state = 'leased'
      GROUP BY repository_id
    )
    SELECT j.* FROM kosh_ops_jobs j
    LEFT JOIN leased_counts l
      ON l.repository_id IS NOT DISTINCT FROM j.repository_id
    WHERE j.state = 'queued' AND j.available_at <= NOW()
    ORDER BY
      CASE
        WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
          THEN CASE WHEN COALESCE(l.leased_count, 0) < ${policy.repositorySoftConcurrency} THEN 0 ELSE 1 END
        ELSE 0
      END ASC,
      CASE
        WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
          THEN COALESCE(l.leased_count, 0)
        ELSE 0
      END ASC,
      (j.priority + CASE
        WHEN ${policy.enabled}
          THEN LEAST(
            ${policy.maxAgingBonus},
            FLOOR(EXTRACT(EPOCH FROM (NOW() - GREATEST(j.created_at, j.available_at))) / ${policy.agingSeconds})
          )
        ELSE 0
      END) DESC,
      j.available_at ASC,
      j.created_at ASC
    FOR UPDATE OF j SKIP LOCKED LIMIT 1`;
}

async function selectGeneralCandidate(tx: postgres.TransactionSql<{}>) {
  const policy = koshOpsFairSharePolicy();
  return tx`WITH leased_counts AS (
      SELECT repository_id, COUNT(*)::int AS leased_count
      FROM kosh_ops_jobs
      WHERE state = 'leased'
        AND type IN ('alerts.evaluate','notification.deliver','pages.domain.verify','secret.rotation.audit')
      GROUP BY repository_id
    )
    SELECT j.* FROM kosh_ops_jobs j
    LEFT JOIN leased_counts l ON l.repository_id IS NOT DISTINCT FROM j.repository_id
    WHERE j.state = 'queued' AND j.available_at <= NOW()
      AND j.type IN ('alerts.evaluate','notification.deliver','pages.domain.verify','secret.rotation.audit')
    ORDER BY
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN CASE WHEN COALESCE(l.leased_count, 0) < ${policy.repositorySoftConcurrency} THEN 0 ELSE 1 END ELSE 0 END ASC,
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN COALESCE(l.leased_count, 0) ELSE 0 END ASC,
      (j.priority + CASE WHEN ${policy.enabled} THEN LEAST(${policy.maxAgingBonus}, FLOOR(EXTRACT(EPOCH FROM (NOW() - GREATEST(j.created_at, j.available_at))) / ${policy.agingSeconds})) ELSE 0 END) DESC,
      j.available_at ASC, j.created_at ASC
    FOR UPDATE OF j SKIP LOCKED LIMIT 1`;
}

async function selectStorageCandidate(tx: postgres.TransactionSql<{}>) {
  const policy = koshOpsFairSharePolicy();
  return tx`WITH leased_counts AS (
      SELECT repository_id, COUNT(*)::int AS leased_count
      FROM kosh_ops_jobs
      WHERE state = 'leased' AND type IN ('storage.lifecycle','replication.verify')
      GROUP BY repository_id
    )
    SELECT j.* FROM kosh_ops_jobs j
    LEFT JOIN leased_counts l ON l.repository_id IS NOT DISTINCT FROM j.repository_id
    WHERE j.state = 'queued' AND j.available_at <= NOW()
      AND j.type IN ('storage.lifecycle','replication.verify')
    ORDER BY
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN CASE WHEN COALESCE(l.leased_count, 0) < ${policy.repositorySoftConcurrency} THEN 0 ELSE 1 END ELSE 0 END ASC,
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN COALESCE(l.leased_count, 0) ELSE 0 END ASC,
      (j.priority + CASE WHEN ${policy.enabled} THEN LEAST(${policy.maxAgingBonus}, FLOOR(EXTRACT(EPOCH FROM (NOW() - GREATEST(j.created_at, j.available_at))) / ${policy.agingSeconds})) ELSE 0 END) DESC,
      j.available_at ASC, j.created_at ASC
    FOR UPDATE OF j SKIP LOCKED LIMIT 1`;
}

async function selectRecoveryCandidate(tx: postgres.TransactionSql<{}>) {
  const policy = koshOpsFairSharePolicy();
  return tx`WITH leased_counts AS (
      SELECT repository_id, COUNT(*)::int AS leased_count
      FROM kosh_ops_jobs
      WHERE state = 'leased' AND type = 'recovery.drill'
      GROUP BY repository_id
    )
    SELECT j.* FROM kosh_ops_jobs j
    LEFT JOIN leased_counts l ON l.repository_id IS NOT DISTINCT FROM j.repository_id
    WHERE j.state = 'queued' AND j.available_at <= NOW() AND j.type = 'recovery.drill'
    ORDER BY
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN CASE WHEN COALESCE(l.leased_count, 0) < ${policy.repositorySoftConcurrency} THEN 0 ELSE 1 END ELSE 0 END ASC,
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN COALESCE(l.leased_count, 0) ELSE 0 END ASC,
      (j.priority + CASE WHEN ${policy.enabled} THEN LEAST(${policy.maxAgingBonus}, FLOOR(EXTRACT(EPOCH FROM (NOW() - GREATEST(j.created_at, j.available_at))) / ${policy.agingSeconds})) ELSE 0 END) DESC,
      j.available_at ASC, j.created_at ASC
    FOR UPDATE OF j SKIP LOCKED LIMIT 1`;
}

async function selectDatabaseCandidate(tx: postgres.TransactionSql<{}>) {
  const policy = koshOpsFairSharePolicy();
  return tx`WITH leased_counts AS (
      SELECT repository_id, COUNT(*)::int AS leased_count
      FROM kosh_ops_jobs
      WHERE state = 'leased' AND type = 'database.backup'
      GROUP BY repository_id
    )
    SELECT j.* FROM kosh_ops_jobs j
    LEFT JOIN leased_counts l ON l.repository_id IS NOT DISTINCT FROM j.repository_id
    WHERE j.state = 'queued' AND j.available_at <= NOW() AND j.type = 'database.backup'
    ORDER BY
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN CASE WHEN COALESCE(l.leased_count, 0) < ${policy.repositorySoftConcurrency} THEN 0 ELSE 1 END ELSE 0 END ASC,
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN COALESCE(l.leased_count, 0) ELSE 0 END ASC,
      (j.priority + CASE WHEN ${policy.enabled} THEN LEAST(${policy.maxAgingBonus}, FLOOR(EXTRACT(EPOCH FROM (NOW() - GREATEST(j.created_at, j.available_at))) / ${policy.agingSeconds})) ELSE 0 END) DESC,
      j.available_at ASC, j.created_at ASC
    FOR UPDATE OF j SKIP LOCKED LIMIT 1`;
}

async function selectIsolatedCandidate(tx: postgres.TransactionSql<{}>) {
  const policy = koshOpsFairSharePolicy();
  return tx`WITH leased_counts AS (
      SELECT repository_id, COUNT(*)::int AS leased_count
      FROM kosh_ops_jobs
      WHERE state = 'leased' AND type IN ('extension.execute','load.test','failure.probe')
      GROUP BY repository_id
    )
    SELECT j.* FROM kosh_ops_jobs j
    LEFT JOIN leased_counts l ON l.repository_id IS NOT DISTINCT FROM j.repository_id
    WHERE j.state = 'queued' AND j.available_at <= NOW()
      AND j.type IN ('extension.execute','load.test','failure.probe')
    ORDER BY
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN CASE WHEN COALESCE(l.leased_count, 0) < ${policy.repositorySoftConcurrency} THEN 0 ELSE 1 END ELSE 0 END ASC,
      CASE WHEN ${policy.enabled} AND j.priority < ${policy.priorityBypass}
        THEN COALESCE(l.leased_count, 0) ELSE 0 END ASC,
      (j.priority + CASE WHEN ${policy.enabled} THEN LEAST(${policy.maxAgingBonus}, FLOOR(EXTRACT(EPOCH FROM (NOW() - GREATEST(j.created_at, j.available_at))) / ${policy.agingSeconds})) ELSE 0 END) DESC,
      j.available_at ASC, j.created_at ASC
    FOR UPDATE OF j SKIP LOCKED LIMIT 1`;
}

async function selectPoolCandidate(
  tx: postgres.TransactionSql<{}>,
  pool: KoshOpsWorkerPool
) {
  if (pool === "all") return selectAllCandidate(tx);
  if (pool === "general") return selectGeneralCandidate(tx);
  if (pool === "storage") return selectStorageCandidate(tx);
  if (pool === "recovery") return selectRecoveryCandidate(tx);
  if (pool === "database") return selectDatabaseCandidate(tx);
  return selectIsolatedCandidate(tx);
}

export async function claimKoshOpsJobForPool(
  workerId: string,
  pool: KoshOpsWorkerPool
) {
  const owner = workerId.trim().slice(0, 160);
  if (!owner) throw new Error("worker_id_required");
  const db = database();
  if (!db) {
    if (pool === "all") return claimKoshOpsJob(workerId);
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
