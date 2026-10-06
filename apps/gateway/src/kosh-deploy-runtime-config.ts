import postgres from "postgres";

export type KoshDeployRuntimeConfig = {
  revisionId: string;
  serviceId: string;
  repositoryId: string;
  environmentName: string;
  variables: Record<string, string>;
  secretBindings: Record<string, string>;
  createdByUserId: string;
  createdAt: string;
};

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

function stringRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, item]) => Boolean(key) && typeof item === "string")
      .map(([key, item]) => [key, String(item)])
  );
}

function fromRow(row: Row): KoshDeployRuntimeConfig {
  return {
    revisionId: String(row.revision_id),
    serviceId: String(row.service_id),
    repositoryId: String(row.repository_id),
    environmentName: String(row.environment_name || "production"),
    variables: stringRecord(row.variables),
    secretBindings: stringRecord(row.secret_bindings),
    createdByUserId: String(row.created_by_user_id),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

export class KoshDeployRuntimeConfigStore {
  private readonly sql: Sql | null;
  private initialized = false;

  constructor(databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim() || "") {
    this.sql = databaseUrl ? postgres(databaseUrl, { max: 3, prepare: false }) : null;
  }

  private requireSql() {
    if (!this.sql) throw Object.assign(new Error("kosh_deploy_database_required"), { status: 503 });
    return this.sql;
  }

  async ready() {
    if (this.initialized) return;
    const sql = this.requireSql();
    await sql`
      CREATE TABLE IF NOT EXISTS kosh_deploy_revision_runtime (
        revision_id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        environment_name TEXT NOT NULL DEFAULT 'production',
        variables JSONB NOT NULL DEFAULT '{}'::jsonb,
        secret_bindings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS kosh_deploy_revision_runtime_service_idx ON kosh_deploy_revision_runtime(service_id, created_at DESC)`;
    this.initialized = true;
  }

  async put(input: {
    revisionId: string;
    serviceId: string;
    repositoryId: string;
    environmentName: string;
    variables: Record<string, string>;
    secretBindings: Record<string, string>;
    createdByUserId: string;
  }) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`
      INSERT INTO kosh_deploy_revision_runtime(
        revision_id, service_id, repository_id, environment_name,
        variables, secret_bindings, created_by_user_id, created_at
      ) VALUES (
        ${input.revisionId}, ${input.serviceId}, ${input.repositoryId}, ${input.environmentName},
        ${JSON.stringify(input.variables)}::jsonb, ${JSON.stringify(input.secretBindings)}::jsonb,
        ${input.createdByUserId}, NOW()
      )
      ON CONFLICT (revision_id) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) return fromRow(rows[0] as Row);
    return this.get(input.revisionId);
  }

  async get(revisionId: string) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`
      SELECT * FROM kosh_deploy_revision_runtime
      WHERE revision_id=${revisionId}
      LIMIT 1
    `;
    return rows[0] ? fromRow(rows[0] as Row) : null;
  }
}

let singleton: KoshDeployRuntimeConfigStore | null = null;
export function getKoshDeployRuntimeConfigStore() {
  singleton ??= new KoshDeployRuntimeConfigStore();
  return singleton;
}
