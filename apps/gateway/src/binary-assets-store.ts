import postgres from "postgres";

export type StoredBinaryAsset = {
  userId: string;
  assetId: string;
  revision: number;
  name: string;
  mimeType: string;
  sizeBytes: number;
  bytes: Buffer;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export interface BinaryAssetStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  get(userId: string, assetId: string): Promise<StoredBinaryAsset | null>;
  put(
    userId: string,
    assetId: string,
    input: {
      name: string;
      mimeType: string;
      bytes: Buffer;
      metadata: Record<string, unknown>;
    },
    expectedRevision?: number | null
  ): Promise<StoredBinaryAsset>;
  delete(userId: string, assetId: string): Promise<boolean>;
}

class MemoryBinaryAssetStore implements BinaryAssetStore {
  readonly kind = "ephemeral-memory" as const;
  private records = new Map<string, StoredBinaryAsset>();

  async ready() {}

  async get(userId: string, assetId: string) {
    const value = this.records.get(`${userId}:${assetId}`);
    if (!value) return null;
    return {
      ...value,
      bytes: Buffer.from(value.bytes),
      metadata: structuredClone(value.metadata)
    };
  }

  async put(
    userId: string,
    assetId: string,
    input: {
      name: string;
      mimeType: string;
      bytes: Buffer;
      metadata: Record<string, unknown>;
    },
    expectedRevision?: number | null
  ) {
    const key = `${userId}:${assetId}`;
    const current = this.records.get(key);

    if (
      expectedRevision !== undefined &&
      expectedRevision !== null &&
      (current?.revision ?? 0) !== expectedRevision
    ) {
      throw Object.assign(new Error("revision_conflict"), {
        status: 409,
        currentRevision: current?.revision ?? 0
      });
    }

    const now = new Date().toISOString();
    const next: StoredBinaryAsset = {
      userId,
      assetId,
      revision: (current?.revision ?? 0) + 1,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      bytes: Buffer.from(input.bytes),
      metadata: structuredClone(input.metadata),
      createdAt: current?.createdAt ?? now,
      updatedAt: now
    };

    this.records.set(key, next);
    return {
      ...next,
      bytes: Buffer.from(next.bytes),
      metadata: structuredClone(next.metadata)
    };
  }

  async delete(userId: string, assetId: string) {
    return this.records.delete(`${userId}:${assetId}`);
  }
}

class PostgresBinaryAssetStore implements BinaryAssetStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`
      CREATE TABLE IF NOT EXISTS workspace_binary_assets (
        user_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL,
        bytes BYTEA NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, asset_id)
      )
    `;

    this.initialized = true;
  }

  async get(userId: string, assetId: string): Promise<StoredBinaryAsset | null> {
    await this.ready();

    const rows = await this.sql`
      SELECT user_id, asset_id, revision, name, mime_type, size_bytes,
             bytes, metadata, created_at, updated_at
      FROM workspace_binary_assets
      WHERE user_id = ${userId} AND asset_id = ${assetId}
      LIMIT 1
    `;

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    const bytes =
      row.bytes instanceof Uint8Array
        ? Buffer.from(row.bytes)
        : Buffer.from(row.bytes as Buffer);

    return {
      userId: String(row.user_id),
      assetId: String(row.asset_id),
      revision: Number(row.revision ?? 0),
      name: String(row.name ?? "asset"),
      mimeType: String(row.mime_type ?? "application/octet-stream"),
      sizeBytes: Number(row.size_bytes ?? bytes.length),
      bytes,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? row.metadata as Record<string, unknown>
          : {},
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString()
    };
  }

  async put(
    userId: string,
    assetId: string,
    input: {
      name: string;
      mimeType: string;
      bytes: Buffer;
      metadata: Record<string, unknown>;
    },
    expectedRevision?: number | null
  ): Promise<StoredBinaryAsset> {
    await this.ready();

    const metadata = JSON.stringify(input.metadata);
    let rows;

    if (expectedRevision === 0) {
      rows = await this.sql`
        INSERT INTO workspace_binary_assets (
          user_id, asset_id, revision, name, mime_type, size_bytes,
          bytes, metadata, created_at, updated_at
        )
        VALUES (
          ${userId}, ${assetId}, 1, ${input.name}, ${input.mimeType},
          ${input.bytes.length}, ${input.bytes}, ${metadata}::jsonb, NOW(), NOW()
        )
        ON CONFLICT (user_id, asset_id) DO NOTHING
        RETURNING user_id, asset_id, revision, name, mime_type, size_bytes,
                  bytes, metadata, created_at, updated_at
      `;
    } else if (
      expectedRevision !== undefined &&
      expectedRevision !== null
    ) {
      rows = await this.sql`
        UPDATE workspace_binary_assets
        SET
          revision = revision + 1,
          name = ${input.name},
          mime_type = ${input.mimeType},
          size_bytes = ${input.bytes.length},
          bytes = ${input.bytes},
          metadata = ${metadata}::jsonb,
          updated_at = NOW()
        WHERE
          user_id = ${userId}
          AND asset_id = ${assetId}
          AND revision = ${expectedRevision}
        RETURNING user_id, asset_id, revision, name, mime_type, size_bytes,
                  bytes, metadata, created_at, updated_at
      `;
    } else {
      rows = await this.sql`
        INSERT INTO workspace_binary_assets (
          user_id, asset_id, revision, name, mime_type, size_bytes,
          bytes, metadata, created_at, updated_at
        )
        VALUES (
          ${userId}, ${assetId}, 1, ${input.name}, ${input.mimeType},
          ${input.bytes.length}, ${input.bytes}, ${metadata}::jsonb, NOW(), NOW()
        )
        ON CONFLICT (user_id, asset_id)
        DO UPDATE SET
          revision = workspace_binary_assets.revision + 1,
          name = EXCLUDED.name,
          mime_type = EXCLUDED.mime_type,
          size_bytes = EXCLUDED.size_bytes,
          bytes = EXCLUDED.bytes,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
        RETURNING user_id, asset_id, revision, name, mime_type, size_bytes,
                  bytes, metadata, created_at, updated_at
      `;
    }

    if (!rows.length) {
      const current = await this.get(userId, assetId);
      throw Object.assign(new Error("revision_conflict"), {
        status: 409,
        currentRevision: current?.revision ?? 0
      });
    }

    const row = rows[0] as Record<string, unknown>;
    const bytes =
      row.bytes instanceof Uint8Array
        ? Buffer.from(row.bytes)
        : Buffer.from(row.bytes as Buffer);

    return {
      userId: String(row.user_id),
      assetId: String(row.asset_id),
      revision: Number(row.revision ?? 0),
      name: String(row.name),
      mimeType: String(row.mime_type),
      sizeBytes: Number(row.size_bytes ?? bytes.length),
      bytes,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? row.metadata as Record<string, unknown>
          : {},
      createdAt: new Date(String(row.created_at)).toISOString(),
      updatedAt: new Date(String(row.updated_at)).toISOString()
    };
  }

  async delete(userId: string, assetId: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM workspace_binary_assets
      WHERE user_id = ${userId} AND asset_id = ${assetId}
      RETURNING asset_id
    `;
    return rows.length > 0;
  }
}

export function createBinaryAssetStore(): BinaryAssetStore {
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  return databaseUrl
    ? new PostgresBinaryAssetStore(
        postgres(databaseUrl, { max: 5, prepare: false })
      )
    : new MemoryBinaryAssetStore();
}
