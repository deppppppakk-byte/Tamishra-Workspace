import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  koshKnownStorageUsage,
  koshStorageLimits,
  koshStorageObjectLimit,
  type KoshStorageClass
} from "./kosh-storage-policy.js";

export type KoshStorageReservationState =
  | "active"
  | "completed"
  | "aborted"
  | "expired";

export type KoshStorageReservation = {
  id: string;
  repositoryId: string;
  storageClass: KoshStorageClass;
  bytes: number;
  state: KoshStorageReservationState;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

type ReservationOutcome = "completed" | "aborted";

type ReserveResult = KoshStorageReservation & {
  knownBytesBefore: number;
  activeReservedBytesBefore: number;
  effectiveBytesAfter: number;
  limitBytes: number;
};

const terminalRetentionMs = 7 * 24 * 60 * 60 * 1000;
const memoryReservations = new Map<string, KoshStorageReservation>();
const memoryLocks = new Map<string, Promise<void>>();
let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;

function nowIso() {
  return new Date().toISOString();
}

function reservationTtlMs() {
  const configured = Number(process.env.KOSH_STORAGE_RESERVATION_TTL_MINUTES ?? 120);
  const minutes = Number.isFinite(configured)
    ? Math.max(5, Math.min(24 * 60, Math.floor(configured)))
    : 120;
  return minutes * 60 * 1000;
}

function database() {
  if (sql) return sql;
  const url = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!url) return null;
  sql = postgres(url, { max: 4, prepare: false });
  return sql;
}

async function ready() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_storage_reservations (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    storage_class TEXT NOT NULL,
    bytes BIGINT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK(storage_class IN ('artifact','package','release','backup')),
    CHECK(state IN ('active','completed','aborted','expired')),
    CHECK(bytes >= 0)
  )`;
  await db`CREATE INDEX IF NOT EXISTS kosh_storage_reservations_repo_active_idx
    ON kosh_storage_reservations(repository_id, state, expires_at)`;
  initialized = true;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizedBytes(value: number) {
  return Math.max(0, Math.floor(Number(value) || 0));
}

async function withMemoryLock<T>(repositoryId: string, run: () => Promise<T>) {
  const previous = memoryLocks.get(repositoryId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  memoryLocks.set(repositoryId, previous.then(() => current));
  await previous;
  try {
    return await run();
  } finally {
    release();
  }
}

function pruneMemoryReservations() {
  const now = Date.now();
  for (const [id, item] of memoryReservations) {
    const expires = new Date(item.expiresAt).getTime();
    const updated = new Date(item.updatedAt).getTime();
    if (item.state === "active" && expires <= now) {
      item.state = "expired";
      item.updatedAt = nowIso();
    }
    if (item.state !== "active" && updated <= now - terminalRetentionMs) {
      memoryReservations.delete(id);
    }
  }
}

function activeMemoryBytes(repositoryId: string) {
  pruneMemoryReservations();
  return [...memoryReservations.values()]
    .filter((item) => item.repositoryId === repositoryId && item.state === "active")
    .reduce((total, item) => total + item.bytes, 0);
}

function quotaError(
  storageClass: KoshStorageClass,
  incomingBytes: number,
  knownBytes: number,
  reservedBytes: number,
  limitBytes: number
) {
  return Object.assign(new Error("repository_storage_quota_reserved"), {
    status: 413,
    storageClass,
    incomingBytes,
    knownBytes,
    reservedBytes,
    limitBytes
  });
}

function objectLimitError(
  storageClass: KoshStorageClass,
  incomingBytes: number,
  limitBytes: number
) {
  return Object.assign(new Error("storage_object_limit_exceeded"), {
    status: 413,
    storageClass,
    incomingBytes,
    limitBytes
  });
}

export function koshStorageReservationBackend() {
  return database() ? "postgres" as const : "ephemeral-memory" as const;
}

export async function reserveKoshStorageCapacity(
  repositoryId: string,
  storageClass: KoshStorageClass,
  incomingBytes: number
): Promise<ReserveResult> {
  const bytes = normalizedBytes(incomingBytes);
  const limits = await koshStorageLimits(repositoryId);
  const perObjectLimit = koshStorageObjectLimit(storageClass, limits);
  if (bytes > perObjectLimit) {
    throw objectLimitError(storageClass, bytes, perObjectLimit);
  }

  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(
        new Error("distributed_storage_reservations_require_database"),
        { status: 503 }
      );
    }
    return withMemoryLock(repositoryId, async () => {
      const usage = await koshKnownStorageUsage(repositoryId);
      const reserved = activeMemoryBytes(repositoryId);
      if (usage.knownBytes + reserved + bytes > limits.maxTotalBytes) {
        throw quotaError(
          storageClass,
          bytes,
          usage.knownBytes,
          reserved,
          limits.maxTotalBytes
        );
      }
      const timestamp = nowIso();
      const item: KoshStorageReservation = {
        id: randomUUID(),
        repositoryId,
        storageClass,
        bytes,
        state: "active",
        expiresAt: new Date(Date.now() + reservationTtlMs()).toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      memoryReservations.set(item.id, item);
      return {
        ...clone(item),
        knownBytesBefore: usage.knownBytes,
        activeReservedBytesBefore: reserved,
        effectiveBytesAfter: usage.knownBytes + reserved + bytes,
        limitBytes: limits.maxTotalBytes
      };
    });
  }

  await ready();
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${repositoryId}, 0))`;
    await tx`UPDATE kosh_storage_reservations
      SET state = 'expired', updated_at = NOW()
      WHERE repository_id = ${repositoryId}
        AND state = 'active'
        AND expires_at <= NOW()`;
    await tx`DELETE FROM kosh_storage_reservations
      WHERE state <> 'active'
        AND updated_at < NOW() - INTERVAL '7 days'`;

    const usage = await koshKnownStorageUsage(repositoryId);
    const rows = await tx`
      SELECT COALESCE(SUM(bytes), 0)::bigint AS reserved_bytes
      FROM kosh_storage_reservations
      WHERE repository_id = ${repositoryId}
        AND state = 'active'
        AND expires_at > NOW()
    `;
    const reserved = Number(rows[0]?.reserved_bytes ?? 0);
    if (usage.knownBytes + reserved + bytes > limits.maxTotalBytes) {
      throw quotaError(
        storageClass,
        bytes,
        usage.knownBytes,
        reserved,
        limits.maxTotalBytes
      );
    }

    const id = randomUUID();
    const expiresAt = new Date(Date.now() + reservationTtlMs()).toISOString();
    const inserted = await tx`
      INSERT INTO kosh_storage_reservations(
        id, repository_id, storage_class, bytes, state, expires_at
      ) VALUES(
        ${id}, ${repositoryId}, ${storageClass}, ${bytes}, 'active', ${expiresAt}
      )
      RETURNING *
    `;
    const row = inserted[0] as Record<string, unknown>;
    const item: KoshStorageReservation = {
      id: String(row.id),
      repositoryId: String(row.repository_id),
      storageClass: String(row.storage_class) as KoshStorageClass,
      bytes: Number(row.bytes),
      state: String(row.state) as KoshStorageReservationState,
      expiresAt: new Date(String(row.expires_at)).toISOString(),
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString()
    };
    return {
      ...item,
      knownBytesBefore: usage.knownBytes,
      activeReservedBytesBefore: reserved,
      effectiveBytesAfter: usage.knownBytes + reserved + bytes,
      limitBytes: limits.maxTotalBytes
    };
  });
}

