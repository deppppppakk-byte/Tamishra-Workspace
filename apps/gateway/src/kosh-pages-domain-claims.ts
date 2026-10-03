import postgres from "postgres";

export type KoshPagesDomainClaim = {
  hostname: string;
  repositoryId: string;
  claimedAt: string;
  updatedAt: string;
};

type ClaimResult = KoshPagesDomainClaim & { created: boolean };

const memoryClaims = new Map<string, KoshPagesDomainClaim>();
let sql: ReturnType<typeof postgres> | null = null;
let initialized = false;

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 2, prepare: false });
  return sql;
}

function normalizeHostname(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function fromRow(row: Record<string, unknown>): KoshPagesDomainClaim {
  return {
    hostname: String(row.hostname),
    repositoryId: String(row.repository_id),
    claimedAt: new Date(String(row.claimed_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

async function ready() {
  const db = database();
  if (!db || initialized) return;
  await db`CREATE TABLE IF NOT EXISTS kosh_pages_domain_claims (
    hostname TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`;
  await db`CREATE INDEX IF NOT EXISTS kosh_pages_domain_claims_repo_idx
    ON kosh_pages_domain_claims(repository_id, updated_at DESC)`;
  initialized = true;
}

function conflict(hostname: string, repositoryId: string) {
  return Object.assign(new Error("custom_domain_claimed_by_another_repository"), {
    status: 409,
    hostname,
    repositoryId
  });
}

export async function claimKoshPagesDomain(
  hostnameInput: string,
  repositoryId: string
): Promise<ClaimResult> {
  const hostname = normalizeHostname(hostnameInput);
  const db = database();
  if (!db) {
    if (process.env.NODE_ENV === "production") {
      throw Object.assign(new Error("pages_domain_claims_require_database"), {
        status: 503
      });
    }
    const existing = memoryClaims.get(hostname);
    if (existing && existing.repositoryId !== repositoryId) {
      throw conflict(hostname, existing.repositoryId);
    }
    if (existing) return { ...structuredClone(existing), created: false };
    const timestamp = new Date().toISOString();
    const claim: KoshPagesDomainClaim = {
      hostname,
      repositoryId,
      claimedAt: timestamp,
      updatedAt: timestamp
    };
    memoryClaims.set(hostname, claim);
    return { ...structuredClone(claim), created: true };
  }

  await ready();
  return db.begin(async (tx) => {
    const inserted = await tx`
      INSERT INTO kosh_pages_domain_claims(hostname, repository_id)
      VALUES(${hostname}, ${repositoryId})
      ON CONFLICT(hostname) DO NOTHING
      RETURNING *
    `;
    if (inserted[0]) {
      return { ...fromRow(inserted[0] as Record<string, unknown>), created: true };
    }
    const rows = await tx`
      SELECT * FROM kosh_pages_domain_claims
      WHERE hostname = ${hostname}
      FOR UPDATE
    `;
    const existing = rows[0]
      ? fromRow(rows[0] as Record<string, unknown>)
      : null;
    if (!existing) {
      throw Object.assign(new Error("custom_domain_claim_race"), { status: 409 });
    }
    if (existing.repositoryId !== repositoryId) {
      throw conflict(hostname, existing.repositoryId);
    }
    const refreshed = await tx`
      UPDATE kosh_pages_domain_claims
      SET updated_at = NOW()
      WHERE hostname = ${hostname} AND repository_id = ${repositoryId}
      RETURNING *
    `;
    return {
      ...fromRow(refreshed[0] as Record<string, unknown>),
      created: false
    };
  });
}

export async function releaseKoshPagesDomain(
  hostnameInput: string,
  repositoryId: string
) {
  const hostname = normalizeHostname(hostnameInput);
  const db = database();
  if (!db) {
    const existing = memoryClaims.get(hostname);
    if (!existing || existing.repositoryId !== repositoryId) return false;
    return memoryClaims.delete(hostname);
  }
  await ready();
  const rows = await db`
    DELETE FROM kosh_pages_domain_claims
    WHERE hostname = ${hostname} AND repository_id = ${repositoryId}
    RETURNING hostname
  `;
  return rows.length > 0;
}

export async function getKoshPagesDomainClaim(hostnameInput: string) {
  const hostname = normalizeHostname(hostnameInput);
  const db = database();
  if (!db) {
    const item = memoryClaims.get(hostname);
    return item ? structuredClone(item) : null;
  }
  await ready();
  const rows = await db`
    SELECT * FROM kosh_pages_domain_claims
    WHERE hostname = ${hostname}
    LIMIT 1
  `;
  return rows[0] ? fromRow(rows[0] as Record<string, unknown>) : null;
}
