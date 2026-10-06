import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import postgres from "postgres";

const instanceId = process.env.KOSH_CONTROLLER_INSTANCE_ID?.trim() || `controller-${randomUUID()}`;
const releaseVersion = process.env.WORKSPACE_RELEASE_VERSION?.trim() || "dev";
const startedAt = new Date().toISOString();
const heartbeatMs = Math.max(5_000, Math.min(60_000, Number(process.env.KOSH_CONTROLLER_HEARTBEAT_MS) || 15_000));
const leaseSeconds = Math.max(15, Math.min(180, Number(process.env.KOSH_CONTROLLER_LEASE_SECONDS) || 45));
let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function database() {
  if (sql) return sql;
  const url = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!url) return null;
  sql = postgres(url, { max: 2, prepare: false });
  return sql;
}

async function ready() {
  const db = database();
  if (!db || initialized) return Boolean(db);
  await db`CREATE TABLE IF NOT EXISTS kosh_controller_instances (
    instance_id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    release_version TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE INDEX IF NOT EXISTS kosh_controller_instances_seen_idx
    ON kosh_controller_instances(last_seen_at DESC)`;
  await db`CREATE TABLE IF NOT EXISTS kosh_controller_leader (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton = TRUE),
    instance_id TEXT NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  initialized = true;
  return true;
}

export async function heartbeatKoshController() {
  const db = database();
  if (!db || !(await ready())) return { active: false, reason: "database_unavailable" } as const;

  await db`INSERT INTO kosh_controller_instances(instance_id, hostname, release_version, started_at, last_seen_at)
    VALUES(${instanceId}, ${hostname()}, ${releaseVersion}, ${startedAt}, NOW())
    ON CONFLICT(instance_id) DO UPDATE SET
      hostname = EXCLUDED.hostname,
      release_version = EXCLUDED.release_version,
      last_seen_at = NOW()`;

  await db`DELETE FROM kosh_controller_instances
    WHERE last_seen_at < NOW() - INTERVAL '5 minutes'`;

  await db`INSERT INTO kosh_controller_leader(singleton, instance_id, lease_until, updated_at)
    VALUES(TRUE, ${instanceId}, NOW() + (${leaseSeconds}::text || ' seconds')::interval, NOW())
    ON CONFLICT(singleton) DO NOTHING`;

  const claimed = await db`UPDATE kosh_controller_leader
    SET instance_id = ${instanceId},
        lease_until = NOW() + (${leaseSeconds}::text || ' seconds')::interval,
        updated_at = NOW()
    WHERE singleton = TRUE
      AND (instance_id = ${instanceId} OR lease_until < NOW())
    RETURNING instance_id, lease_until`;

  if (!claimed.length) {
    const current = await db`SELECT instance_id, lease_until FROM kosh_controller_leader WHERE singleton = TRUE`;
    return {
      active: true,
      leader: String(current[0]?.instance_id ?? ""),
      isLeader: false
    } as const;
  }

  return { active: true, leader: instanceId, isLeader: true } as const;
}

export async function getKoshControllerClusterStatus() {
  const db = database();
  if (!db || !(await ready())) {
    return {
      databaseBacked: false,
      instanceId,
      activeInstances: 1,
      redundant: false,
      leader: instanceId,
      isLeader: true,
      instances: [{ instanceId, hostname: hostname(), releaseVersion, startedAt, lastSeenAt: new Date().toISOString() }]
    };
  }

  await heartbeatKoshController();
  const [instances, leaderRows] = await Promise.all([
    db`SELECT instance_id, hostname, release_version, started_at, last_seen_at
      FROM kosh_controller_instances
      WHERE last_seen_at >= NOW() - INTERVAL '90 seconds'
      ORDER BY last_seen_at DESC`,
    db`SELECT instance_id, lease_until FROM kosh_controller_leader WHERE singleton = TRUE`
  ]);
  const leader = String(leaderRows[0]?.instance_id ?? "");
  return {
    databaseBacked: true,
    instanceId,
    activeInstances: instances.length,
    redundant: instances.length >= 2,
    leader,
    isLeader: leader === instanceId,
    instances: instances.map((row) => ({
      instanceId: String(row.instance_id),
      hostname: String(row.hostname),
      releaseVersion: String(row.release_version),
      startedAt: new Date(String(row.started_at)).toISOString(),
      lastSeenAt: new Date(String(row.last_seen_at)).toISOString()
    }))
  };
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  if (process.env.KOSH_CLOUD_ENABLED?.trim().toLowerCase() !== "true") return;
  if (!process.env.WORKSPACE_DATABASE_URL?.trim()) return;
  void heartbeatKoshController().catch((error) => {
    console.error("Kosh controller cluster heartbeat failed", error);
  });
  heartbeatTimer = setInterval(() => {
    void heartbeatKoshController().catch((error) => {
      console.error("Kosh controller cluster heartbeat failed", error);
    });
  }, heartbeatMs);
  heartbeatTimer.unref?.();
}

startHeartbeat();
