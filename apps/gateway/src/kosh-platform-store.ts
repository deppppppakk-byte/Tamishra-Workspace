import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshPlatformResourceType =
  | "package"
  | "package_channel"
  | "release"
  | "security_finding"
  | "organization"
  | "team"
  | "merge_queue_entry"
  | "dev_environment"
  | "wiki_page"
  | "page_site"
  | "webhook"
  | "subscription"
  | "project_field"
  | "storage_policy"
  | "backup"
  | "extension"
  | "admin_setting"
  | "code_index"
  | "code_owner_rule"
  | "deployment_policy";

export type StoredKoshPlatformResource = {
  id: string;
  repositoryId: string | null;
  namespace: string;
  type: KoshPlatformResourceType;
  key: string;
  name: string;
  state: string;
  payload: Record<string, unknown>;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshSecret = {
  id: string;
  repositoryId: string | null;
  environmentName: string | null;
  name: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshSshKey = {
  id: string;
  userId: string;
  title: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type StoredKoshApiToken = {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export type StoredKoshAuditEvent = {
  id: string;
  repositoryId: string | null;
  actorUserId: string | null;
  actorName: string;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export interface KoshPlatformStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;

  listResources(
    type?: KoshPlatformResourceType,
    repositoryId?: string | null
  ): Promise<StoredKoshPlatformResource[]>;
  getResource(id: string): Promise<StoredKoshPlatformResource | null>;
  createResource(
    input: Omit<StoredKoshPlatformResource, "id" | "createdAt" | "updatedAt">
  ): Promise<StoredKoshPlatformResource>;
  updateResource(
    id: string,
    input: Partial<Pick<StoredKoshPlatformResource, "name" | "state" | "payload">>
  ): Promise<StoredKoshPlatformResource | null>;
  deleteResource(id: string): Promise<boolean>;

  listSecrets(repositoryId?: string | null): Promise<StoredKoshSecret[]>;
  putSecret(input: {
    repositoryId: string | null;
    environmentName: string | null;
    name: string;
    value: string;
    createdByUserId: string;
    createdByName: string;
  }): Promise<StoredKoshSecret>;
  resolveSecret(
    repositoryId: string | null,
    environmentName: string | null,
    name: string
  ): Promise<string | null>;
  deleteSecret(id: string): Promise<boolean>;

  listSshKeys(userId: string): Promise<StoredKoshSshKey[]>;
  findSshKeyByFingerprint(
    fingerprint: string
  ): Promise<StoredKoshSshKey | null>;
  getSshKey(userId: string, id: string): Promise<StoredKoshSshKey | null>;
  createSshKey(input: {
    userId: string;
    title: string;
    publicKey: string;
  }): Promise<StoredKoshSshKey>;
  touchSshKey(userId: string, id: string): Promise<void>;
  deleteSshKey(userId: string, id: string): Promise<boolean>;

  listApiTokens(userId: string): Promise<StoredKoshApiToken[]>;
  createApiToken(input: {
    userId: string;
    name: string;
    scopes: string[];
    expiresAt: string | null;
  }): Promise<{ token: string; record: StoredKoshApiToken }>;
  authenticateApiToken(token: string): Promise<StoredKoshApiToken | null>;
  deleteApiToken(userId: string, id: string): Promise<boolean>;

  appendAudit(
    input: Omit<StoredKoshAuditEvent, "id" | "createdAt">
  ): Promise<StoredKoshAuditEvent>;
  listAudit(
    repositoryId?: string | null,
    limit?: number
  ): Promise<StoredKoshAuditEvent[]>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function masterKey() {
  const raw = process.env.KOSH_MASTER_KEY?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("kosh_master_key_required"), { status: 503 });
    }
    return createHash("sha256")
      .update("kosh-development-master-key")
      .digest();
  }
  return createHash("sha256").update(raw).digest();
}

function encryptSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url")
  ].join(".");
}

