import postgres from "postgres";

let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;
let memoryOwner: string | null = null;
let memoryExpiresAt = 0;

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 2, prepare: false });
  return sql;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function koshOpsSchedulerLeaderLeaseMs() {
  return boundedInteger(process.env.KOSH_OPS_SCHEDULER_LEASE_SECONDS, 120, 30, 900) * 1000;
}

export async function readyKoshOpsSchedulerLeader() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_ops_scheduler_leader (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton = TRUE),
    worker_id TEXT NOT NULL,
    lease_expires_at TIMESTAMPTZ NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  initialized = true;
}

export async function acquireOrRenewKoshOpsSchedulerLeadership(workerId: string) {
  const owner = workerId.trim().slice(0, 200);
  if (!owner) throw new Error("worker_id_required");
  const expiresAt = new Date(Date.now() + koshOpsSchedulerLeaderLeaseMs()).toISOString();
  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_scheduler_leader_requires_database"), { status: 503 });
    }
    const now = Date.now();
    if (!memoryOwner || memoryOwner === owner || memoryExpiresAt <= now) {
      memoryOwner = owner;
      memoryExpiresAt = new Date(expiresAt).getTime();
      return { leader: true as const, workerId: owner, leaseExpiresAt: expiresAt };
    }
    return { leader: false as const, workerId: memoryOwner, leaseExpiresAt: new Date(memoryExpiresAt).toISOString() };
  }

  await readyKoshOpsSchedulerLeader();
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('kosh_ops_scheduler_leader'))`;
    const rows = await tx`SELECT worker_id, lease_expires_at FROM kosh_ops_scheduler_leader WHERE singleton = TRUE`;
    const current = rows[0] as Record<string, unknown> | undefined;
    const currentOwner = current?.worker_id == null ? null : String(current.worker_id);
    const currentExpiry = current?.lease_expires_at ? new Date(String(current.lease_expires_at)).getTime() : 0;
    if (currentOwner && currentOwner !== owner && currentExpiry > Date.now()) {
      return {
        leader: false as const,
        workerId: currentOwner,
        leaseExpiresAt: new Date(currentExpiry).toISOString()
      };
    }
    await tx`INSERT INTO kosh_ops_scheduler_leader(singleton, worker_id, lease_expires_at, acquired_at, updated_at)
      VALUES(TRUE, ${owner}, ${expiresAt}, NOW(), NOW())
      ON CONFLICT(singleton) DO UPDATE SET
        worker_id = EXCLUDED.worker_id,
        lease_expires_at = EXCLUDED.lease_expires_at,
        acquired_at = CASE WHEN kosh_ops_scheduler_leader.worker_id = EXCLUDED.worker_id
          THEN kosh_ops_scheduler_leader.acquired_at ELSE NOW() END,
        updated_at = NOW()`;
    return { leader: true as const, workerId: owner, leaseExpiresAt: expiresAt };
  });
}

export async function releaseKoshOpsSchedulerLeadership(workerId: string) {
  const owner = workerId.trim().slice(0, 200);
  const db = database();
  if (!db) {
    if (memoryOwner === owner) {
      memoryOwner = null;
      memoryExpiresAt = 0;
      return true;
    }
    return false;
  }
  await readyKoshOpsSchedulerLeader();
  const rows = await db`DELETE FROM kosh_ops_scheduler_leader
    WHERE singleton = TRUE AND worker_id = ${owner}
    RETURNING worker_id`;
  return rows.length > 0;
}

export async function getKoshOpsSchedulerLeadership() {
  const db = database();
  if (!db) {
    const active = Boolean(memoryOwner) && memoryExpiresAt > Date.now();
    return {
      persistence: "ephemeral-memory" as const,
      active,
      workerId: active ? memoryOwner : null,
      leaseExpiresAt: active ? new Date(memoryExpiresAt).toISOString() : null
    };
  }
  await readyKoshOpsSchedulerLeader();
  const rows = await db`SELECT worker_id, lease_expires_at FROM kosh_ops_scheduler_leader WHERE singleton = TRUE`;
  const row = rows[0] as Record<string, unknown> | undefined;
  const expiry = row?.lease_expires_at ? new Date(String(row.lease_expires_at)) : null;
  const active = Boolean(row?.worker_id) && Boolean(expiry) && expiry!.getTime() > Date.now();
  return {
    persistence: "postgres" as const,
    active,
    workerId: active ? String(row!.worker_id) : null,
    leaseExpiresAt: active ? expiry!.toISOString() : null
  };
}
