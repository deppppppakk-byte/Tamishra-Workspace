import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshFlowEntityType =
  | "issue"
  | "change_review"
  | "commit"
  | "workflow_run"
  | "package"
  | "release"
  | "deployment"
  | "milestone"
  | "discussion"
  | "backup"
  | "page_site";

export type KoshFlowRelation =
  | "depends_on"
  | "implements"
  | "references"
  | "validated_by"
  | "produces"
  | "promotes_to"
  | "delivers_to"
  | "blocks"
  | "relates_to"
  | "supersedes";

export type StoredKoshFlowLink = {
  id: string;
  repositoryId: string;
  sourceType: KoshFlowEntityType;
  sourceRef: string;
  targetType: KoshFlowEntityType;
  targetRef: string;
  relation: KoshFlowRelation;
  note: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
};

export interface KoshFlowStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  listLinks(repositoryId: string): Promise<StoredKoshFlowLink[]>;
  createLink(
    input: Omit<StoredKoshFlowLink, "id" | "createdAt">
  ): Promise<StoredKoshFlowLink>;
  deleteLink(repositoryId: string, id: string): Promise<boolean>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryKoshFlowStore implements KoshFlowStore {
  readonly kind = "ephemeral-memory" as const;
  private links = new Map<string, StoredKoshFlowLink>();

  async ready() {}

  async listLinks(repositoryId: string) {
    return [...this.links.values()]
      .filter((link) => link.repositoryId === repositoryId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async createLink(
    input: Omit<StoredKoshFlowLink, "id" | "createdAt">
  ) {
    const duplicate = [...this.links.values()].find(
      (link) =>
        link.repositoryId === input.repositoryId &&
        link.sourceType === input.sourceType &&
        link.sourceRef === input.sourceRef &&
        link.targetType === input.targetType &&
        link.targetRef === input.targetRef &&
        link.relation === input.relation
    );
    if (duplicate) return clone(duplicate);

    const link: StoredKoshFlowLink = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.links.set(link.id, link);
    return clone(link);
  }

  async deleteLink(repositoryId: string, id: string) {
    const link = this.links.get(id);
    if (!link || link.repositoryId !== repositoryId) return false;
    return this.links.delete(id);
  }
}

function linkFromRow(row: Record<string, unknown>): StoredKoshFlowLink {
  const createdAt = row.created_at
    ? new Date(String(row.created_at)).toISOString()
    : now();
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    sourceType: String(row.source_type) as KoshFlowEntityType,
    sourceRef: String(row.source_ref),
    targetType: String(row.target_type) as KoshFlowEntityType,
    targetRef: String(row.target_ref),
    relation: String(row.relation) as KoshFlowRelation,
    note: String(row.note ?? ""),
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt
  };
}

class PostgresKoshFlowStore implements KoshFlowStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_flow_links (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      relation TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(
        repository_id,
        source_type,
        source_ref,
        target_type,
        target_ref,
        relation
      )
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_flow_links_repository_idx
      ON kosh_flow_links(repository_id, created_at DESC)`;

    this.initialized = true;
  }

  async listLinks(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_flow_links
      WHERE repository_id = ${repositoryId}
      ORDER BY created_at DESC
      LIMIT 2000
    `;
    return rows.map((row) => linkFromRow(row as Record<string, unknown>));
  }

  async createLink(
    input: Omit<StoredKoshFlowLink, "id" | "createdAt">
  ) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_flow_links(
        id, repository_id, source_type, source_ref,
        target_type, target_ref, relation, note,
        created_by_user_id, created_by_name
      )
      VALUES(
        ${randomUUID()}, ${input.repositoryId}, ${input.sourceType},
        ${input.sourceRef}, ${input.targetType}, ${input.targetRef},
        ${input.relation}, ${input.note}, ${input.createdByUserId},
        ${input.createdByName}
      )
      ON CONFLICT(
        repository_id,
        source_type,
        source_ref,
        target_type,
        target_ref,
        relation
      )
      DO UPDATE SET note = EXCLUDED.note
      RETURNING *
    `;
    return linkFromRow(rows[0] as Record<string, unknown>);
  }

  async deleteLink(repositoryId: string, id: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_flow_links
      WHERE repository_id = ${repositoryId} AND id = ${id}
      RETURNING id
    `;
    return rows.length > 0;
  }
}

let singleton: KoshFlowStore | null = null;

export function getKoshFlowStore(): KoshFlowStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshFlowStore(
        postgres(databaseUrl, { max: 5, prepare: false })
      )
    : new MemoryKoshFlowStore();
  return singleton;
}