function decryptSecret(value: string) {
  const [ivText, tagText, dataText] = value.split(".");
  if (!ivText || !tagText || !dataText) {
    throw new Error("invalid_encrypted_secret");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

function sshFingerprint(publicKey: string) {
  const value = publicKey.trim();
  if (!value || value.length > 32 * 1024 || value.includes("\n") || value.includes("\r")) {
    throw Object.assign(new Error("invalid_ssh_public_key"), { status: 400 });
  }

  const parts = value.split(/\s+/);
  const algorithm = parts[0] ?? "";
  const encoded = parts[1] ?? "";
  const allowedAlgorithms = new Set([
    "ssh-ed25519",
    "sk-ssh-ed25519@openssh.com",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ecdsa-sha2-nistp256@openssh.com",
    "ssh-rsa"
  ]);

  if (
    !allowedAlgorithms.has(algorithm) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
  ) {
    throw Object.assign(new Error("unsupported_ssh_public_key"), { status: 400 });
  }

  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length < 32 || bytes.length > 16 * 1024) {
    throw Object.assign(new Error("invalid_ssh_public_key"), { status: 400 });
  }

  return (
    "SHA256:" +
    createHash("sha256")
      .update(bytes)
      .digest("base64")
      .replace(/=+$/g, "")
  );
}

function newApiToken() {
  return "kosh_pat_" + randomBytes(32).toString("base64url");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

class MemoryKoshPlatformStore implements KoshPlatformStore {
  readonly kind = "ephemeral-memory" as const;
  private resources = new Map<string, StoredKoshPlatformResource>();
  private secrets = new Map<string, StoredKoshSecret & { encryptedValue: string }>();
  private sshKeys = new Map<string, StoredKoshSshKey>();
  private apiTokens = new Map<string, StoredKoshApiToken & { tokenHash: string }>();
  private audit = new Map<string, StoredKoshAuditEvent>();

  async ready() {}

  async listResources(type?: KoshPlatformResourceType, repositoryId?: string | null) {
    return [...this.resources.values()]
      .filter(
        (item) =>
          (!type || item.type === type) &&
          (repositoryId === undefined || item.repositoryId === repositoryId)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  async getResource(id: string) {
    const item = this.resources.get(id);
    return item ? clone(item) : null;
  }

  async createResource(
    input: Omit<StoredKoshPlatformResource, "id" | "createdAt" | "updatedAt">
  ) {
    const duplicate = [...this.resources.values()].find(
      (item) =>
        item.type === input.type &&
        item.repositoryId === input.repositoryId &&
        item.key === input.key
    );
    if (duplicate) {
      throw Object.assign(new Error("platform_resource_exists"), { status: 409 });
    }

    const created = now();
    const item: StoredKoshPlatformResource = {
      ...input,
      id: randomUUID(),
      createdAt: created,
      updatedAt: created
    };
    this.resources.set(item.id, item);
    return clone(item);
  }

  async updateResource(
    id: string,
    input: Partial<Pick<StoredKoshPlatformResource, "name" | "state" | "payload">>
  ) {
    const item = this.resources.get(id);
    if (!item) return null;
    if (input.name !== undefined) item.name = input.name;
    if (input.state !== undefined) item.state = input.state;
    if (input.payload !== undefined) item.payload = input.payload;
    item.updatedAt = now();
    return clone(item);
  }

  async deleteResource(id: string) {
    return this.resources.delete(id);
  }

  async listSecrets(repositoryId?: string | null) {
    return [...this.secrets.values()]
      .filter(
        (item) =>
          repositoryId === undefined || item.repositoryId === repositoryId
      )
      .map(({ encryptedValue: _encryptedValue, ...item }) => clone(item));
  }

  async putSecret(input: {
    repositoryId: string | null;
    environmentName: string | null;
    name: string;
    value: string;
    createdByUserId: string;
    createdByName: string;
  }) {
    const existing = [...this.secrets.values()].find(
      (item) =>
        item.repositoryId === input.repositoryId &&
        item.environmentName === input.environmentName &&
        item.name === input.name
    );
    const timestamp = now();
    const item: StoredKoshSecret & { encryptedValue: string } = {
      id: existing?.id ?? randomUUID(),
      repositoryId: input.repositoryId,
      environmentName: input.environmentName,
      name: input.name,
      createdByUserId: input.createdByUserId,
      createdByName: input.createdByName,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      encryptedValue: encryptSecret(input.value)
    };
    this.secrets.set(item.id, item);
    const { encryptedValue: _encryptedValue, ...publicItem } = item;
    return clone(publicItem);
  }

  async resolveSecret(
    repositoryId: string | null,
    environmentName: string | null,
    name: string
  ) {
    const item = [...this.secrets.values()].find(
      (secret) =>
        secret.repositoryId === repositoryId &&
        secret.environmentName === environmentName &&
        secret.name === name
    );
    return item ? decryptSecret(item.encryptedValue) : null;
  }

  async deleteSecret(id: string) {
    return this.secrets.delete(id);
  }

  async listSshKeys(userId: string) {
    return [...this.sshKeys.values()]
      .filter((item) => item.userId === userId)
      .map(clone);
  }

  async findSshKeyByFingerprint(fingerprint: string) {
    const item = [...this.sshKeys.values()].find(
      (candidate) => candidate.fingerprint === fingerprint
    );
    return item ? clone(item) : null;
  }

  async getSshKey(userId: string, id: string) {
    const item = this.sshKeys.get(id);
    return item && item.userId === userId ? clone(item) : null;
  }

  async createSshKey(input: { userId: string; title: string; publicKey: string }) {
    const fingerprint = sshFingerprint(input.publicKey);
    const duplicate = [...this.sshKeys.values()].find(
      (item) => item.fingerprint === fingerprint
    );
    if (duplicate) {
      throw Object.assign(new Error("ssh_key_exists"), { status: 409 });
    }
    const item: StoredKoshSshKey = {
      id: randomUUID(),
      userId: input.userId,
      title: input.title,
      publicKey: input.publicKey.trim(),
      fingerprint,
      createdAt: now(),
      lastUsedAt: null
    };
    this.sshKeys.set(item.id, item);
    return clone(item);
  }

  async touchSshKey(userId: string, id: string) {
    const item = this.sshKeys.get(id);
    if (item && item.userId === userId) {
      item.lastUsedAt = now();
    }
  }

  async deleteSshKey(userId: string, id: string) {
    const item = this.sshKeys.get(id);
    if (!item || item.userId !== userId) return false;
    return this.sshKeys.delete(id);
  }

  async listApiTokens(userId: string) {
    return [...this.apiTokens.values()]
      .filter((item) => item.userId === userId)
      .map(({ tokenHash: _tokenHash, ...item }) => clone(item));
  }

  async createApiToken(input: {
    userId: string;
    name: string;
    scopes: string[];
    expiresAt: string | null;
  }) {
    const token = newApiToken();
    const item: StoredKoshApiToken & { tokenHash: string } = {
      id: randomUUID(),
      userId: input.userId,
      name: input.name,
      tokenPrefix: token.slice(0, 18),
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      lastUsedAt: null,
      createdAt: now(),
      tokenHash: tokenHash(token)
    };
    this.apiTokens.set(item.id, item);
    const { tokenHash: _tokenHash, ...record } = item;
    return { token, record: clone(record) };
  }

  async authenticateApiToken(token: string) {
    const hash = tokenHash(token);
    const item = [...this.apiTokens.values()].find(
      (candidate) => candidate.tokenHash === hash
    );
    if (!item) return null;
    if (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    item.lastUsedAt = now();
    const { tokenHash: _tokenHash, ...record } = item;
    return clone(record);
  }

  async deleteApiToken(userId: string, id: string) {
    const item = this.apiTokens.get(id);
    if (!item || item.userId !== userId) return false;
    return this.apiTokens.delete(id);
  }

  async appendAudit(input: Omit<StoredKoshAuditEvent, "id" | "createdAt">) {
    const item: StoredKoshAuditEvent = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.audit.set(item.id, item);
    return clone(item);
  }

  async listAudit(repositoryId?: string | null, limit = 200) {
    return [...this.audit.values()]
      .filter(
        (item) =>
          repositoryId === undefined || item.repositoryId === repositoryId
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(1000, limit)))
      .map(clone);
  }
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resourceFromRow(row: Record<string, unknown>): StoredKoshPlatformResource {
  return {
    id: String(row.id),
    repositoryId: row.repository_id ? String(row.repository_id) : null,
    namespace: String(row.namespace),
    type: String(row.type) as KoshPlatformResourceType,
    key: String(row.resource_key),
    name: String(row.name),
    state: String(row.state),
    payload:
      row.payload && typeof row.payload === "object"
        ? row.payload as Record<string, unknown>
        : {},
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

class PostgresKoshPlatformStore implements KoshPlatformStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_platform_resources (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      namespace TEXT NOT NULL,
      type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, type, resource_key)
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_platform_resources_type_idx
      ON kosh_platform_resources(type, updated_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_secrets (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      environment_name TEXT,
      name TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS kosh_secrets_scope_idx
      ON kosh_secrets(COALESCE(repository_id, ''), COALESCE(environment_name, ''), name)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_ssh_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      public_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_prefix TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      expires_at TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_audit_events (
      id TEXT PRIMARY KEY,
      repository_id TEXT,
      actor_user_id TEXT,
      actor_name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_audit_repository_idx
      ON kosh_audit_events(repository_id, created_at DESC)`;

    this.initialized = true;
  }

  async listResources(type?: KoshPlatformResourceType, repositoryId?: string | null) {
    await this.ready();
    const rows =
      type && repositoryId !== undefined
        ? await this.sql`SELECT * FROM kosh_platform_resources WHERE type = ${type} AND repository_id IS NOT DISTINCT FROM ${repositoryId} ORDER BY updated_at DESC LIMIT 1000`
        : type
          ? await this.sql`SELECT * FROM kosh_platform_resources WHERE type = ${type} ORDER BY updated_at DESC LIMIT 1000`
          : repositoryId !== undefined
            ? await this.sql`SELECT * FROM kosh_platform_resources WHERE repository_id IS NOT DISTINCT FROM ${repositoryId} ORDER BY updated_at DESC LIMIT 1000`
            : await this.sql`SELECT * FROM kosh_platform_resources ORDER BY updated_at DESC LIMIT 1000`;
    return rows.map((row) => resourceFromRow(row as Record<string, unknown>));
  }

  async getResource(id: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_platform_resources WHERE id = ${id} LIMIT 1`;
    return rows[0] ? resourceFromRow(rows[0] as Record<string, unknown>) : null;
  }

  async createResource(
    input: Omit<StoredKoshPlatformResource, "id" | "createdAt" | "updatedAt">
  ) {
    await this.ready();
    try {
      const rows = await this.sql`
        INSERT INTO kosh_platform_resources(
          id, repository_id, namespace, type, resource_key, name, state, payload,
          created_by_user_id, created_by_name
        )
        VALUES(
          ${randomUUID()}, ${input.repositoryId}, ${input.namespace}, ${input.type},
          ${input.key}, ${input.name}, ${input.state},
          ${JSON.stringify(input.payload)}::jsonb,
          ${input.createdByUserId}, ${input.createdByName}
        )
        RETURNING *
      `;
      return resourceFromRow(rows[0] as Record<string, unknown>);
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw Object.assign(new Error("platform_resource_exists"), { status: 409 });
      }
      throw error;
    }
  }

  async updateResource(
    id: string,
    input: Partial<Pick<StoredKoshPlatformResource, "name" | "state" | "payload">>
  ) {
    await this.ready();
    const current = await this.getResource(id);
    if (!current) return null;
    const rows = await this.sql`
      UPDATE kosh_platform_resources
      SET name = ${input.name ?? current.name},
          state = ${input.state ?? current.state},
          payload = ${JSON.stringify(input.payload ?? current.payload)}::jsonb,
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? resourceFromRow(rows[0] as Record<string, unknown>) : null;
  }

  async deleteResource(id: string) {
    await this.ready();
    const rows = await this.sql`DELETE FROM kosh_platform_resources WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  }

  async listSecrets(repositoryId?: string | null) {
    await this.ready();
    const rows =
      repositoryId === undefined
        ? await this.sql`SELECT id, repository_id, environment_name, name, created_by_user_id, created_by_name, created_at, updated_at FROM kosh_secrets ORDER BY name ASC`
        : await this.sql`SELECT id, repository_id, environment_name, name, created_by_user_id, created_by_name, created_at, updated_at FROM kosh_secrets WHERE repository_id IS NOT DISTINCT FROM ${repositoryId} ORDER BY name ASC`;
    return rows.map((row) => ({
      id: String(row.id),
      repositoryId: row.repository_id ? String(row.repository_id) : null,
      environmentName: row.environment_name ? String(row.environment_name) : null,
      name: String(row.name),
      createdByUserId: String(row.created_by_user_id),
      createdByName: String(row.created_by_name),
      createdAt: iso(row.created_at) ?? now(),
      updatedAt: iso(row.updated_at) ?? now()
    }));
  }

  async putSecret(input: {
    repositoryId: string | null;
    environmentName: string | null;
    name: string;
    value: string;
    createdByUserId: string;
    createdByName: string;
  }) {
    await this.ready();
    const encryptedValue = encryptSecret(input.value);
    const existing = await this.sql`
      SELECT id FROM kosh_secrets
      WHERE repository_id IS NOT DISTINCT FROM ${input.repositoryId}
        AND environment_name IS NOT DISTINCT FROM ${input.environmentName}
        AND name = ${input.name}
      LIMIT 1
    `;
    const rows = existing[0]
      ? await this.sql`
          UPDATE kosh_secrets
          SET encrypted_value = ${encryptedValue},
              created_by_user_id = ${input.createdByUserId},
              created_by_name = ${input.createdByName},
              updated_at = NOW()
          WHERE id = ${String(existing[0].id)}
          RETURNING id, repository_id, environment_name, name, created_by_user_id, created_by_name, created_at, updated_at
        `
      : await this.sql`
          INSERT INTO kosh_secrets(
            id, repository_id, environment_name, name, encrypted_value,
            created_by_user_id, created_by_name
          )
          VALUES(
            ${randomUUID()}, ${input.repositoryId}, ${input.environmentName},
            ${input.name}, ${encryptedValue}, ${input.createdByUserId}, ${input.createdByName}
          )
          RETURNING id, repository_id, environment_name, name, created_by_user_id, created_by_name, created_at, updated_at
        `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      repositoryId: row.repository_id ? String(row.repository_id) : null,
      environmentName: row.environment_name ? String(row.environment_name) : null,
      name: String(row.name),
      createdByUserId: String(row.created_by_user_id),
      createdByName: String(row.created_by_name),
      createdAt: iso(row.created_at) ?? now(),
      updatedAt: iso(row.updated_at) ?? now()
    };
  }

  async resolveSecret(repositoryId: string | null, environmentName: string | null, name: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT encrypted_value FROM kosh_secrets
      WHERE repository_id IS NOT DISTINCT FROM ${repositoryId}
        AND environment_name IS NOT DISTINCT FROM ${environmentName}
        AND name = ${name}
      LIMIT 1
    `;
    return rows[0]?.encrypted_value
      ? decryptSecret(String(rows[0].encrypted_value))
      : null;
  }

  async deleteSecret(id: string) {
    await this.ready();
    const rows = await this.sql`DELETE FROM kosh_secrets WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  }

  async listSshKeys(userId: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_ssh_keys WHERE user_id = ${userId} ORDER BY created_at DESC`;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      title: String(row.title),
      publicKey: String(row.public_key),
      fingerprint: String(row.fingerprint),
      createdAt: iso(row.created_at) ?? now(),
      lastUsedAt: iso(row.last_used_at)
    }));
  }

  async findSshKeyByFingerprint(fingerprint: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_ssh_keys
      WHERE fingerprint = ${fingerprint}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row
      ? {
          id: String(row.id),
          userId: String(row.user_id),
          title: String(row.title),
          publicKey: String(row.public_key),
          fingerprint: String(row.fingerprint),
          createdAt: iso(row.created_at) ?? now(),
          lastUsedAt: iso(row.last_used_at)
        }
      : null;
  }

  async getSshKey(userId: string, id: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_ssh_keys
      WHERE id = ${id} AND user_id = ${userId}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row
      ? {
          id: String(row.id),
          userId: String(row.user_id),
          title: String(row.title),
          publicKey: String(row.public_key),
          fingerprint: String(row.fingerprint),
          createdAt: iso(row.created_at) ?? now(),
          lastUsedAt: iso(row.last_used_at)
        }
      : null;
  }

  async createSshKey(input: { userId: string; title: string; publicKey: string }) {
    await this.ready();
    const fingerprint = sshFingerprint(input.publicKey);
    try {
      const rows = await this.sql`
        INSERT INTO kosh_ssh_keys(id, user_id, title, public_key, fingerprint)
        VALUES(${randomUUID()}, ${input.userId}, ${input.title}, ${input.publicKey.trim()}, ${fingerprint})
        RETURNING *
      `;
      const row = rows[0] as Record<string, unknown>;
      return {
        id: String(row.id),
        userId: String(row.user_id),
        title: String(row.title),
        publicKey: String(row.public_key),
        fingerprint: String(row.fingerprint),
        createdAt: iso(row.created_at) ?? now(),
        lastUsedAt: iso(row.last_used_at)
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw Object.assign(new Error("ssh_key_exists"), { status: 409 });
      }
      throw error;
    }
  }

  async touchSshKey(userId: string, id: string) {
    await this.ready();
    await this.sql`
      UPDATE kosh_ssh_keys
      SET last_used_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
    `;
  }

  async deleteSshKey(userId: string, id: string) {
    await this.ready();
    const rows = await this.sql`DELETE FROM kosh_ssh_keys WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
    return rows.length > 0;
  }

  async listApiTokens(userId: string) {
    await this.ready();
    const rows = await this.sql`SELECT id, user_id, name, token_prefix, scopes, expires_at, last_used_at, created_at FROM kosh_api_tokens WHERE user_id = ${userId} ORDER BY created_at DESC`;
    return rows.map((row) => ({
      id: String(row.id),
      userId: String(row.user_id),
      name: String(row.name),
      tokenPrefix: String(row.token_prefix),
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      expiresAt: iso(row.expires_at),
      lastUsedAt: iso(row.last_used_at),
      createdAt: iso(row.created_at) ?? now()
    }));
  }

  async createApiToken(input: { userId: string; name: string; scopes: string[]; expiresAt: string | null }) {
    await this.ready();
    const token = newApiToken();
    const rows = await this.sql`
      INSERT INTO kosh_api_tokens(id, user_id, name, token_prefix, token_hash, scopes, expires_at)
      VALUES(
        ${randomUUID()}, ${input.userId}, ${input.name}, ${token.slice(0, 18)},
        ${tokenHash(token)}, ${JSON.stringify(input.scopes)}::jsonb, ${input.expiresAt}
      )
      RETURNING id, user_id, name, token_prefix, scopes, expires_at, last_used_at, created_at
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      token,
      record: {
        id: String(row.id),
        userId: String(row.user_id),
        name: String(row.name),
        tokenPrefix: String(row.token_prefix),
        scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
        expiresAt: iso(row.expires_at),
        lastUsedAt: iso(row.last_used_at),
        createdAt: iso(row.created_at) ?? now()
      }
    };
  }

  async authenticateApiToken(token: string) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_api_tokens
      SET last_used_at = NOW()
      WHERE token_hash = ${tokenHash(token)}
        AND (expires_at IS NULL OR expires_at > NOW())
      RETURNING id, user_id, name, token_prefix, scopes, expires_at, last_used_at, created_at
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row
      ? {
          id: String(row.id),
          userId: String(row.user_id),
          name: String(row.name),
          tokenPrefix: String(row.token_prefix),
          scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
          expiresAt: iso(row.expires_at),
          lastUsedAt: iso(row.last_used_at),
          createdAt: iso(row.created_at) ?? now()
        }
      : null;
  }

  async deleteApiToken(userId: string, id: string) {
    await this.ready();
    const rows = await this.sql`DELETE FROM kosh_api_tokens WHERE id = ${id} AND user_id = ${userId} RETURNING id`;
    return rows.length > 0;
  }

  async appendAudit(input: Omit<StoredKoshAuditEvent, "id" | "createdAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_audit_events(
        id, repository_id, actor_user_id, actor_name, event_type,
        resource_type, resource_id, metadata
      )
      VALUES(
        ${randomUUID()}, ${input.repositoryId}, ${input.actorUserId},
        ${input.actorName}, ${input.eventType}, ${input.resourceType},
        ${input.resourceId}, ${JSON.stringify(input.metadata)}::jsonb
      )
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      repositoryId: row.repository_id ? String(row.repository_id) : null,
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      actorName: String(row.actor_name),
      eventType: String(row.event_type),
      resourceType: String(row.resource_type),
      resourceId: row.resource_id ? String(row.resource_id) : null,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? row.metadata as Record<string, unknown>
          : {},
      createdAt: iso(row.created_at) ?? now()
    };
  }

  async listAudit(repositoryId?: string | null, limit = 200) {
    await this.ready();
    const rows =
      repositoryId === undefined
        ? await this.sql`SELECT * FROM kosh_audit_events ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(1000, limit))}`
        : await this.sql`SELECT * FROM kosh_audit_events WHERE repository_id IS NOT DISTINCT FROM ${repositoryId} ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(1000, limit))}`;
    return rows.map((row) => ({
      id: String(row.id),
      repositoryId: row.repository_id ? String(row.repository_id) : null,
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      actorName: String(row.actor_name),
      eventType: String(row.event_type),
      resourceType: String(row.resource_type),
      resourceId: row.resource_id ? String(row.resource_id) : null,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? row.metadata as Record<string, unknown>
          : {},
      createdAt: iso(row.created_at) ?? now()
    }));
  }
}

let singleton: KoshPlatformStore | null = null;

export function getKoshPlatformStore(): KoshPlatformStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshPlatformStore(postgres(databaseUrl, { max: 5, prepare: false }))
    : new MemoryKoshPlatformStore();
  return singleton;
}
