import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshPackageState = "published" | "yanked";

export type StoredKoshPackageVersion = {
  id: string;
  repositoryId: string;
  packageKey: string;
  name: string;
  version: string;
  filename: string;
  format: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  state: KoshPackageState;
  commitSha: string | null;
  runId: string | null;
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshPackageChannel = {
  id: string;
  repositoryId: string;
  packageKey: string;
  channel: string;
  versionId: string;
  version: string;
  updatedByUserId: string;
  updatedByName: string;
  createdAt: string;
  updatedAt: string;
};

export interface KoshPackageStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;

  listVersions(
    repositoryId: string,
    packageKey?: string
  ): Promise<StoredKoshPackageVersion[]>;
  getVersion(
    repositoryId: string,
    packageKey: string,
    version: string
  ): Promise<StoredKoshPackageVersion | null>;
  getVersionById(
    repositoryId: string,
    id: string
  ): Promise<StoredKoshPackageVersion | null>;
  createVersion(
    input: Omit<StoredKoshPackageVersion, "id" | "createdAt" | "updatedAt">
  ): Promise<StoredKoshPackageVersion>;
  deleteVersionForRollback(repositoryId: string, id: string): Promise<boolean>;
  setVersionState(
    repositoryId: string,
    id: string,
    state: KoshPackageState
  ): Promise<StoredKoshPackageVersion | null>;

  listChannels(
    repositoryId: string,
    packageKey?: string
  ): Promise<StoredKoshPackageChannel[]>;
  getChannel(
    repositoryId: string,
    packageKey: string,
    channel: string
  ): Promise<StoredKoshPackageChannel | null>;
  putChannel(input: {
    repositoryId: string;
    packageKey: string;
    channel: string;
    versionId: string;
    version: string;
    updatedByUserId: string;
    updatedByName: string;
  }): Promise<StoredKoshPackageChannel>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryKoshPackageStore implements KoshPackageStore {
  readonly kind = "ephemeral-memory" as const;
  private versions = new Map<string, StoredKoshPackageVersion>();
  private channels = new Map<string, StoredKoshPackageChannel>();

  async ready() {}

  async listVersions(repositoryId: string, packageKey?: string) {
    return [...this.versions.values()]
      .filter(
        (item) =>
          item.repositoryId === repositoryId &&
          (!packageKey || item.packageKey === packageKey)
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async getVersion(
    repositoryId: string,
    packageKey: string,
    version: string
  ) {
    const item = [...this.versions.values()].find(
      (candidate) =>
        candidate.repositoryId === repositoryId &&
        candidate.packageKey === packageKey &&
        candidate.version === version
    );
    return item ? clone(item) : null;
  }

  async getVersionById(repositoryId: string, id: string) {
    const item = this.versions.get(id);
    return item && item.repositoryId === repositoryId ? clone(item) : null;
  }

  async createVersion(
    input: Omit<StoredKoshPackageVersion, "id" | "createdAt" | "updatedAt">
  ) {
    const duplicate = [...this.versions.values()].find(
      (item) =>
        item.repositoryId === input.repositoryId &&
        item.packageKey === input.packageKey &&
        item.version === input.version
    );
    if (duplicate) {
      throw Object.assign(new Error("package_version_immutable"), {
        status: 409
      });
    }

    const timestamp = now();
    const value: StoredKoshPackageVersion = {
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.versions.set(value.id, value);
    return clone(value);
  }

  async deleteVersionForRollback(repositoryId: string, id: string) {
    const item = this.versions.get(id);
    if (!item || item.repositoryId !== repositoryId) return false;
    return this.versions.delete(id);
  }

  async setVersionState(
    repositoryId: string,
    id: string,
    state: KoshPackageState
  ) {
    const item = this.versions.get(id);
    if (!item || item.repositoryId !== repositoryId) return null;
    item.state = state;
    item.updatedAt = now();
    return clone(item);
  }

  async listChannels(repositoryId: string, packageKey?: string) {
    return [...this.channels.values()]
      .filter(
        (item) =>
          item.repositoryId === repositoryId &&
          (!packageKey || item.packageKey === packageKey)
      )
      .sort((a, b) => a.channel.localeCompare(b.channel))
      .map(clone);
  }

  async getChannel(
    repositoryId: string,
    packageKey: string,
    channel: string
  ) {
    const key = repositoryId + "\0" + packageKey + "\0" + channel;
    const item = this.channels.get(key);
    return item ? clone(item) : null;
  }

  async putChannel(input: {
    repositoryId: string;
    packageKey: string;
    channel: string;
    versionId: string;
    version: string;
    updatedByUserId: string;
    updatedByName: string;
  }) {
    const key =
      input.repositoryId + "\0" + input.packageKey + "\0" + input.channel;
    const current = this.channels.get(key);
    const timestamp = now();
    const value: StoredKoshPackageChannel = {
      id: current?.id ?? randomUUID(),
      ...input,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.channels.set(key, value);
    return clone(value);
  }
}

function iso(value: unknown) {
  if (!value) return now();
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? now() : date.toISOString();
}

function versionFromRow(
  row: Record<string, unknown>
): StoredKoshPackageVersion {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    packageKey: String(row.package_key),
    name: String(row.name),
    version: String(row.version),
    filename: String(row.filename),
    format: String(row.format),
    mediaType: String(row.media_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    state: String(row.state) as KoshPackageState,
    commitSha: row.commit_sha ? String(row.commit_sha) : null,
    runId: row.run_id ? String(row.run_id) : null,
    provenance:
      row.provenance && typeof row.provenance === "object"
        ? row.provenance as Record<string, unknown>
        : {},
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? row.metadata as Record<string, unknown>
        : {},
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function channelFromRow(
  row: Record<string, unknown>
): StoredKoshPackageChannel {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    packageKey: String(row.package_key),
    channel: String(row.channel),
    versionId: String(row.version_id),
    version: String(row.version),
    updatedByUserId: String(row.updated_by_user_id),
    updatedByName: String(row.updated_by_name),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

class PostgresKoshPackageStore implements KoshPackageStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_package_versions (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      package_key TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      filename TEXT NOT NULL,
      format TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'published',
      commit_sha TEXT,
      run_id TEXT,
      provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, package_key, version),
      CHECK(state IN ('published','yanked'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_package_versions_repo_idx
      ON kosh_package_versions(repository_id, package_key, created_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_package_channels (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      package_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      version_id TEXT NOT NULL,
      version TEXT NOT NULL,
      updated_by_user_id TEXT NOT NULL,
      updated_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, package_key, channel)
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_package_channels_repo_idx
      ON kosh_package_channels(repository_id, package_key, channel)`;

    this.initialized = true;
  }

  async listVersions(repositoryId: string, packageKey?: string) {
    await this.ready();
    const rows = packageKey
      ? await this.sql`
          SELECT * FROM kosh_package_versions
          WHERE repository_id = ${repositoryId}
            AND package_key = ${packageKey}
          ORDER BY created_at DESC
          LIMIT 5000
        `
      : await this.sql`
          SELECT * FROM kosh_package_versions
          WHERE repository_id = ${repositoryId}
          ORDER BY created_at DESC
          LIMIT 5000
        `;

    return rows.map((row) =>
      versionFromRow(row as Record<string, unknown>)
    );
  }

  async getVersion(
    repositoryId: string,
    packageKey: string,
    version: string
  ) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_package_versions
      WHERE repository_id = ${repositoryId}
        AND package_key = ${packageKey}
        AND version = ${version}
      LIMIT 1
    `;
    return rows[0]
      ? versionFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async getVersionById(repositoryId: string, id: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_package_versions
      WHERE repository_id = ${repositoryId} AND id = ${id}
      LIMIT 1
    `;
    return rows[0]
      ? versionFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async createVersion(
    input: Omit<StoredKoshPackageVersion, "id" | "createdAt" | "updatedAt">
  ) {
    await this.ready();

    try {
      const rows = await this.sql`
        INSERT INTO kosh_package_versions(
          id, repository_id, package_key, name, version, filename,
          format, media_type, size_bytes, sha256, state, commit_sha,
          run_id, provenance, metadata, created_by_user_id, created_by_name
        )
        VALUES(
          ${randomUUID()}, ${input.repositoryId}, ${input.packageKey},
          ${input.name}, ${input.version}, ${input.filename},
          ${input.format}, ${input.mediaType}, ${input.sizeBytes},
          ${input.sha256}, ${input.state}, ${input.commitSha},
          ${input.runId}, ${JSON.stringify(input.provenance)}::jsonb,
          ${JSON.stringify(input.metadata)}::jsonb,
          ${input.createdByUserId}, ${input.createdByName}
        )
        RETURNING *
      `;
      return versionFromRow(rows[0] as Record<string, unknown>);
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw Object.assign(new Error("package_version_immutable"), {
          status: 409
        });
      }
      throw error;
    }
  }

  async deleteVersionForRollback(repositoryId: string, id: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_package_versions
      WHERE repository_id = ${repositoryId} AND id = ${id}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async setVersionState(
    repositoryId: string,
    id: string,
    state: KoshPackageState
  ) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_package_versions
      SET state = ${state}, updated_at = NOW()
      WHERE repository_id = ${repositoryId} AND id = ${id}
      RETURNING *
    `;
    return rows[0]
      ? versionFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async listChannels(repositoryId: string, packageKey?: string) {
    await this.ready();
    const rows = packageKey
      ? await this.sql`
          SELECT * FROM kosh_package_channels
          WHERE repository_id = ${repositoryId}
            AND package_key = ${packageKey}
          ORDER BY channel ASC
        `
      : await this.sql`
          SELECT * FROM kosh_package_channels
          WHERE repository_id = ${repositoryId}
          ORDER BY package_key ASC, channel ASC
        `;

    return rows.map((row) =>
      channelFromRow(row as Record<string, unknown>)
    );
  }

  async getChannel(
    repositoryId: string,
    packageKey: string,
    channel: string
  ) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_package_channels
      WHERE repository_id = ${repositoryId}
        AND package_key = ${packageKey}
        AND channel = ${channel}
      LIMIT 1
    `;
    return rows[0]
      ? channelFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async putChannel(input: {
    repositoryId: string;
    packageKey: string;
    channel: string;
    versionId: string;
    version: string;
    updatedByUserId: string;
    updatedByName: string;
  }) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_package_channels(
        id, repository_id, package_key, channel, version_id, version,
        updated_by_user_id, updated_by_name
      )
      VALUES(
        ${randomUUID()}, ${input.repositoryId}, ${input.packageKey},
        ${input.channel}, ${input.versionId}, ${input.version},
        ${input.updatedByUserId}, ${input.updatedByName}
      )
      ON CONFLICT(repository_id, package_key, channel)
      DO UPDATE SET
        version_id = EXCLUDED.version_id,
        version = EXCLUDED.version,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_by_name = EXCLUDED.updated_by_name,
        updated_at = NOW()
      RETURNING *
    `;
    return channelFromRow(rows[0] as Record<string, unknown>);
  }
}

let singleton: KoshPackageStore | null = null;

export function getKoshPackageStore(): KoshPackageStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshPackageStore(
        postgres(databaseUrl, { max: 5, prepare: false })
      )
    : new MemoryKoshPackageStore();
  return singleton;
}
