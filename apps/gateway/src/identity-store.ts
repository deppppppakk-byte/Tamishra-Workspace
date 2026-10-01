import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type StoredIdentityUser = {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type StoredPasswordCredential = {
  userId: string;
  passwordHash: string;
  passwordSalt: string;
  scryptN: number;
  scryptR: number;
  scryptP: number;
  keyLength: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredIdentitySession = {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  ipHash: string | null;
  revokedAt: string | null;
};

export type StoredOrganization = {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredMembership = {
  id: string;
  userId: string;
  organizationId: string;
  role: "owner" | "admin" | "member" | "guest";
  joinedAt: string;
  disabled: boolean;
};

export type IdentityTokenPurpose = "verify-email" | "reset-password";

export type StoredIdentityToken = {
  id: string;
  userId: string;
  purpose: IdentityTokenPurpose;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type StoredRecoveryCode = {
  id: string;
  userId: string;
  codeHash: string;
  createdAt: string;
  usedAt: string | null;
};

export type NewUserBundle = {
  user: StoredIdentityUser;
  credential: Omit<StoredPasswordCredential, "userId" | "createdAt" | "updatedAt">;
  organization: StoredOrganization;
  membership: StoredMembership;
};

export interface IdentityStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  createUserBundle(input: NewUserBundle): Promise<void>;
  findUserByEmail(email: string): Promise<StoredIdentityUser | null>;
  getUser(userId: string): Promise<StoredIdentityUser | null>;
  updateDisplayName(userId: string, displayName: string): Promise<StoredIdentityUser | null>;
  markEmailVerified(userId: string): Promise<StoredIdentityUser | null>;
  getPasswordCredential(userId: string): Promise<StoredPasswordCredential | null>;
  replacePasswordCredential(
    userId: string,
    credential: Omit<StoredPasswordCredential, "userId" | "createdAt" | "updatedAt">
  ): Promise<void>;
  createIdentityToken(token: StoredIdentityToken): Promise<void>;
  consumeIdentityToken(
    tokenHash: string,
    purpose: IdentityTokenPurpose
  ): Promise<StoredIdentityToken | null>;
  replaceRecoveryCodes(userId: string, codes: StoredRecoveryCode[]): Promise<void>;
  consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
  createSession(session: StoredIdentitySession): Promise<void>;
  findSessionByTokenHash(tokenHash: string): Promise<StoredIdentitySession | null>;
  touchSession(sessionId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
  revokeAllUserSessions(userId: string, exceptSessionId?: string): Promise<void>;
  listSessions(userId: string): Promise<StoredIdentitySession[]>;
  listMemberships(userId: string): Promise<Array<{
    membership: StoredMembership;
    organization: StoredOrganization;
  }>>;
  listOrganizationMembers(organizationId: string): Promise<Array<{
    membership: StoredMembership;
    user: StoredIdentityUser;
  }>>;
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toUser(row: Record<string, unknown>): StoredIdentityUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    emailVerified: Boolean(row.email_verified),
    disabled: Boolean(row.disabled),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString()
  };
}

function toCredential(row: Record<string, unknown>): StoredPasswordCredential {
  return {
    userId: String(row.user_id),
    passwordHash: String(row.password_hash),
    passwordSalt: String(row.password_salt),
    scryptN: Number(row.scrypt_n),
    scryptR: Number(row.scrypt_r),
    scryptP: Number(row.scrypt_p),
    keyLength: Number(row.key_length),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString()
  };
}

function toSession(row: Record<string, unknown>): StoredIdentitySession {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    tokenHash: String(row.token_hash),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
    lastSeenAt: iso(row.last_seen_at) ?? new Date().toISOString(),
    userAgent: row.user_agent ? String(row.user_agent) : null,
    ipHash: row.ip_hash ? String(row.ip_hash) : null,
    revokedAt: iso(row.revoked_at)
  };
}

function toOrganization(row: Record<string, unknown>): StoredOrganization {
  return {
    id: String(row.id),
    name: String(row.name),
    slug: String(row.slug),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString()
  };
}

function toMembership(row: Record<string, unknown>): StoredMembership {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    organizationId: String(row.organization_id),
    role: String(row.role) as StoredMembership["role"],
    joinedAt: iso(row.joined_at) ?? new Date().toISOString(),
    disabled: Boolean(row.disabled)
  };
}

class MemoryIdentityStore implements IdentityStore {
  readonly kind = "ephemeral-memory" as const;
  private readonly users = new Map<string, StoredIdentityUser>();
  private readonly credentials = new Map<string, StoredPasswordCredential>();
  private readonly sessions = new Map<string, StoredIdentitySession>();
  private readonly organizations = new Map<string, StoredOrganization>();
  private readonly memberships = new Map<string, StoredMembership>();
  private readonly identityTokens = new Map<string, StoredIdentityToken>();
  private readonly recoveryCodes = new Map<string, StoredRecoveryCode>();

  async ready() {}

  async createUserBundle(input: NewUserBundle) {
    if (Array.from(this.users.values()).some((user) => user.email === input.user.email)) {
      throw Object.assign(new Error("email_already_registered"), { code: "23505" });
    }

    this.users.set(input.user.id, structuredClone(input.user));
    const now = new Date().toISOString();
    this.credentials.set(input.user.id, {
      ...structuredClone(input.credential),
      userId: input.user.id,
      createdAt: now,
      updatedAt: now
    });
    this.organizations.set(input.organization.id, structuredClone(input.organization));
    this.memberships.set(input.membership.id, structuredClone(input.membership));
  }

  async findUserByEmail(email: string) {
    return Array.from(this.users.values()).find((user) => user.email === email) ?? null;
  }

  async getUser(userId: string) {
    return this.users.get(userId) ?? null;
  }

  async updateDisplayName(userId: string, displayName: string) {
    const user = this.users.get(userId);
    if (!user) return null;
    user.displayName = displayName;
    user.updatedAt = new Date().toISOString();
    return structuredClone(user);
  }

  async markEmailVerified(userId: string) {
    const user = this.users.get(userId);
    if (!user) return null;
    user.emailVerified = true;
    user.updatedAt = new Date().toISOString();
    return structuredClone(user);
  }

  async getPasswordCredential(userId: string) {
    return this.credentials.get(userId) ?? null;
  }

  async replacePasswordCredential(
    userId: string,
    credential: Omit<StoredPasswordCredential, "userId" | "createdAt" | "updatedAt">
  ) {
    const existing = this.credentials.get(userId);
    const now = new Date().toISOString();
    this.credentials.set(userId, {
      ...structuredClone(credential),
      userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    });
  }

  async createIdentityToken(token: StoredIdentityToken) {
    for (const existing of this.identityTokens.values()) {
      if (
        existing.userId === token.userId &&
        existing.purpose === token.purpose &&
        !existing.consumedAt
      ) {
        existing.consumedAt = token.createdAt;
      }
    }
    this.identityTokens.set(token.id, structuredClone(token));
  }

  async consumeIdentityToken(
    tokenHashValue: string,
    purpose: IdentityTokenPurpose
  ) {
    const now = Date.now();
    const token = Array.from(this.identityTokens.values()).find(
      (item) =>
        item.tokenHash === tokenHashValue &&
        item.purpose === purpose &&
        !item.consumedAt &&
        new Date(item.expiresAt).getTime() > now
    );
    if (!token) return null;
    token.consumedAt = new Date().toISOString();
    return structuredClone(token);
  }

  async replaceRecoveryCodes(userId: string, codes: StoredRecoveryCode[]) {
    for (const [id, code] of this.recoveryCodes) {
      if (code.userId === userId) this.recoveryCodes.delete(id);
    }
    for (const code of codes) {
      this.recoveryCodes.set(code.id, structuredClone(code));
    }
  }

  async consumeRecoveryCode(userId: string, codeHashValue: string) {
    const code = Array.from(this.recoveryCodes.values()).find(
      (item) =>
        item.userId === userId &&
        item.codeHash === codeHashValue &&
        !item.usedAt
    );
    if (!code) return false;
    code.usedAt = new Date().toISOString();
    return true;
  }

  async countUnusedRecoveryCodes(userId: string) {
    return Array.from(this.recoveryCodes.values()).filter(
      (item) => item.userId === userId && !item.usedAt
    ).length;
  }

  async createSession(session: StoredIdentitySession) {
    this.sessions.set(session.id, structuredClone(session));
  }

  async findSessionByTokenHash(tokenHash: string) {
    const now = Date.now();
    return (
      Array.from(this.sessions.values()).find(
        (session) =>
          session.tokenHash === tokenHash &&
          !session.revokedAt &&
          new Date(session.expiresAt).getTime() > now
      ) ?? null
    );
  }

  async touchSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session && !session.revokedAt) session.lastSeenAt = new Date().toISOString();
  }

  async revokeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session && !session.revokedAt) session.revokedAt = new Date().toISOString();
  }

  async revokeAllUserSessions(userId: string, exceptSessionId?: string) {
    const now = new Date().toISOString();
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.id !== exceptSessionId && !session.revokedAt) {
        session.revokedAt = now;
      }
    }
  }

  async listSessions(userId: string) {
    return Array.from(this.sessions.values())
      .filter((session) => session.userId === userId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .map((session) => structuredClone(session));
  }

  async listMemberships(userId: string) {
    return Array.from(this.memberships.values())
      .filter((membership) => membership.userId === userId && !membership.disabled)
      .map((membership) => {
        const organization = this.organizations.get(membership.organizationId);
        return organization
          ? { membership: structuredClone(membership), organization: structuredClone(organization) }
          : null;
      })
      .filter((value): value is { membership: StoredMembership; organization: StoredOrganization } => Boolean(value));
  }

  async listOrganizationMembers(organizationId: string) {
    return Array.from(this.memberships.values())
      .filter(
        (membership) =>
          membership.organizationId === organizationId && !membership.disabled
      )
      .map((membership) => {
        const user = this.users.get(membership.userId);
        return user && !user.disabled
          ? { membership: structuredClone(membership), user: structuredClone(user) }
          : null;
      })
      .filter((value): value is { membership: StoredMembership; user: StoredIdentityUser } => Boolean(value))
      .sort((left, right) => left.user.displayName.localeCompare(right.user.displayName));
  }
}

