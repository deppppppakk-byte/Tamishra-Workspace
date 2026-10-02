import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshReleaseState = "draft" | "published" | "archived";

export type StoredKoshRelease = {
  id: string;
  repositoryId: string;
  tag: string;
  name: string;
  notes: string;
  commitSha: string;
  state: KoshReleaseState;
  prerelease: boolean;
  provenance: Record<string, unknown>;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
};

export type StoredKoshReleaseAsset = {
  id: string;
  repositoryId: string;
  releaseId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

export type StoredKoshReleasePackage = {
  id: string;
  repositoryId: string;
  releaseId: string;
  packageVersionId: string;
  packageKey: string;
  version: string;
  sha256: string;
  createdAt: string;
};

export type StoredKoshReleaseChannel = {
  id: string;
  repositoryId: string;
  channel: string;
  releaseId: string;
  tag: string;
  updatedByUserId: string;
  updatedByName: string;
  createdAt: string;
  updatedAt: string;
};

export interface KoshReleaseStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;

  listReleases(repositoryId: string): Promise<StoredKoshRelease[]>;
  getRelease(repositoryId: string, tag: string): Promise<StoredKoshRelease | null>;
  getReleaseById(repositoryId: string, id: string): Promise<StoredKoshRelease | null>;
  createRelease(
    input: Omit<StoredKoshRelease, "createdAt" | "publishedAt" | "updatedAt">
  ): Promise<StoredKoshRelease>;
  deleteReleaseForRollback(repositoryId: string, id: string): Promise<boolean>;
  setReleaseState(
    repositoryId: string,
    id: string,
    state: KoshReleaseState
  ): Promise<StoredKoshRelease | null>;

  listAssets(releaseId: string): Promise<StoredKoshReleaseAsset[]>;
  createAsset(
    input: Omit<StoredKoshReleaseAsset, "createdAt">
  ): Promise<StoredKoshReleaseAsset>;
  deleteAssetForRollback(releaseId: string, id: string): Promise<boolean>;

  listPackages(releaseId: string): Promise<StoredKoshReleasePackage[]>;
  linkPackage(
    input: Omit<StoredKoshReleasePackage, "id" | "createdAt">
  ): Promise<StoredKoshReleasePackage>;

  listChannels(repositoryId: string): Promise<StoredKoshReleaseChannel[]>;
  getChannel(
    repositoryId: string,
    channel: string
  ): Promise<StoredKoshReleaseChannel | null>;
  putChannel(input: {
    repositoryId: string;
    channel: string;
    releaseId: string;
    tag: string;
    updatedByUserId: string;
    updatedByName: string;
  }): Promise<StoredKoshReleaseChannel>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryKoshReleaseStore implements KoshReleaseStore {
  readonly kind = "ephemeral-memory" as const;
  private releases = new Map<string, StoredKoshRelease>();
  private assets = new Map<string, StoredKoshReleaseAsset>();
  private packages = new Map<string, StoredKoshReleasePackage>();
  private channels = new Map<string, StoredKoshReleaseChannel>();

  async ready() {}

  async listReleases(repositoryId: string) {
    return [...this.releases.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async getRelease(repositoryId: string, tag: string) {
    const item = [...this.releases.values()].find(
      (candidate) =>
        candidate.repositoryId === repositoryId &&
        candidate.tag === tag
    );
    return item ? clone(item) : null;
  }

  async getReleaseById(repositoryId: string, id: string) {
    const item = this.releases.get(id);
    return item && item.repositoryId === repositoryId ? clone(item) : null;
  }

  async createRelease(
    input: Omit<StoredKoshRelease, "createdAt" | "publishedAt" | "updatedAt">
  ) {
    const duplicate = [...this.releases.values()].find(
      (item) =>
        item.repositoryId === input.repositoryId &&
        item.tag === input.tag
    );
    if (duplicate) {
      throw Object.assign(new Error("release_tag_immutable"), {
        status: 409
      });
    }
    const timestamp = now();
    const value: StoredKoshRelease = {
      ...input,
      createdAt: timestamp,
      publishedAt: input.state === "published" ? timestamp : null,
      updatedAt: timestamp
    };
    this.releases.set(value.id, value);
    return clone(value);
  }

  async deleteReleaseForRollback(repositoryId: string, id: string) {
    const item = this.releases.get(id);
    if (!item || item.repositoryId !== repositoryId) return false;
    this.releases.delete(id);
    for (const [assetId, asset] of this.assets) {
      if (asset.releaseId === id) this.assets.delete(assetId);
    }
    for (const [linkId, link] of this.packages) {
      if (link.releaseId === id) this.packages.delete(linkId);
    }
    for (const [key, channel] of this.channels) {
      if (channel.releaseId === id) this.channels.delete(key);
    }
    return true;
  }

  async setReleaseState(
    repositoryId: string,
    id: string,
    state: KoshReleaseState
  ) {
    const item = this.releases.get(id);
    if (!item || item.repositoryId !== repositoryId) return null;
    const timestamp = now();
    item.state = state;
    item.updatedAt = timestamp;
    if (state === "published" && !item.publishedAt) {
      item.publishedAt = timestamp;
    }
    return clone(item);
  }

  async listAssets(releaseId: string) {
    return [...this.assets.values()]
      .filter((item) => item.releaseId === releaseId)
      .sort((a, b) => a.filename.localeCompare(b.filename))
      .map(clone);
  }

  async createAsset(
    input: Omit<StoredKoshReleaseAsset, "createdAt">
  ) {
    if (
      [...this.assets.values()].some(
        (item) =>
          item.releaseId === input.releaseId &&
          item.filename === input.filename
      )
    ) {
      throw Object.assign(new Error("release_asset_immutable"), {
        status: 409
      });
    }
    const value: StoredKoshReleaseAsset = {
      ...input,
      createdAt: now()
    };
    this.assets.set(value.id, value);
    return clone(value);
  }

  async deleteAssetForRollback(releaseId: string, id: string) {
    const item = this.assets.get(id);
    if (!item || item.releaseId !== releaseId) return false;
    return this.assets.delete(id);
  }

  async listPackages(releaseId: string) {
    return [...this.packages.values()]
      .filter((item) => item.releaseId === releaseId)
      .map(clone);
  }

  async linkPackage(
    input: Omit<StoredKoshReleasePackage, "id" | "createdAt">
  ) {
    const existing = [...this.packages.values()].find(
      (item) =>
        item.releaseId === input.releaseId &&
        item.packageVersionId === input.packageVersionId
    );
    if (existing) return clone(existing);

    const value: StoredKoshReleasePackage = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.packages.set(value.id, value);
    return clone(value);
  }

  async listChannels(repositoryId: string) {
    return [...this.channels.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => a.channel.localeCompare(b.channel))
      .map(clone);
  }

  async getChannel(repositoryId: string, channel: string) {
    const key = repositoryId + "\0" + channel;
    const item = this.channels.get(key);
    return item ? clone(item) : null;
  }

  async putChannel(input: {
    repositoryId: string;
    channel: string;
    releaseId: string;
    tag: string;
    updatedByUserId: string;
    updatedByName: string;
  }) {
    const key = input.repositoryId + "\0" + input.channel;
    const current = this.channels.get(key);
    const timestamp = now();
    const value: StoredKoshReleaseChannel = {
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
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function releaseFromRow(row: Record<string, unknown>): StoredKoshRelease {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    tag: String(row.tag),
    name: String(row.name),
    notes: String(row.notes ?? ""),
    commitSha: String(row.commit_sha),
    state: String(row.state) as KoshReleaseState,
    prerelease: Boolean(row.prerelease),
    provenance:
      row.provenance && typeof row.provenance === "object"
        ? row.provenance as Record<string, unknown>
        : {},
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at) ?? now(),
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function assetFromRow(
  row: Record<string, unknown>
): StoredKoshReleaseAsset {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    releaseId: String(row.release_id),
    filename: String(row.filename),
    mediaType: String(row.media_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    createdAt: iso(row.created_at) ?? now()
  };
}

function packageFromRow(
  row: Record<string, unknown>
): StoredKoshReleasePackage {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    releaseId: String(row.release_id),
    packageVersionId: String(row.package_version_id),
    packageKey: String(row.package_key),
    version: String(row.version),
    sha256: String(row.sha256),
    createdAt: iso(row.created_at) ?? now()
  };
}

function channelFromRow(
  row: Record<string, unknown>
): StoredKoshReleaseChannel {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    channel: String(row.channel),
    releaseId: String(row.release_id),
    tag: String(row.tag),
    updatedByUserId: String(row.updated_by_user_id),
    updatedByName: String(row.updated_by_name),
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

class PostgresKoshReleaseStore implements KoshReleaseStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_releases (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      name TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      commit_sha TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft',
      prerelease BOOLEAN NOT NULL DEFAULT FALSE,
      provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, tag),
      CHECK(state IN ('draft','published','archived'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_releases_repo_idx
      ON kosh_releases(repository_id, created_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_release_assets (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(release_id, filename)
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_release_assets_release_idx
      ON kosh_release_assets(release_id, filename)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_release_packages (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      release_id TEXT NOT NULL,
      package_version_id TEXT NOT NULL,
      package_key TEXT NOT NULL,
      version TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(release_id, package_version_id)
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_release_packages_release_idx
      ON kosh_release_packages(release_id, created_at ASC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_release_channels (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      release_id TEXT NOT NULL,
      tag TEXT NOT NULL,
      updated_by_user_id TEXT NOT NULL,
      updated_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, channel)
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_release_channels_repo_idx
      ON kosh_release_channels(repository_id, channel)`;

    this.initialized = true;
  }

  async listReleases(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_releases
      WHERE repository_id = ${repositoryId}
      ORDER BY created_at DESC
      LIMIT 2000
    `;
    return rows.map((row) =>
      releaseFromRow(row as Record<string, unknown>)
    );
  }

  async getRelease(repositoryId: string, tag: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_releases
      WHERE repository_id = ${repositoryId} AND tag = ${tag}
      LIMIT 1
    `;
    return rows[0]
      ? releaseFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async getReleaseById(repositoryId: string, id: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_releases
      WHERE repository_id = ${repositoryId} AND id = ${id}
      LIMIT 1
    `;
    return rows[0]
      ? releaseFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async createRelease(
    input: Omit<StoredKoshRelease, "createdAt" | "publishedAt" | "updatedAt">
  ) {
    await this.ready();
    try {
      const rows = await this.sql`
        INSERT INTO kosh_releases(
          id, repository_id, tag, name, notes, commit_sha, state,
          prerelease, provenance, created_by_user_id, created_by_name,
          published_at
        )
        VALUES(
          ${input.id}, ${input.repositoryId}, ${input.tag}, ${input.name},
          ${input.notes}, ${input.commitSha}, ${input.state},
          ${input.prerelease}, ${JSON.stringify(input.provenance)}::jsonb,
          ${input.createdByUserId}, ${input.createdByName},
          CASE WHEN ${input.state} = 'published' THEN NOW() ELSE NULL END
        )
        RETURNING *
      `;
      return releaseFromRow(rows[0] as Record<string, unknown>);
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw Object.assign(new Error("release_tag_immutable"), {
          status: 409
        });
      }
      throw error;
    }
  }

  async deleteReleaseForRollback(repositoryId: string, id: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_releases
      WHERE repository_id = ${repositoryId} AND id = ${id}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async setReleaseState(
    repositoryId: string,
    id: string,
    state: KoshReleaseState
  ) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_releases
      SET state = ${state},
          published_at = CASE
            WHEN ${state} = 'published' AND published_at IS NULL THEN NOW()
            ELSE published_at
          END,
          updated_at = NOW()
      WHERE repository_id = ${repositoryId} AND id = ${id}
      RETURNING *
    `;
    return rows[0]
      ? releaseFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async listAssets(releaseId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_release_assets
      WHERE release_id = ${releaseId}
      ORDER BY filename ASC
    `;
    return rows.map((row) =>
      assetFromRow(row as Record<string, unknown>)
    );
  }

  async createAsset(
    input: Omit<StoredKoshReleaseAsset, "createdAt">
  ) {
    await this.ready();
    try {
      const rows = await this.sql`
        INSERT INTO kosh_release_assets(
          id, repository_id, release_id, filename,
          media_type, size_bytes, sha256
        )
        VALUES(
          ${input.id}, ${input.repositoryId}, ${input.releaseId},
          ${input.filename}, ${input.mediaType}, ${input.sizeBytes},
          ${input.sha256}
        )
        RETURNING *
      `;
      return assetFromRow(rows[0] as Record<string, unknown>);
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw Object.assign(new Error("release_asset_immutable"), {
          status: 409
        });
      }
      throw error;
    }
  }

  async deleteAssetForRollback(releaseId: string, id: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_release_assets
      WHERE release_id = ${releaseId} AND id = ${id}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async listPackages(releaseId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_release_packages
      WHERE release_id = ${releaseId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) =>
      packageFromRow(row as Record<string, unknown>)
    );
  }

  async linkPackage(
    input: Omit<StoredKoshReleasePackage, "id" | "createdAt">
  ) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_release_packages(
        id, repository_id, release_id, package_version_id,
        package_key, version, sha256
      )
      VALUES(
        ${randomUUID()}, ${input.repositoryId}, ${input.releaseId},
        ${input.packageVersionId}, ${input.packageKey},
        ${input.version}, ${input.sha256}
      )
      ON CONFLICT(release_id, package_version_id)
      DO UPDATE SET package_version_id = EXCLUDED.package_version_id
      RETURNING *
    `;
    return packageFromRow(rows[0] as Record<string, unknown>);
  }

  async listChannels(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_release_channels
      WHERE repository_id = ${repositoryId}
      ORDER BY channel ASC
    `;
    return rows.map((row) =>
      channelFromRow(row as Record<string, unknown>)
    );
  }

  async getChannel(repositoryId: string, channel: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_release_channels
      WHERE repository_id = ${repositoryId} AND channel = ${channel}
      LIMIT 1
    `;
    return rows[0]
      ? channelFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async putChannel(input: {
    repositoryId: string;
    channel: string;
    releaseId: string;
    tag: string;
    updatedByUserId: string;
    updatedByName: string;
  }) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_release_channels(
        id, repository_id, channel, release_id, tag,
        updated_by_user_id, updated_by_name
      )
      VALUES(
        ${randomUUID()}, ${input.repositoryId}, ${input.channel},
        ${input.releaseId}, ${input.tag}, ${input.updatedByUserId},
        ${input.updatedByName}
      )
      ON CONFLICT(repository_id, channel)
      DO UPDATE SET
        release_id = EXCLUDED.release_id,
        tag = EXCLUDED.tag,
        updated_by_user_id = EXCLUDED.updated_by_user_id,
        updated_by_name = EXCLUDED.updated_by_name,
        updated_at = NOW()
      RETURNING *
    `;
    return channelFromRow(rows[0] as Record<string, unknown>);
  }
}

let singleton: KoshReleaseStore | null = null;

export function getKoshReleaseStore(): KoshReleaseStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshReleaseStore(
        postgres(databaseUrl, { max: 5, prepare: false })
      )
    : new MemoryKoshReleaseStore();
  return singleton;
}
