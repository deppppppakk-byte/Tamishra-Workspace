import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  parseKoshObjectLocator,
  type KoshObjectLocator
} from "./kosh-object-storage.js";
import type { KoshStorageClass } from "./kosh-storage-policy.js";

export type StoredKoshObjectLocator = {
  id: string;
  repositoryId: string;
  storageClass: KoshStorageClass;
  logicalId: string;
  locator: KoshObjectLocator;
  createdAt: string;
  updatedAt: string;
};

interface KoshObjectIndex {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  get(
    repositoryId: string,
    storageClass: KoshStorageClass,
    logicalId: string
  ): Promise<StoredKoshObjectLocator | null>;
  list(
    repositoryId: string,
    storageClass?: KoshStorageClass
  ): Promise<StoredKoshObjectLocator[]>;
  put(input: {
    repositoryId: string;
    storageClass: KoshStorageClass;
    logicalId: string;
    locator: KoshObjectLocator;
  }): Promise<StoredKoshObjectLocator>;
  delete(
    repositoryId: string,
    storageClass: KoshStorageClass,
    logicalId: string
  ): Promise<boolean>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function key(repositoryId: string, storageClass: KoshStorageClass, logicalId: string) {
  return repositoryId + "\0" + storageClass + "\0" + logicalId;
}

class MemoryKoshObjectIndex implements KoshObjectIndex {
  readonly kind = "ephemeral-memory" as const;
  private values = new Map<string, StoredKoshObjectLocator>();

  async ready() {}

  async get(repositoryId: string, storageClass: KoshStorageClass, logicalId: string) {
    const item = this.values.get(key(repositoryId, storageClass, logicalId));
    return item ? clone(item) : null;
  }

  async list(repositoryId: string, storageClass?: KoshStorageClass) {
    return [...this.values.values()]
      .filter(
        (item) =>
          item.repositoryId === repositoryId &&
          (!storageClass || item.storageClass === storageClass)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  async put(input: {
    repositoryId: string;
    storageClass: KoshStorageClass;
    logicalId: string;
    locator: KoshObjectLocator;
  }) {
    const storageKey = key(input.repositoryId, input.storageClass, input.logicalId);
    const current = this.values.get(storageKey);
    const timestamp = now();
    const item: StoredKoshObjectLocator = {
      id: current?.id ?? randomUUID(),
      repositoryId: input.repositoryId,
      storageClass: input.storageClass,
      logicalId: input.logicalId,
      locator: clone(input.locator),
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.values.set(storageKey, item);
    return clone(item);
  }

  async delete(repositoryId: string, storageClass: KoshStorageClass, logicalId: string) {
    return this.values.delete(key(repositoryId, storageClass, logicalId));
  }
}

function fromRow(row: Record<string, unknown>): StoredKoshObjectLocator {
  const locator = parseKoshObjectLocator(row.locator);
  if (!locator) throw new Error("invalid_kosh_object_locator");
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    storageClass: String(row.storage_class) as KoshStorageClass,
    logicalId: String(row.logical_id),
    locator,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

class PostgresKoshObjectIndex implements KoshObjectIndex {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;
    await this.sql`CREATE TABLE IF NOT EXISTS kosh_storage_objects (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      storage_class TEXT NOT NULL,
      logical_id TEXT NOT NULL,
      locator JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, storage_class, logical_id),
      CHECK(storage_class IN ('artifact','package','release','backup'))
    )`;
    await this.sql`CREATE INDEX IF NOT EXISTS kosh_storage_objects_repo_idx
      ON kosh_storage_objects(repository_id, storage_class, updated_at DESC)`;
    this.initialized = true;
  }

  async get(repositoryId: string, storageClass: KoshStorageClass, logicalId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_storage_objects
      WHERE repository_id = ${repositoryId}
        AND storage_class = ${storageClass}
        AND logical_id = ${logicalId}
      LIMIT 1
    `;
    return rows[0] ? fromRow(rows[0] as Record<string, unknown>) : null;
  }

  async list(repositoryId: string, storageClass?: KoshStorageClass) {
    await this.ready();
    const rows = storageClass
      ? await this.sql`
          SELECT * FROM kosh_storage_objects
          WHERE repository_id = ${repositoryId}
            AND storage_class = ${storageClass}
          ORDER BY updated_at DESC
          LIMIT 20000
        `
      : await this.sql`
          SELECT * FROM kosh_storage_objects
          WHERE repository_id = ${repositoryId}
          ORDER BY updated_at DESC
          LIMIT 20000
        `;
    return rows.map((row) => fromRow(row as Record<string, unknown>));
  }

  async put(input: {
    repositoryId: string;
    storageClass: KoshStorageClass;
    logicalId: string;
    locator: KoshObjectLocator;
  }) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_storage_objects(
        id, repository_id, storage_class, logical_id, locator
      ) VALUES(
        ${randomUUID()}, ${input.repositoryId}, ${input.storageClass},
        ${input.logicalId}, ${JSON.stringify(input.locator)}::jsonb
      )
      ON CONFLICT(repository_id, storage_class, logical_id)
      DO UPDATE SET locator = EXCLUDED.locator, updated_at = NOW()
      RETURNING *
    `;
    return fromRow(rows[0] as Record<string, unknown>);
  }

  async delete(repositoryId: string, storageClass: KoshStorageClass, logicalId: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_storage_objects
      WHERE repository_id = ${repositoryId}
        AND storage_class = ${storageClass}
        AND logical_id = ${logicalId}
      RETURNING id
    `;
    return rows.length > 0;
  }
}

let singleton: KoshObjectIndex | null = null;

export function getKoshObjectIndex(): KoshObjectIndex {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshObjectIndex(postgres(databaseUrl, { max: 4, prepare: false }))
    : new MemoryKoshObjectIndex();
  return singleton;
}
