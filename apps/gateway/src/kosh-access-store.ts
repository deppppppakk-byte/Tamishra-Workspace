import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshRepositoryRole =
  | "owner"
  | "maintainer"
  | "contributor"
  | "reviewer"
  | "reader";

export type KoshAccessSubjectType = "user" | "team";
export type KoshTeamMemberRole = "maintainer" | "member";

export type StoredKoshNamespaceBinding = {
  namespace: string;
  organizationId: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
};

export type StoredKoshTeam = {
  id: string;
  namespace: string;
  slug: string;
  name: string;
  description: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshTeamMember = {
  id: string;
  teamId: string;
  userId: string;
  role: KoshTeamMemberRole;
  addedByUserId: string;
  addedByName: string;
  createdAt: string;
};

export type StoredKoshRepositoryGrant = {
  id: string;
  repositoryId: string;
  subjectType: KoshAccessSubjectType;
  subjectId: string;
  role: KoshRepositoryRole;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export interface KoshAccessStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;

  getNamespaceBinding(
    namespace: string
  ): Promise<StoredKoshNamespaceBinding | null>;
  listNamespaceBindings(): Promise<StoredKoshNamespaceBinding[]>;
  bindNamespace(input: {
    namespace: string;
    organizationId: string;
    createdByUserId: string;
    createdByName: string;
  }): Promise<StoredKoshNamespaceBinding>;

  listTeams(namespace?: string): Promise<StoredKoshTeam[]>;
  getTeam(id: string): Promise<StoredKoshTeam | null>;
  createTeam(input: Omit<StoredKoshTeam, "id" | "createdAt" | "updatedAt">): Promise<StoredKoshTeam>;
  deleteTeam(id: string): Promise<boolean>;

  listTeamMembers(teamId: string): Promise<StoredKoshTeamMember[]>;
  listUserTeams(userId: string): Promise<StoredKoshTeamMember[]>;
  putTeamMember(input: {
    teamId: string;
    userId: string;
    role: KoshTeamMemberRole;
    addedByUserId: string;
    addedByName: string;
  }): Promise<StoredKoshTeamMember>;
  deleteTeamMember(teamId: string, userId: string): Promise<boolean>;

  listRepositoryGrants(repositoryId: string): Promise<StoredKoshRepositoryGrant[]>;
  putRepositoryGrant(input: {
    repositoryId: string;
    subjectType: KoshAccessSubjectType;
    subjectId: string;
    role: KoshRepositoryRole;
    createdByUserId: string;
    createdByName: string;
  }): Promise<StoredKoshRepositoryGrant>;
  deleteRepositoryGrant(repositoryId: string, id: string): Promise<boolean>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryKoshAccessStore implements KoshAccessStore {
  readonly kind = "ephemeral-memory" as const;
  private bindings = new Map<string, StoredKoshNamespaceBinding>();
  private teams = new Map<string, StoredKoshTeam>();
  private teamMembers = new Map<string, StoredKoshTeamMember>();
  private grants = new Map<string, StoredKoshRepositoryGrant>();

  async ready() {}

  async getNamespaceBinding(namespace: string) {
    const value = this.bindings.get(namespace);
    return value ? clone(value) : null;
  }

  async listNamespaceBindings() {
    return [...this.bindings.values()]
      .sort((a, b) => a.namespace.localeCompare(b.namespace))
      .map(clone);
  }

  async bindNamespace(input: {
    namespace: string;
    organizationId: string;
    createdByUserId: string;
    createdByName: string;
  }) {
    const current = this.bindings.get(input.namespace);
    if (current && current.organizationId !== input.organizationId) {
      throw Object.assign(new Error("namespace_already_bound"), { status: 409 });
    }
    if (current) return clone(current);
    const value: StoredKoshNamespaceBinding = {
      ...input,
      createdAt: now()
    };
    this.bindings.set(input.namespace, value);
    return clone(value);
  }

  async listTeams(namespace?: string) {
    return [...this.teams.values()]
      .filter((team) => !namespace || team.namespace === namespace)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(clone);
  }

  async getTeam(id: string) {
    const value = this.teams.get(id);
    return value ? clone(value) : null;
  }

  async createTeam(
    input: Omit<StoredKoshTeam, "id" | "createdAt" | "updatedAt">
  ) {
    const duplicate = [...this.teams.values()].find(
      (team) => team.namespace === input.namespace && team.slug === input.slug
    );
    if (duplicate) {
      throw Object.assign(new Error("team_exists"), { status: 409 });
    }
    const timestamp = now();
    const value: StoredKoshTeam = {
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.teams.set(value.id, value);
    return clone(value);
  }

  async deleteTeam(id: string) {
    if (!this.teams.delete(id)) return false;
    for (const [memberId, member] of this.teamMembers) {
      if (member.teamId === id) this.teamMembers.delete(memberId);
    }
    for (const [grantId, grant] of this.grants) {
      if (grant.subjectType === "team" && grant.subjectId === id) {
        this.grants.delete(grantId);
      }
    }
    return true;
  }

  async listTeamMembers(teamId: string) {
    return [...this.teamMembers.values()]
      .filter((member) => member.teamId === teamId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async listUserTeams(userId: string) {
    return [...this.teamMembers.values()]
      .filter((member) => member.userId === userId)
      .map(clone);
  }

  async putTeamMember(input: {
    teamId: string;
    userId: string;
    role: KoshTeamMemberRole;
    addedByUserId: string;
    addedByName: string;
  }) {
    const existing = [...this.teamMembers.values()].find(
      (member) => member.teamId === input.teamId && member.userId === input.userId
    );
    if (existing) {
      existing.role = input.role;
      existing.addedByUserId = input.addedByUserId;
      existing.addedByName = input.addedByName;
      return clone(existing);
    }
    const value: StoredKoshTeamMember = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.teamMembers.set(value.id, value);
    return clone(value);
  }

  async deleteTeamMember(teamId: string, userId: string) {
    const entry = [...this.teamMembers.entries()].find(
      ([, member]) => member.teamId === teamId && member.userId === userId
    );
    if (!entry) return false;
    return this.teamMembers.delete(entry[0]);
  }

  async listRepositoryGrants(repositoryId: string) {
    return [...this.grants.values()]
      .filter((grant) => grant.repositoryId === repositoryId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  async putRepositoryGrant(input: {
    repositoryId: string;
    subjectType: KoshAccessSubjectType;
    subjectId: string;
    role: KoshRepositoryRole;
    createdByUserId: string;
    createdByName: string;
  }) {
    const existing = [...this.grants.values()].find(
      (grant) =>
        grant.repositoryId === input.repositoryId &&
        grant.subjectType === input.subjectType &&
        grant.subjectId === input.subjectId
    );
    const timestamp = now();
    if (existing) {
      existing.role = input.role;
      existing.createdByUserId = input.createdByUserId;
      existing.createdByName = input.createdByName;
      existing.updatedAt = timestamp;
      return clone(existing);
    }
    const value: StoredKoshRepositoryGrant = {
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.grants.set(value.id, value);
    return clone(value);
  }

  async deleteRepositoryGrant(repositoryId: string, id: string) {
    const grant = this.grants.get(id);
    if (!grant || grant.repositoryId !== repositoryId) return false;
    return this.grants.delete(id);
  }
}

function iso(value: unknown) {
  if (!value) return now();
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? now() : date.toISOString();
}

function bindingFromRow(row: Record<string, unknown>): StoredKoshNamespaceBinding {
  return {
    namespace: String(row.namespace),
    organizationId: String(row.organization_id),
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at)
  };
}

function teamFromRow(row: Record<string, unknown>): StoredKoshTeam {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description ?? ""),
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function memberFromRow(row: Record<string, unknown>): StoredKoshTeamMember {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    userId: String(row.user_id),
    role: String(row.role) as KoshTeamMemberRole,
    addedByUserId: String(row.added_by_user_id),
    addedByName: String(row.added_by_name),
    createdAt: iso(row.created_at)
  };
}

function grantFromRow(row: Record<string, unknown>): StoredKoshRepositoryGrant {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    subjectType: String(row.subject_type) as KoshAccessSubjectType,
    subjectId: String(row.subject_id),
    role: String(row.role) as KoshRepositoryRole,
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

class PostgresKoshAccessStore implements KoshAccessStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_namespace_bindings (
      namespace TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE UNIQUE INDEX IF NOT EXISTS kosh_namespace_bindings_org_idx
      ON kosh_namespace_bindings(organization_id, namespace)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_access_teams (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(namespace, slug)
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_access_team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES kosh_access_teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      added_by_user_id TEXT NOT NULL,
      added_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(team_id, user_id),
      CHECK(role IN ('maintainer', 'member'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_access_team_members_user_idx
      ON kosh_access_team_members(user_id, team_id)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_repository_grants (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, subject_type, subject_id),
      CHECK(subject_type IN ('user', 'team')),
      CHECK(role IN ('owner', 'maintainer', 'contributor', 'reviewer', 'reader'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_repository_grants_repo_idx
      ON kosh_repository_grants(repository_id, updated_at DESC)`;

    this.initialized = true;
  }

  async getNamespaceBinding(namespace: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_namespace_bindings WHERE namespace = ${namespace} LIMIT 1
    `;
    return rows[0]
      ? bindingFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async listNamespaceBindings() {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_namespace_bindings ORDER BY namespace ASC
    `;
    return rows.map((row) => bindingFromRow(row as Record<string, unknown>));
  }

  async bindNamespace(input: {
    namespace: string;
    organizationId: string;
    createdByUserId: string;
    createdByName: string;
  }) {
    await this.ready();
    try {
      const rows = await this.sql`
        INSERT INTO kosh_namespace_bindings(
          namespace, organization_id, created_by_user_id, created_by_name
        )
        VALUES(
          ${input.namespace}, ${input.organizationId},
          ${input.createdByUserId}, ${input.createdByName}
        )
        ON CONFLICT(namespace) DO UPDATE SET
          organization_id = CASE
            WHEN kosh_namespace_bindings.organization_id = EXCLUDED.organization_id
            THEN kosh_namespace_bindings.organization_id
            ELSE kosh_namespace_bindings.organization_id
          END
        RETURNING *
      `;
      const binding = bindingFromRow(rows[0] as Record<string, unknown>);
      if (binding.organizationId !== input.organizationId) {
        throw Object.assign(new Error("namespace_already_bound"), { status: 409 });
      }
      return binding;
    } catch (error) {
      throw error;
    }
  }

  async listTeams(namespace?: string) {
    await this.ready();
    const rows = namespace
      ? await this.sql`SELECT * FROM kosh_access_teams WHERE namespace = ${namespace} ORDER BY name ASC`
      : await this.sql`SELECT * FROM kosh_access_teams ORDER BY namespace ASC, name ASC`;
    return rows.map((row) => teamFromRow(row as Record<string, unknown>));
  }

  async getTeam(id: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_access_teams WHERE id = ${id} LIMIT 1`;
    return rows[0] ? teamFromRow(rows[0] as Record<string, unknown>) : null;
  }

  async createTeam(
    input: Omit<StoredKoshTeam, "id" | "createdAt" | "updatedAt">
  ) {
    await this.ready();
    try {
      const rows = await this.sql`
        INSERT INTO kosh_access_teams(
          id, namespace, slug, name, description, created_by_user_id, created_by_name
        )
        VALUES(
          ${randomUUID()}, ${input.namespace}, ${input.slug}, ${input.name},
          ${input.description}, ${input.createdByUserId}, ${input.createdByName}
        )
        RETURNING *
      `;
      return teamFromRow(rows[0] as Record<string, unknown>);
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw Object.assign(new Error("team_exists"), { status: 409 });
      }
      throw error;
    }
  }

  async deleteTeam(id: string) {
    await this.ready();
    const rows = await this.sql`DELETE FROM kosh_access_teams WHERE id = ${id} RETURNING id`;
    return rows.length > 0;
  }

  async listTeamMembers(teamId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_access_team_members
      WHERE team_id = ${teamId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) => memberFromRow(row as Record<string, unknown>));
  }

  async listUserTeams(userId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_access_team_members WHERE user_id = ${userId}
    `;
    return rows.map((row) => memberFromRow(row as Record<string, unknown>));
  }

  async putTeamMember(input: {
    teamId: string;
    userId: string;
    role: KoshTeamMemberRole;
    addedByUserId: string;
    addedByName: string;
  }) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_access_team_members(
        id, team_id, user_id, role, added_by_user_id, added_by_name
      )
      VALUES(
        ${randomUUID()}, ${input.teamId}, ${input.userId}, ${input.role},
        ${input.addedByUserId}, ${input.addedByName}
      )
      ON CONFLICT(team_id, user_id) DO UPDATE SET
        role = EXCLUDED.role,
        added_by_user_id = EXCLUDED.added_by_user_id,
        added_by_name = EXCLUDED.added_by_name
      RETURNING *
    `;
    return memberFromRow(rows[0] as Record<string, unknown>);
  }

  async deleteTeamMember(teamId: string, userId: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_access_team_members
      WHERE team_id = ${teamId} AND user_id = ${userId}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async listRepositoryGrants(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_repository_grants
      WHERE repository_id = ${repositoryId}
      ORDER BY updated_at DESC
    `;
    return rows.map((row) => grantFromRow(row as Record<string, unknown>));
  }

  async putRepositoryGrant(input: {
    repositoryId: string;
    subjectType: KoshAccessSubjectType;
    subjectId: string;
    role: KoshRepositoryRole;
    createdByUserId: string;
    createdByName: string;
  }) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_repository_grants(
        id, repository_id, subject_type, subject_id, role,
        created_by_user_id, created_by_name
      )
      VALUES(
        ${randomUUID()}, ${input.repositoryId}, ${input.subjectType},
        ${input.subjectId}, ${input.role}, ${input.createdByUserId},
        ${input.createdByName}
      )
      ON CONFLICT(repository_id, subject_type, subject_id) DO UPDATE SET
        role = EXCLUDED.role,
        created_by_user_id = EXCLUDED.created_by_user_id,
        created_by_name = EXCLUDED.created_by_name,
        updated_at = NOW()
      RETURNING *
    `;
    return grantFromRow(rows[0] as Record<string, unknown>);
  }

  async deleteRepositoryGrant(repositoryId: string, id: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_repository_grants
      WHERE repository_id = ${repositoryId} AND id = ${id}
      RETURNING id
    `;
    return rows.length > 0;
  }
}

let singleton: KoshAccessStore | null = null;

export function getKoshAccessStore(): KoshAccessStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshAccessStore(postgres(databaseUrl, { max: 5, prepare: false }))
    : new MemoryKoshAccessStore();
  return singleton;
}
