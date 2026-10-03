import postgres from "postgres";

export type KoshOpsScalingState = {
  lastAppliedAt: string | null;
  lastDesiredWorkers: number | null;
  lastReason: string | null;
  idleSince: string | null;
  lastPressureAt: string | null;
  updatedAt: string | null;
};

let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;
let memoryState: KoshOpsScalingState = {
  lastAppliedAt: null,
  lastDesiredWorkers: null,
  lastReason: null,
  idleSince: null,
  lastPressureAt: null,
  updatedAt: null
};

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 2, prepare: false });
  return sql;
}

function timestamp(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function fromRow(row: Record<string, unknown> | undefined): KoshOpsScalingState {
  if (!row) return { ...memoryState };
  return {
    lastAppliedAt: timestamp(row.last_applied_at),
    lastDesiredWorkers: row.last_desired_workers == null ? null : Number(row.last_desired_workers),
    lastReason: row.last_reason == null ? null : String(row.last_reason),
    idleSince: timestamp(row.idle_since),
    lastPressureAt: timestamp(row.last_pressure_at),
    updatedAt: timestamp(row.updated_at)
  };
}

export async function readyKoshOpsScalingState() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_ops_scaling_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton = TRUE),
    last_applied_at TIMESTAMPTZ NULL,
    last_desired_workers INTEGER NULL,
    last_reason TEXT NULL,
    idle_since TIMESTAMPTZ NULL,
    last_pressure_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`INSERT INTO kosh_ops_scaling_state(singleton)
    VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING`;
  initialized = true;
}

export async function getKoshOpsScalingState() {
  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_scaling_state_requires_database"), { status: 503 });
    }
    return { ...memoryState };
  }
  await readyKoshOpsScalingState();
  const rows = await db`SELECT * FROM kosh_ops_scaling_state WHERE singleton = TRUE`;
  return fromRow(rows[0] as Record<string, unknown> | undefined);
}

export async function updateKoshOpsScalingState(input: {
  desiredWorkers?: number | null;
  reason?: string | null;
  applied?: boolean;
  pressure?: boolean;
  idle?: boolean;
}) {
  const now = new Date().toISOString();
  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_ops_scaling_state_requires_database"), { status: 503 });
    }
    memoryState = {
      ...memoryState,
      lastAppliedAt: input.applied ? now : memoryState.lastAppliedAt,
      lastDesiredWorkers: input.desiredWorkers ?? memoryState.lastDesiredWorkers,
      lastReason: input.reason ?? memoryState.lastReason,
      idleSince: input.idle ? (memoryState.idleSince ?? now) : null,
      lastPressureAt: input.pressure ? now : memoryState.lastPressureAt,
      updatedAt: now
    };
    return { ...memoryState };
  }
  await readyKoshOpsScalingState();
  const rows = await db`UPDATE kosh_ops_scaling_state SET
    last_applied_at = CASE WHEN ${Boolean(input.applied)} THEN NOW() ELSE last_applied_at END,
    last_desired_workers = COALESCE(${input.desiredWorkers ?? null}, last_desired_workers),
    last_reason = COALESCE(${input.reason ?? null}, last_reason),
    idle_since = CASE WHEN ${Boolean(input.idle)} THEN COALESCE(idle_since, NOW()) ELSE NULL END,
    last_pressure_at = CASE WHEN ${Boolean(input.pressure)} THEN NOW() ELSE last_pressure_at END,
    updated_at = NOW()
    WHERE singleton = TRUE
    RETURNING *`;
  return fromRow(rows[0] as Record<string, unknown> | undefined);
}
