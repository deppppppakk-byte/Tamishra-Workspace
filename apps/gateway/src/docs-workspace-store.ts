import postgres from "postgres";

export type StoredDocsWorkspace = {
  userId: string;
  revision: number;
  payload: Record<string, unknown>;
  updatedAt: string;
};

export interface DocsWorkspaceStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  get(userId: string): Promise<StoredDocsWorkspace | null>;
  put(
    userId: string,
    payload: Record<string, unknown>,
    expectedRevision?: number | null
  ): Promise<StoredDocsWorkspace>;
}

class MemoryDocsWorkspaceStore implements DocsWorkspaceStore {
  readonly kind = "ephemeral-memory" as const;
  private records = new Map<string, StoredDocsWorkspace>();

  async ready() {}

  async get(userId: string) {
    const value = this.records.get(userId);
    return value ? structuredClone(value) : null;
  }

  async put(
    userId: string,
    payload: Record<string, unknown>,
    expectedRevision?: number | null
  ) {
    const current = this.records.get(userId);
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

    const next: StoredDocsWorkspace = {
      userId,
      revision: (current?.revision ?? 0) + 1,
      payload: structuredClone(payload),
      updatedAt: new Date().toISOString()
    };
    this.records.set(userId, next);
    return structuredClone(next);
  }
}

class PostgresDocsWorkspaceStore implements DocsWorkspaceStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`
      CREATE TABLE IF NOT EXISTS workspace_docs_state (
        user_id TEXT PRIMARY KEY,
        revision BIGINT NOT NULL DEFAULT 0,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    this.initialized = true;
  }

  async get(userId: string): Promise<StoredDocsWorkspace | null> {
    await this.ready();
    const rows = await this.sql`
      SELECT user_id, revision, payload, updated_at
      FROM workspace_docs_state
      WHERE user_id = ${userId}
      LIMIT 1
    `;

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      userId: String(row.user_id),
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
    payload: Record<string, unknown>,
    expectedRevision?: number | null
  ): Promise<StoredDocsWorkspace> {
    await this.ready();

    if (expectedRevision !== undefined && expectedRevision !== null) {
      const current = await this.get(userId);
      if ((current?.revision ?? 0) !== expectedRevision) {
        throw Object.assign(new Error("revision_conflict"), {
          status: 409,
          currentRevision: current?.revision ?? 0
        });
      }
    }

    const serialized = JSON.stringify(payload);
    const rows = await this.sql`
      INSERT INTO workspace_docs_state (
        user_id, revision, payload, updated_at
      )
      VALUES (
        ${userId}, 1, ${serialized}::jsonb, NOW()
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        revision = workspace_docs_state.revision + 1,
        payload = EXCLUDED.payload,
        updated_at = NOW()
      RETURNING user_id, revision, payload, updated_at
    `;

    const row = rows[0] as Record<string, unknown>;
    return {
      userId: String(row.user_id),
      revision: Number(row.revision ?? 0),
      payload:
        row.payload && typeof row.payload === "object"
          ? row.payload as Record<string, unknown>
          : {},
      updatedAt: new Date(String(row.updated_at)).toISOString()
    };
  }
}

export function createDocsWorkspaceStore(): DocsWorkspaceStore {
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();

  if (!databaseUrl) {
    return new MemoryDocsWorkspaceStore();
  }

  return new PostgresDocsWorkspaceStore(postgres(databaseUrl, { max: 5, prepare: false }));
}
