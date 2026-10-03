import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

export type KoshOAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  createdAt: string;
};

export type KoshOAuthGrant = {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
};

export type KoshOAuthAccess = {
  userId: string;
  clientId: string;
  scopes: string[];
  resource: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  createdAt: string;
};

type StoredCode = KoshOAuthGrant & {
  hash: string;
  expiresAt: string;
  usedAt: string | null;
};

type StoredToken = KoshOAuthAccess & {
  accessHash: string;
  refreshHash: string;
  revokedAt: string | null;
};

const memoryClients = new Map<string, KoshOAuthClient>();
const memoryCodes = new Map<string, StoredCode>();
const memoryTokensByAccess = new Map<string, StoredToken>();
const memoryAccessByRefresh = new Map<string, string>();
let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 4, prepare: false });
  return sql;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function accessLifetimeMs() {
  const minutes = Number(process.env.KOSH_OAUTH_ACCESS_TOKEN_MINUTES ?? 60);
  return Math.max(5, Math.min(24 * 60, Number.isFinite(minutes) ? minutes : 60)) * 60_000;
}

function refreshLifetimeMs() {
  const days = Number(process.env.KOSH_OAUTH_REFRESH_TOKEN_DAYS ?? 30);
  return Math.max(1, Math.min(365, Number.isFinite(days) ? days : 30)) * 86_400_000;
}

function codeLifetimeMs() {
  const seconds = Number(process.env.KOSH_OAUTH_CODE_SECONDS ?? 600);
  return Math.max(60, Math.min(1800, Number.isFinite(seconds) ? seconds : 600)) * 1000;
}

function parseStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function clientFromRow(row: Record<string, unknown>): KoshOAuthClient {
  return {
    clientId: String(row.client_id),
    clientName: String(row.client_name ?? "Kosh MCP client"),
    redirectUris: parseStringArray(row.redirect_uris),
    grantTypes: parseStringArray(row.grant_types),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function tokenFromRow(row: Record<string, unknown>): KoshOAuthAccess {
  return {
    userId: String(row.user_id),
    clientId: String(row.client_id),
    scopes: parseStringArray(row.scopes),
    resource: String(row.resource),
    accessExpiresAt: new Date(String(row.access_expires_at)).toISOString(),
    refreshExpiresAt: new Date(String(row.refresh_expires_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

export async function readyKoshOAuthStore() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    redirect_uris JSONB NOT NULL,
    grant_types JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE TABLE IF NOT EXISTS kosh_oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes JSONB NOT NULL,
    resource TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE INDEX IF NOT EXISTS kosh_oauth_codes_expiry_idx ON kosh_oauth_codes(expires_at)`;
  await db`CREATE TABLE IF NOT EXISTS kosh_oauth_tokens (
    access_hash TEXT PRIMARY KEY,
    refresh_hash TEXT UNIQUE NOT NULL,
    client_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scopes JSONB NOT NULL,
    resource TEXT NOT NULL,
    access_expires_at TIMESTAMPTZ NOT NULL,
    refresh_expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE INDEX IF NOT EXISTS kosh_oauth_tokens_access_expiry_idx ON kosh_oauth_tokens(access_expires_at)`;
  await db`CREATE INDEX IF NOT EXISTS kosh_oauth_tokens_user_idx ON kosh_oauth_tokens(user_id, created_at DESC)`;
  initialized = true;
}

function requirePersistence() {
  if (!database() && process.env.NODE_ENV === "production") {
    throw Object.assign(new Error("kosh_oauth_requires_database"), { status: 503 });
  }
}

export async function registerKoshOAuthClient(input: {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
}) {
  requirePersistence();
  const client: KoshOAuthClient = {
    clientId: `kosh_client_${randomBytes(18).toString("base64url")}`,
    clientName: input.clientName.slice(0, 160) || "Kosh MCP client",
    redirectUris: [...new Set(input.redirectUris)],
    grantTypes: [...new Set(input.grantTypes)],
    createdAt: nowIso()
  };
  const db = database();
  if (!db) {
    memoryClients.set(client.clientId, client);
    return clone(client);
  }
  await readyKoshOAuthStore();
  const rows = await db`
    INSERT INTO kosh_oauth_clients(client_id, client_name, redirect_uris, grant_types)
    VALUES(${client.clientId}, ${client.clientName}, ${JSON.stringify(client.redirectUris)}::jsonb, ${JSON.stringify(client.grantTypes)}::jsonb)
    RETURNING *
  `;
  return clientFromRow(rows[0] as Record<string, unknown>);
}

export async function getKoshOAuthClient(clientId: string) {
  const db = database();
  if (!db) return memoryClients.get(clientId) ? clone(memoryClients.get(clientId)!) : null;
  await readyKoshOAuthStore();
  const rows = await db`SELECT * FROM kosh_oauth_clients WHERE client_id = ${clientId} LIMIT 1`;
  return rows[0] ? clientFromRow(rows[0] as Record<string, unknown>) : null;
}

export async function issueKoshOAuthCode(grant: KoshOAuthGrant) {
  requirePersistence();
  const raw = `kosh_oac_${randomBytes(32).toString("base64url")}`;
  const hash = sha256(raw);
  const expiresAt = new Date(Date.now() + codeLifetimeMs()).toISOString();
  const db = database();
  if (!db) {
    memoryCodes.set(hash, { ...clone(grant), hash, expiresAt, usedAt: null });
    return raw;
  }
  await readyKoshOAuthStore();
  await db`
    INSERT INTO kosh_oauth_codes(
      code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at
    ) VALUES(
      ${hash}, ${grant.clientId}, ${grant.userId}, ${grant.redirectUri}, ${grant.codeChallenge},
      ${JSON.stringify(grant.scopes)}::jsonb, ${grant.resource}, ${expiresAt}
    )
  `;
  return raw;
}

export async function consumeKoshOAuthCode(rawCode: string, input: {
  clientId: string;
  redirectUri: string;
}) {
  const hash = sha256(rawCode);
  const db = database();
  if (!db) {
    const item = memoryCodes.get(hash);
    if (!item || item.usedAt || item.clientId !== input.clientId || item.redirectUri !== input.redirectUri) return null;
    if (new Date(item.expiresAt).getTime() <= Date.now()) return null;
    item.usedAt = nowIso();
    return clone(item) as KoshOAuthGrant;
  }
  await readyKoshOAuthStore();
  const rows = await db`
    UPDATE kosh_oauth_codes
    SET used_at = NOW()
    WHERE code_hash = ${hash}
      AND client_id = ${input.clientId}
      AND redirect_uri = ${input.redirectUri}
      AND used_at IS NULL
      AND expires_at > NOW()
    RETURNING *
  `;
  if (!rows[0]) return null;
  const row = rows[0] as Record<string, unknown>;
  return {
    clientId: String(row.client_id),
    userId: String(row.user_id),
    redirectUri: String(row.redirect_uri),
    codeChallenge: String(row.code_challenge),
    scopes: parseStringArray(row.scopes),
    resource: String(row.resource)
  } satisfies KoshOAuthGrant;
}

function createTokenPair() {
  return {
    accessToken: `kosh_oat_${randomBytes(32).toString("base64url")}`,
    refreshToken: `kosh_ort_${randomBytes(40).toString("base64url")}`
  };
}

export async function issueKoshOAuthTokens(grant: {
  clientId: string;
  userId: string;
  scopes: string[];
  resource: string;
}) {
  requirePersistence();
  const pair = createTokenPair();
  const accessExpiresAt = new Date(Date.now() + accessLifetimeMs()).toISOString();
  const refreshExpiresAt = new Date(Date.now() + refreshLifetimeMs()).toISOString();
  const accessHash = sha256(pair.accessToken);
  const refreshHash = sha256(pair.refreshToken);
  const createdAt = nowIso();
  const stored: StoredToken = {
    accessHash,
    refreshHash,
    clientId: grant.clientId,
    userId: grant.userId,
    scopes: [...grant.scopes],
    resource: grant.resource,
    accessExpiresAt,
    refreshExpiresAt,
    createdAt,
    revokedAt: null
  };
  const db = database();
  if (!db) {
    memoryTokensByAccess.set(accessHash, stored);
    memoryAccessByRefresh.set(refreshHash, accessHash);
  } else {
    await readyKoshOAuthStore();
    await db`
      INSERT INTO kosh_oauth_tokens(
        access_hash, refresh_hash, client_id, user_id, scopes, resource,
        access_expires_at, refresh_expires_at
      ) VALUES(
        ${accessHash}, ${refreshHash}, ${grant.clientId}, ${grant.userId},
        ${JSON.stringify(grant.scopes)}::jsonb, ${grant.resource}, ${accessExpiresAt}, ${refreshExpiresAt}
      )
    `;
  }
  return {
    ...pair,
    expiresIn: Math.max(1, Math.floor((new Date(accessExpiresAt).getTime() - Date.now()) / 1000)),
    scope: grant.scopes.join(" ")
  };
}

export async function rotateKoshOAuthRefreshToken(rawRefresh: string, clientId: string) {
  requirePersistence();
  const refreshHash = sha256(rawRefresh);
  const next = createTokenPair();
  const nextAccessHash = sha256(next.accessToken);
  const nextRefreshHash = sha256(next.refreshToken);
  const accessExpiresAt = new Date(Date.now() + accessLifetimeMs()).toISOString();
  const refreshExpiresAt = new Date(Date.now() + refreshLifetimeMs()).toISOString();
  const db = database();
  if (!db) {
    const accessHash = memoryAccessByRefresh.get(refreshHash);
    const current = accessHash ? memoryTokensByAccess.get(accessHash) : null;
    if (!current || current.clientId !== clientId || current.revokedAt || new Date(current.refreshExpiresAt).getTime() <= Date.now()) return null;
    memoryTokensByAccess.delete(accessHash!);
    memoryAccessByRefresh.delete(refreshHash);
    const stored: StoredToken = {
      ...current,
      accessHash: nextAccessHash,
      refreshHash: nextRefreshHash,
      accessExpiresAt,
      refreshExpiresAt,
      createdAt: nowIso(),
      revokedAt: null
    };
    memoryTokensByAccess.set(nextAccessHash, stored);
    memoryAccessByRefresh.set(nextRefreshHash, nextAccessHash);
    return { ...next, access: clone(stored) as KoshOAuthAccess };
  }
  await readyKoshOAuthStore();
  const rows = await db`
    UPDATE kosh_oauth_tokens
    SET access_hash = ${nextAccessHash}, refresh_hash = ${nextRefreshHash},
        access_expires_at = ${accessExpiresAt}, refresh_expires_at = ${refreshExpiresAt},
        updated_at = NOW()
    WHERE refresh_hash = ${refreshHash}
      AND client_id = ${clientId}
      AND revoked_at IS NULL
      AND refresh_expires_at > NOW()
    RETURNING *
  `;
  if (!rows[0]) return null;
  return { ...next, access: tokenFromRow(rows[0] as Record<string, unknown>) };
}

export async function authenticateKoshOAuthAccessToken(rawAccess: string) {
  if (!rawAccess.startsWith("kosh_oat_")) return null;
  const accessHash = sha256(rawAccess);
  const db = database();
  if (!db) {
    const current = memoryTokensByAccess.get(accessHash);
    if (!current || current.revokedAt || new Date(current.accessExpiresAt).getTime() <= Date.now()) return null;
    return clone(current) as KoshOAuthAccess;
  }
  await readyKoshOAuthStore();
  const rows = await db`
    SELECT * FROM kosh_oauth_tokens
    WHERE access_hash = ${accessHash}
      AND revoked_at IS NULL
      AND access_expires_at > NOW()
    LIMIT 1
  `;
  return rows[0] ? tokenFromRow(rows[0] as Record<string, unknown>) : null;
}
