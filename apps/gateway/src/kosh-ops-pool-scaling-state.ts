import postgres from "postgres";
import {
  koshOpsDedicatedPools,
  type KoshOpsDedicatedPool
} from "./kosh-ops-pool-metrics.js";

export type KoshOpsPoolScalingState = {
  pool: KoshOpsDedicatedPool;
  lastAppliedAt: string | null;
  lastDesiredWorkers: number | null;
  lastReason: string | null;
  idleSince: string | null;
  lastPressureAt: string | null;
  updatedAt: string | null;
};

let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;
const memoryStates = new Map<KoshOpsDedicatedPool, KoshOpsPoolScalingState>();

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 2, prepare: false });
  return sql;
}

function emptyState(pool: KoshOpsDedicatedPool): KoshOpsPoolScalingState {
  return {
    pool,
    lastAppliedAt: null,
    lastDesiredWorkers: null,
    lastReason: null,
    idleSince: null,
    lastPressureAt: null,
    updatedAt: null
  };
}

function timestamp(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fromRow(pool: KoshOpsDedicatedPool, row: Record<string, unknown> | undefined) {
  if (!row) return emptyState(pool);
  return {
    pool,
    lastAppliedAt: timestamp(row.last_applied_at),
    lastDesiredWorkers: row.last_desired_workers == null ? null : Number(row.last_desired_workers),
    lastReason: row.last_reason == null ? null : String(row.last_reason),
    idleSince: timestamp(row.idle_since),
    lastPressureAt: timestamp(row.last_pressure_at),
    updatedAt: timestamp(row.updated_at)
  } satisfies KoshOpsPoolScalingState;
}

export async function readyKoshOpsPoolScalingState() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_ops_pool_scaling_state (
    pool TEXT PRIMARY KEY,
    last_applied_at TIMESTAMPTZ NULL,
    last_desired_workers INTEGER NULL,
    last_reason TEXT NULL,
    idle_since TIMESTAMPTZ NULL,
    last_pressure_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  for (const pool of koshOpsDedicatedPools) {
    await db`INSERT INTO kosh_ops_pool_scaling_state(pool)
      VALUES(${pool}) ON CONFLICT(pool) DO NOTHING`;
  }
  initialized = true;
}

export async function getKoshOpsPoolScalingState(pool: KoshOpsDedicatedPool) {
  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_pool_scaling_state_requires_database"), { status: 503 });
    }
    return { ...(memoryStates.get(pool) ?? emptyState(pool)) };
  }
  await readyKoshOpsPoolScalingState();
  const rows = await db`SELECT * FROM kosh_ops_pool_scaling_state WHERE pool = ${pool} LIMIT 1`;
  return fromRow(pool, rows[0] as Record<string, unknown> | undefined);
}

export async function updateKoshOpsPoolScalingState(
  pool: KoshOpsDedicatedPool,
  input: {
    desiredWorkers?: number | null;
    reason?: string | null;
    applied?: boolean;
    pressure?: boolean;
    idle?: boolean;
  }
) {
  const now = new Date().toISOString();
  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_pool_scaling_state_requires_database"), { status: 503 });
    }
    const current = memoryStates.get(pool) ?? emptyState(pool);
    const next: KoshOpsPoolScalingState = {
      ...current,
      lastAppliedAt: input.applied ? now : current.lastAppliedAt,
      lastDesiredWorkers: input.desiredWorkers ?? current.lastDesiredWorkers,
      lastReason: input.reason ?? current.lastReason,
      idleSince: input.idle ? (current.idleSince ?? now) : null,
      lastPressureAt: input.pressure ? now : current.lastPressureAt,
      updatedAt: now
    };
    memoryStates.set(pool, next);
    return { ...next };
  }
  await readyKoshOpsPoolScalingState();
  const rows = await db`UPDATE kosh_ops_pool_scaling_state SET
    last_applied_at = CASE WHEN ${Boolean(input.applied)} THEN NOW() ELSE last_applied_at END,
    last_desired_workers = COALESCE(${input.desiredWorkers ?? null}, last_desired_workers),
    last_reason = COALESCE(${input.reason ?? null}, last_reason),
    idle_since = CASE WHEN ${Boolean(input.idle)} THEN COALESCE(idle_since, NOW()) ELSE NULL END,
    last_pressure_at = CASE WHEN ${Boolean(input.pressure)} THEN NOW() ELSE last_pressure_at END,
    updated_at = NOW()
    WHERE pool = ${pool}
    RETURNING *`;
  return fromRow(pool, rows[0] as Record<string, unknown> | undefined);
}