class PostgresIdentityStore implements IdentityStore {
  readonly kind = "postgres" as const;
  private readonly sql: ReturnType<typeof postgres>;
  private readyPromise: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5, prepare: false });
  }

  ready() {
    this.readyPromise ??= this.initialize();
    return this.readyPromise;
  }

  private async initialize() {
    await this.sql`
      create table if not exists workspace_users (
        id text primary key,
        email text not null unique,
        display_name text not null,
        email_verified boolean not null default false,
        disabled boolean not null default false,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create table if not exists workspace_password_credentials (
        user_id text primary key references workspace_users(id) on delete cascade,
        password_hash text not null,
        password_salt text not null,
        scrypt_n integer not null,
        scrypt_r integer not null,
        scrypt_p integer not null,
        key_length integer not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create table if not exists workspace_sessions (
        id text primary key,
        user_id text not null references workspace_users(id) on delete cascade,
        token_hash text not null unique,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        last_seen_at timestamptz not null default now(),
        user_agent text,
        ip_hash text,
        revoked_at timestamptz
      )
    `;

    await this.sql`
      create table if not exists workspace_organizations (
        id text primary key,
        name text not null,
        slug text not null unique,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create table if not exists workspace_memberships (
        id text primary key,
        user_id text not null references workspace_users(id) on delete cascade,
        organization_id text not null references workspace_organizations(id) on delete cascade,
        role text not null,
        joined_at timestamptz not null default now(),
        disabled boolean not null default false,
        unique(user_id, organization_id)
      )
    `;

    await this.sql`
      create table if not exists workspace_identity_tokens (
        id text primary key,
        user_id text not null references workspace_users(id) on delete cascade,
        purpose text not null,
        token_hash text not null unique,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        consumed_at timestamptz
      )
    `;

    await this.sql`
      create table if not exists workspace_recovery_codes (
        id text primary key,
        user_id text not null references workspace_users(id) on delete cascade,
        code_hash text not null,
        created_at timestamptz not null default now(),
        used_at timestamptz,
        unique(user_id, code_hash)
      )
    `;

    await this.sql`
      create index if not exists workspace_sessions_user_idx
      on workspace_sessions(user_id, last_seen_at desc)
    `;

    await this.sql`
      create index if not exists workspace_sessions_token_idx
      on workspace_sessions(token_hash)
    `;

    await this.sql`
      create index if not exists workspace_memberships_user_idx
      on workspace_memberships(user_id, joined_at)
    `;

    await this.sql`
      create index if not exists workspace_identity_tokens_lookup_idx
      on workspace_identity_tokens(token_hash, purpose, expires_at)
    `;

    await this.sql`
      create index if not exists workspace_recovery_codes_user_idx
      on workspace_recovery_codes(user_id, used_at)
    `;
  }

  async createUserBundle(input: NewUserBundle) {
    await this.ready();
    const now = new Date().toISOString();

    try {
      await this.sql`
        insert into workspace_users(
          id, email, display_name, email_verified, disabled, created_at, updated_at
        ) values (
          ${input.user.id}, ${input.user.email}, ${input.user.displayName},
          ${input.user.emailVerified}, ${input.user.disabled},
          ${input.user.createdAt}, ${input.user.updatedAt}
        )
      `;

      await this.sql`
        insert into workspace_password_credentials(
          user_id, password_hash, password_salt,
          scrypt_n, scrypt_r, scrypt_p, key_length,
          created_at, updated_at
        ) values (
          ${input.user.id}, ${input.credential.passwordHash}, ${input.credential.passwordSalt},
          ${input.credential.scryptN}, ${input.credential.scryptR},
          ${input.credential.scryptP}, ${input.credential.keyLength},
          ${now}, ${now}
        )
      `;

      await this.sql`
        insert into workspace_organizations(
          id, name, slug, created_at, updated_at
        ) values (
          ${input.organization.id}, ${input.organization.name}, ${input.organization.slug},
          ${input.organization.createdAt}, ${input.organization.updatedAt}
        )
      `;

      await this.sql`
        insert into workspace_memberships(
          id, user_id, organization_id, role, joined_at, disabled
        ) values (
          ${input.membership.id}, ${input.membership.userId},
          ${input.membership.organizationId}, ${input.membership.role},
          ${input.membership.joinedAt}, ${input.membership.disabled}
        )
      `;
    } catch (error) {
      await this.sql`delete from workspace_users where id=${input.user.id}`;
      await this.sql`delete from workspace_organizations where id=${input.organization.id}`;
      throw error;
    }
  }

  async findUserByEmail(email: string) {
    await this.ready();
    const rows = await this.sql`
      select * from workspace_users
      where email=${email}
      limit 1
    `;
    return rows[0] ? toUser(rows[0] as Record<string, unknown>) : null;
  }

  async getUser(userId: string) {
    await this.ready();
    const rows = await this.sql`
      select * from workspace_users
      where id=${userId}
      limit 1
    `;
    return rows[0] ? toUser(rows[0] as Record<string, unknown>) : null;
  }

  async updateDisplayName(userId: string, displayName: string) {
    await this.ready();
    const rows = await this.sql`
      update workspace_users
      set display_name=${displayName}, updated_at=now()
      where id=${userId}
      returning *
    `;
    return rows[0] ? toUser(rows[0] as Record<string, unknown>) : null;
  }

  async markEmailVerified(userId: string) {
    await this.ready();
    const rows = await this.sql`
      update workspace_users
      set email_verified=true, updated_at=now()
      where id=${userId}
      returning *
    `;
    return rows[0] ? toUser(rows[0] as Record<string, unknown>) : null;
  }

  async getPasswordCredential(userId: string) {
    await this.ready();
    const rows = await this.sql`
      select * from workspace_password_credentials
      where user_id=${userId}
      limit 1
    `;
    return rows[0] ? toCredential(rows[0] as Record<string, unknown>) : null;
  }

  async replacePasswordCredential(
    userId: string,
    credential: Omit<StoredPasswordCredential, "userId" | "createdAt" | "updatedAt">
  ) {
    await this.ready();
    await this.sql`
      insert into workspace_password_credentials(
        user_id, password_hash, password_salt,
        scrypt_n, scrypt_r, scrypt_p, key_length,
        created_at, updated_at
      ) values (
        ${userId}, ${credential.passwordHash}, ${credential.passwordSalt},
        ${credential.scryptN}, ${credential.scryptR},
        ${credential.scryptP}, ${credential.keyLength},
        now(), now()
      )
      on conflict(user_id) do update set
        password_hash=excluded.password_hash,
        password_salt=excluded.password_salt,
        scrypt_n=excluded.scrypt_n,
        scrypt_r=excluded.scrypt_r,
        scrypt_p=excluded.scrypt_p,
        key_length=excluded.key_length,
        updated_at=now()
    `;
  }

  async createIdentityToken(token: StoredIdentityToken) {
    await this.ready();
    await this.sql`
      update workspace_identity_tokens
      set consumed_at=coalesce(consumed_at, now())
      where user_id=${token.userId}
        and purpose=${token.purpose}
        and consumed_at is null
    `;
    await this.sql`
      insert into workspace_identity_tokens(
        id, user_id, purpose, token_hash, created_at, expires_at, consumed_at
      ) values (
        ${token.id}, ${token.userId}, ${token.purpose}, ${token.tokenHash},
        ${token.createdAt}, ${token.expiresAt}, ${token.consumedAt}
      )
    `;
  }

  async consumeIdentityToken(
    tokenHashValue: string,
    purpose: IdentityTokenPurpose
  ) {
    await this.ready();
    const rows = await this.sql`
      update workspace_identity_tokens
      set consumed_at=now()
      where id=(
        select id
        from workspace_identity_tokens
        where token_hash=${tokenHashValue}
          and purpose=${purpose}
          and consumed_at is null
          and expires_at > now()
        limit 1
      )
      returning *
    `;
    if (!rows[0]) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      userId: String(row.user_id),
      purpose: String(row.purpose) as IdentityTokenPurpose,
      tokenHash: String(row.token_hash),
      createdAt: iso(row.created_at) ?? new Date().toISOString(),
      expiresAt: iso(row.expires_at) ?? new Date(0).toISOString(),
      consumedAt: iso(row.consumed_at)
    };
  }

  async replaceRecoveryCodes(userId: string, codes: StoredRecoveryCode[]) {
    await this.ready();
    await this.sql`
      delete from workspace_recovery_codes
      where user_id=${userId}
    `;
    for (const code of codes) {
      await this.sql`
        insert into workspace_recovery_codes(
          id, user_id, code_hash, created_at, used_at
        ) values (
          ${code.id}, ${code.userId}, ${code.codeHash},
          ${code.createdAt}, ${code.usedAt}
        )
      `;
    }
  }

  async consumeRecoveryCode(userId: string, codeHashValue: string) {
    await this.ready();
    const rows = await this.sql`
      update workspace_recovery_codes
      set used_at=now()
      where id=(
        select id
        from workspace_recovery_codes
        where user_id=${userId}
          and code_hash=${codeHashValue}
          and used_at is null
        limit 1
      )
      returning id
    `;
    return Boolean(rows[0]);
  }

  async countUnusedRecoveryCodes(userId: string) {
    await this.ready();
    const rows = await this.sql`
      select count(*)::int as count
      from workspace_recovery_codes
      where user_id=${userId} and used_at is null
    `;
    return Number((rows[0] as Record<string, unknown> | undefined)?.count ?? 0);
  }

  async createSession(session: StoredIdentitySession) {
    await this.ready();
    await this.sql`
      insert into workspace_sessions(
        id, user_id, token_hash, created_at, expires_at,
        last_seen_at, user_agent, ip_hash, revoked_at
      ) values (
        ${session.id}, ${session.userId}, ${session.tokenHash},
        ${session.createdAt}, ${session.expiresAt}, ${session.lastSeenAt},
        ${session.userAgent}, ${session.ipHash}, ${session.revokedAt}
      )
    `;
  }

  async findSessionByTokenHash(tokenHash: string) {
    await this.ready();
    const rows = await this.sql`
      select * from workspace_sessions
      where token_hash=${tokenHash}
        and revoked_at is null
        and expires_at > now()
      limit 1
    `;
    return rows[0] ? toSession(rows[0] as Record<string, unknown>) : null;
  }

  async touchSession(sessionId: string) {
    await this.ready();
    await this.sql`
      update workspace_sessions
      set last_seen_at=now()
      where id=${sessionId} and revoked_at is null
    `;
  }

  async revokeSession(sessionId: string) {
    await this.ready();
    await this.sql`
      update workspace_sessions
      set revoked_at=coalesce(revoked_at, now())
      where id=${sessionId}
    `;
  }

  async revokeAllUserSessions(userId: string, exceptSessionId?: string) {
    await this.ready();
    if (exceptSessionId) {
      await this.sql`
        update workspace_sessions
        set revoked_at=coalesce(revoked_at, now())
        where user_id=${userId}
          and id <> ${exceptSessionId}
          and revoked_at is null
      `;
      return;
    }

    await this.sql`
      update workspace_sessions
      set revoked_at=coalesce(revoked_at, now())
      where user_id=${userId} and revoked_at is null
    `;
  }

  async listSessions(userId: string) {
    await this.ready();
    const rows = await this.sql`
      select * from workspace_sessions
      where user_id=${userId}
      order by last_seen_at desc
      limit 50
    `;
    return rows.map((row) => toSession(row as Record<string, unknown>));
  }

  async listMemberships(userId: string) {
    await this.ready();
    const rows = await this.sql`
      select
        m.id as membership_id,
        m.user_id,
        m.organization_id,
        m.role,
        m.joined_at,
        m.disabled,
        o.name as organization_name,
        o.slug as organization_slug,
        o.created_at as organization_created_at,
        o.updated_at as organization_updated_at
      from workspace_memberships m
      join workspace_organizations o on o.id=m.organization_id
      where m.user_id=${userId} and m.disabled=false
      order by m.joined_at asc
    `;

    return rows.map((row) => {
      const value = row as Record<string, unknown>;
      return {
        membership: {
          id: String(value.membership_id),
          userId: String(value.user_id),
          organizationId: String(value.organization_id),
          role: String(value.role) as StoredMembership["role"],
          joinedAt: iso(value.joined_at) ?? new Date().toISOString(),
          disabled: Boolean(value.disabled)
        },
        organization: {
          id: String(value.organization_id),
          name: String(value.organization_name),
          slug: String(value.organization_slug),
          createdAt: iso(value.organization_created_at) ?? new Date().toISOString(),
          updatedAt: iso(value.organization_updated_at) ?? new Date().toISOString()
        }
      };
    });
  }

  async listOrganizationMembers(organizationId: string) {
    await this.ready();
    const rows = await this.sql`
      select
        m.id as membership_id,
        m.user_id,
        m.organization_id,
        m.role,
        m.joined_at,
        m.disabled,
        u.email,
        u.display_name,
        u.email_verified,
        u.disabled as user_disabled,
        u.created_at as user_created_at,
        u.updated_at as user_updated_at
      from workspace_memberships m
      join workspace_users u on u.id=m.user_id
      where m.organization_id=${organizationId}
        and m.disabled=false
        and u.disabled=false
      order by lower(u.display_name) asc, lower(u.email) asc
    `;

    return rows.map((row) => {
      const value = row as Record<string, unknown>;
      return {
        membership: {
          id: String(value.membership_id),
          userId: String(value.user_id),
          organizationId: String(value.organization_id),
          role: String(value.role) as StoredMembership["role"],
          joinedAt: iso(value.joined_at) ?? new Date().toISOString(),
          disabled: Boolean(value.disabled)
        },
        user: {
          id: String(value.user_id),
          email: String(value.email),
          displayName: String(value.display_name),
          emailVerified: Boolean(value.email_verified),
          disabled: Boolean(value.user_disabled),
          createdAt: iso(value.user_created_at) ?? new Date().toISOString(),
          updatedAt: iso(value.user_updated_at) ?? new Date().toISOString()
        }
      };
    });
  }
}

export function createIdentityStore(): IdentityStore {
  const databaseUrl =
    process.env.WORKSPACE_DATABASE_URL?.trim() ||
    process.env.WORKSPACE_MEET_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();

  return databaseUrl
    ? new PostgresIdentityStore(databaseUrl)
    : new MemoryIdentityStore();
}

export function createIdentityIds() {
  return {
    userId: "usr_" + randomUUID(),
    organizationId: "org_" + randomUUID(),
    membershipId: "mbr_" + randomUUID(),
    sessionId: "ses_" + randomUUID()
  };
}