export async function finalizeKoshStorageReservation(
  id: string,
  outcome: ReservationOutcome
) {
  const db = database();
  if (!db) {
    const item = memoryReservations.get(id);
    if (!item) return false;
    return withMemoryLock(item.repositoryId, async () => {
      const current = memoryReservations.get(id);
      if (!current || current.state !== "active") return false;
      current.state = outcome;
      current.updatedAt = nowIso();
      return true;
    });
  }

  await ready();
  const records = await db`
    SELECT repository_id
    FROM kosh_storage_reservations
    WHERE id = ${id}
    LIMIT 1
  `;
  if (!records[0]) return false;
  const repositoryId = String(records[0].repository_id);
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${repositoryId}, 0))`;
    const rows = await tx`
      UPDATE kosh_storage_reservations
      SET state = ${outcome}, updated_at = NOW()
      WHERE id = ${id} AND state = 'active'
      RETURNING id
    `;
    return rows.length > 0;
  });
}

export async function koshActiveStorageReservations(repositoryId: string) {
  const db = database();
  if (!db) {
    pruneMemoryReservations();
    return [...memoryReservations.values()]
      .filter((item) => item.repositoryId === repositoryId && item.state === "active")
      .map(clone);
  }
  await ready();
  await db`UPDATE kosh_storage_reservations
    SET state = 'expired', updated_at = NOW()
    WHERE repository_id = ${repositoryId}
      AND state = 'active'
      AND expires_at <= NOW()`;
  const rows = await db`
    SELECT * FROM kosh_storage_reservations
    WHERE repository_id = ${repositoryId}
      AND state = 'active'
      AND expires_at > NOW()
    ORDER BY created_at ASC
    LIMIT 1000
  `;
  return rows.map((row) => ({
    id: String(row.id),
    repositoryId: String(row.repository_id),
    storageClass: String(row.storage_class) as KoshStorageClass,
    bytes: Number(row.bytes),
    state: String(row.state) as KoshStorageReservationState,
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  }));
}
