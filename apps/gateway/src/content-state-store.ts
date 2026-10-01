import postgres from "postgres";

export type StoredWorkspaceContent = {
  userId: string;
  namespace: string;
  revision: number;
  payload: Record<string, unknown>;
  updatedAt: string;
};

export interface WorkspaceContentStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  get(userId: string, namespace: string): Promise<StoredWorkspaceContent | null>;
  put(
    userId: string,
    namespace: string,
    payload: Record<string, unknown>,
    expectedRevision?: number | null
  ): Promise<StoredWorkspaceContent>;
}

class MemoryWorkspaceContentStore implements WorkspaceContentStore {
  readonly kind = "ephemeral-memory" as const;
  private records = new Map<string, StoredWorkspaceContent>();

  async ready() {}

  async get(userId: string, namespace: string) {
    const value = this.records.get(`${userId}:${namespace}`);
    return value ? structuredClone(value) : null;
  }

  async put(
    userId: string,
    namespace: string,
    payload: Record<string, unknown>,
    expectedRevision?: number | null
  ) {
    const key = `${userId}:${namespace}`;
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

    const next: StoredWorkspaceContent = {
      userId,
      namespace,
      revision: (current?.revision ?? 0) + 1,
      payload: structuredClone(payload),
      updatedAt: new Date().toISOString()
    };

    this.records.set(key, next);
    return structuredClone(next);
  }
}

class PostgresWorkspaceContentStore implements WorkspaceContentStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`
      CREATE TABLE IF NOT EXISTS workspace_content_state (
        user_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        revision BIGINT NOT NULL DEFAULT 0,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, namespace)
      )
    `;

    this.initialized = true;
  }

  async get(userId: string, namespace: string): Promise<StoredWorkspaceContent | null> {
    await this.ready();

    const rows = await this.sql`
      SELECT user_id, namespace, revision, payload, updated_at
      FROM workspace_content_state
      WHERE user_id = ${userId} AND namespace = ${namespace}
      LIMIT 1
    `;

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      userId: String(row.user_id),
      namespace: String(row.namespace),
      revision: Number(row.revision ?? 0),
      payload:
        row.payload && typeof row.payload === "object"
          ? row.payload as Record<string, unknown>
          : {},
      updatedAt: new Date(String(row.updated_at)).toISOString()
    };
  }

  async put(
    userId: string,
    namespace: string,
    payload: Record<string, unknown>,
    expectedRevision?: number | null
  ): Promise<StoredWorkspaceContent> {
    await this.ready();

    if (expectedRevision !== undefined && expectedRevision !== null) {
      const current = await this.get(userId, namespace);
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw Object.assign(new Error("revision_conflict"), {
          status: 409,
          currentRevision: current?.revision ?? 0
        });
      }
    }

    const serialized = JSON.stringify(payload);
    const rows = await this.sql`
      INSERT INTO workspace_content_state (
        user_id, namespace, revision, payload, updated_at
      )
      VALUES (
        ${userId}, ${namespace}, 1, ${serialized}::jsonb, NOW()
      )
      ON CONFLICT (user_id, namespace)
      DO UPDATE SET
        revision = workspace_content_state.revision + 1,
        payload = EXCLUDED.payload,
        updated_at = NOW()
      RETURNING user_id, namespace, revision, payload, updated_at
    `;

    const row = rows[0] as Record<string, unknown>;
    return {
      userId: String(row.user_id),
      namespace: String(row.namespace),
      revision: Number(row.revision ?? 0),
      payload:
        row.payload && typeof row.payload === "object"
          ? row.payload as Record<string, unknown>
          : {},
      updatedAt: new Date(String(row.updated_at)).toISOString()
    };
  }
}

export function createWorkspaceContentStore(): WorkspaceContentStore {
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  return databaseUrl
    ? new PostgresWorkspaceContentStore(
        postgres(databaseUrl, { max: 5, prepare: false })
      )
    : new MemoryWorkspaceContentStore();
}
