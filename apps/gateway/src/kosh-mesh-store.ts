import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshMeshNodeType =
  | "service"
  | "app"
  | "api"
  | "package"
  | "data"
  | "cad"
  | "bim"
  | "document"
  | "environment"
  | "deployment"
  | "workspace"
  | "component";

export type KoshMeshRelation =
  | "depends_on"
  | "provides"
  | "consumes"
  | "publishes"
  | "deploys_to"
  | "uses"
  | "syncs_with"
  | "contains"
  | "relates_to"
  | "replaces"
  | "extends";

export type StoredKoshMeshNode = {
  id: string;
  namespace: string;
  key: string;
  type: KoshMeshNodeType;
  name: string;
  description: string;
  state: string;
  url: string | null;
  metadata: Record<string, unknown>;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshMeshLink = {
  id: string;
  sourceRef: string;
  targetRef: string;
  relation: KoshMeshRelation;
  note: string;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
};

export interface KoshMeshStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  listNodes(): Promise<StoredKoshMeshNode[]>;
  createNode(
    input: Omit<StoredKoshMeshNode, "id" | "createdAt" | "updatedAt">
  ): Promise<StoredKoshMeshNode>;
  updateNode(
    id: string,
    input: Partial<
      Pick<
        StoredKoshMeshNode,
        "name" | "description" | "state" | "url" | "metadata"
      >
    >
  ): Promise<StoredKoshMeshNode | null>;
  deleteNode(id: string): Promise<boolean>;
  listLinks(): Promise<StoredKoshMeshLink[]>;
  createLink(
    input: Omit<StoredKoshMeshLink, "id" | "createdAt">
  ): Promise<StoredKoshMeshLink>;
  deleteLink(id: string): Promise<boolean>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryKoshMeshStore implements KoshMeshStore {
  readonly kind = "ephemeral-memory" as const;
  private nodes = new Map<string, StoredKoshMeshNode>();
  private links = new Map<string, StoredKoshMeshLink>();

  async ready() {}

  async listNodes() {
    return [...this.nodes.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(clone);
  }

  async createNode(
    input: Omit<StoredKoshMeshNode, "id" | "createdAt" | "updatedAt">
  ) {
    const duplicate = [...this.nodes.values()].find(
      (node) => node.namespace === input.namespace && node.key === input.key
    );
    if (duplicate) {
      throw Object.assign(new Error("mesh_node_exists"), { status: 409 });
    }
    const timestamp = now();
    const node: StoredKoshMeshNode = {
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.nodes.set(node.id, node);
    return clone(node);
  }

  async updateNode(
    id: string,
    input: Partial<
      Pick<
        StoredKoshMeshNode,
        "name" | "description" | "state" | "url" | "metadata"
      >
    >
  ) {
    const node = this.nodes.get(id);
    if (!node) return null;
    Object.assign(node, input, { updatedAt: now() });
    return clone(node);
  }

  async deleteNode(id: string) {
    if (!this.nodes.delete(id)) return false;
    for (const [linkId, link] of this.links) {
      if (
        link.sourceRef === "node:" + id ||
        link.targetRef === "node:" + id
      ) {
        this.links.delete(linkId);
      }
    }
    return true;
  }

  async listLinks() {
    return [...this.links.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async createLink(
    input: Omit<StoredKoshMeshLink, "id" | "createdAt">
  ) {
    const duplicate = [...this.links.values()].find(
      (link) =>
        link.sourceRef === input.sourceRef &&
        link.targetRef === input.targetRef &&
        link.relation === input.relation
    );
    if (duplicate) return clone(duplicate);
    const link: StoredKoshMeshLink = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.links.set(link.id, link);
    return clone(link);
  }

  async deleteLink(id: string) {
    return this.links.delete(id);
  }
}

function iso(value: unknown) {
  if (!value) return now();
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? now() : date.toISOString();
}

function nodeFromRow(row: Record<string, unknown>): StoredKoshMeshNode {
  return {
    id: String(row.id),
    namespace: String(row.namespace),
    key: String(row.node_key),
    type: String(row.type) as KoshMeshNodeType,
    name: String(row.name),
    description: String(row.description ?? ""),
    state: String(row.state ?? "active"),
    url: row.url ? String(row.url) : null,
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? row.metadata as Record<string, unknown>
        : {},
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function linkFromRow(row: Record<string, unknown>): StoredKoshMeshLink {
  return {
    id: String(row.id),
    sourceRef: String(row.source_ref),
    targetRef: String(row.target_ref),
    relation: String(row.relation) as KoshMeshRelation,
    note: String(row.note ?? ""),
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at)
  };
}

class PostgresKoshMeshStore implements KoshMeshStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_mesh_nodes (
      id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      node_key TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'active',
      url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(namespace, node_key)
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_mesh_links (
      id TEXT PRIMARY KEY,
      source_ref TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      relation TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(source_ref, target_ref, relation),
      CHECK(source_ref <> target_ref)
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_mesh_nodes_namespace_idx
      ON kosh_mesh_nodes(namespace, updated_at DESC)`;

    this.initialized = true;
  }

  async listNodes() {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_mesh_nodes
      ORDER BY name ASC
      LIMIT 2000
    `;
    return rows.map((row) => nodeFromRow(row as Record<string, unknown>));
  }

  async createNode(
    input: Omit<StoredKoshMeshNode, "id" | "createdAt" | "updatedAt">
  ) {
    await this.ready();
    try {
      const rows = await this.sql`
        INSERT INTO kosh_mesh_nodes(
          id, namespace, node_key, type, name, description,
          state, url, metadata, created_by_user_id, created_by_name
        )
        VALUES(
          ${randomUUID()}, ${input.namespace}, ${input.key}, ${input.type},
          ${input.name}, ${input.description}, ${input.state}, ${input.url},
          ${JSON.stringify(input.metadata)}::jsonb,
          ${input.createdByUserId}, ${input.createdByName}
        )
        RETURNING *
      `;
      return nodeFromRow(rows[0] as Record<string, unknown>);
    } catch (error) {
      if (
        typeof error === "object" &&
        error &&
        "code" in error &&
        (error as { code?: string }).code === "23505"
      ) {
        throw Object.assign(new Error("mesh_node_exists"), { status: 409 });
      }
      throw error;
    }
  }

  async updateNode(
    id: string,
    input: Partial<
      Pick<
        StoredKoshMeshNode,
        "name" | "description" | "state" | "url" | "metadata"
      >
    >
  ) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_mesh_nodes WHERE id = ${id} LIMIT 1`;
    if (!rows[0]) return null;
    const current = nodeFromRow(rows[0] as Record<string, unknown>);
    const updated = await this.sql`
      UPDATE kosh_mesh_nodes
      SET name = ${input.name ?? current.name},
          description = ${input.description ?? current.description},
          state = ${input.state ?? current.state},
          url = ${input.url === undefined ? current.url : input.url},
          metadata = ${JSON.stringify(input.metadata ?? current.metadata)}::jsonb,
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return nodeFromRow(updated[0] as Record<string, unknown>);
  }

  async deleteNode(id: string) {
    await this.ready();
    return this.sql.begin(async (tx) => {
      await tx`DELETE FROM kosh_mesh_links
        WHERE source_ref = ${"node:" + id}
           OR target_ref = ${"node:" + id}`;
      const rows = await tx`DELETE FROM kosh_mesh_nodes
        WHERE id = ${id} RETURNING id`;
      return rows.length > 0;
    });
  }

  async listLinks() {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_mesh_links
      ORDER BY created_at DESC
      LIMIT 5000
    `;
    return rows.map((row) => linkFromRow(row as Record<string, unknown>));
  }

  async createLink(
    input: Omit<StoredKoshMeshLink, "id" | "createdAt">
  ) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_mesh_links(
        id, source_ref, target_ref, relation, note,
        created_by_user_id, created_by_name
      )
      VALUES(
        ${randomUUID()}, ${input.sourceRef}, ${input.targetRef},
        ${input.relation}, ${input.note}, ${input.createdByUserId},
        ${input.createdByName}
      )
      ON CONFLICT(source_ref, target_ref, relation)
      DO UPDATE SET note = EXCLUDED.note
      RETURNING *
    `;
    return linkFromRow(rows[0] as Record<string, unknown>);
  }

  async deleteLink(id: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_mesh_links WHERE id = ${id} RETURNING id
    `;
    return rows.length > 0;
  }
}

let singleton: KoshMeshStore | null = null;

export function getKoshMeshStore(): KoshMeshStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshMeshStore(
        postgres(databaseUrl, { max: 5, prepare: false })
      )
    : new MemoryKoshMeshStore();
  return singleton;
}
