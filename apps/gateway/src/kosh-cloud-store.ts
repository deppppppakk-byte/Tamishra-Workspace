import { createHash, randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshCloudNodeState = "online" | "draining" | "offline";
export type KoshCloudDeploymentState =
  | "pending"
  | "assigned"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

export type KoshCloudNode = {
  id: string;
  name: string;
  region: string;
  architecture: string;
  publicUrl: string | null;
  state: KoshCloudNodeState;
  totalSlots: number;
  usedSlots: number;
  capabilities: string[];
  labels: Record<string, string>;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type KoshCloudDeployment = {
  id: string;
  slug: string;
  name: string;
  image: string;
  containerPort: number;
  state: KoshCloudDeploymentState;
  nodeId: string | null;
  assignmentGeneration: number;
  routeUrl: string | null;
  message: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

type Sql = ReturnType<typeof postgres>;

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function rowToNode(row: Record<string, unknown>): KoshCloudNode {
  return {
    id: String(row.id),
    name: String(row.name),
    region: String(row.region || "unknown"),
    architecture: String(row.architecture || "unknown"),
    publicUrl: row.public_url ? String(row.public_url) : null,
    state: String(row.state) as KoshCloudNodeState,
    totalSlots: Number(row.total_slots || 0),
    usedSlots: Number(row.used_slots || 0),
    capabilities: Array.isArray(row.capabilities) ? row.capabilities.map(String) : [],
    labels:
      row.labels && typeof row.labels === "object" && !Array.isArray(row.labels)
        ? Object.fromEntries(
            Object.entries(row.labels as Record<string, unknown>).map(([key, value]) => [
              key,
              String(value)
            ])
          )
        : {},
    lastSeenAt: iso(row.last_seen_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function rowToDeployment(row: Record<string, unknown>): KoshCloudDeployment {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    image: String(row.image),
    containerPort: Number(row.container_port),
    state: String(row.state) as KoshCloudDeploymentState,
    nodeId: row.node_id ? String(row.node_id) : null,
    assignmentGeneration: Number(row.assignment_generation || 0),
    routeUrl: row.route_url ? String(row.route_url) : null,
    message: row.message ? String(row.message) : null,
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

export class KoshCloudStore {
  private readonly sql: Sql | null;
  private initialized = false;

  constructor(databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim() || "") {
    this.sql = databaseUrl ? postgres(databaseUrl, { max: 5, prepare: false }) : null;
  }

  get kind() {
    return this.sql ? ("postgres" as const) : ("unavailable" as const);
  }

  private requireSql() {
    if (!this.sql) throw Object.assign(new Error("kosh_cloud_database_required"), { status: 503 });
    return this.sql;
  }

  async ready() {
    if (this.initialized) return;
    const sql = this.requireSql();

    await sql`
      CREATE TABLE IF NOT EXISTS kosh_cloud_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT 'unknown',
        architecture TEXT NOT NULL DEFAULT 'unknown',
        public_url TEXT,
        state TEXT NOT NULL DEFAULT 'online',
        token_hash TEXT NOT NULL UNIQUE,
        total_slots INTEGER NOT NULL DEFAULT 1,
        used_slots INTEGER NOT NULL DEFAULT 0,
        capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
        labels JSONB NOT NULL DEFAULT '{}'::jsonb,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (state IN ('online','draining','offline')),
        CHECK (total_slots >= 1 AND total_slots <= 1024),
        CHECK (used_slots >= 0 AND used_slots <= total_slots)
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS kosh_cloud_nodes_scheduler_idx
      ON kosh_cloud_nodes(state, last_seen_at DESC, used_slots, total_slots)
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS kosh_cloud_deployments (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        image TEXT NOT NULL,
        container_port INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        node_id TEXT REFERENCES kosh_cloud_nodes(id) ON DELETE SET NULL,
        assignment_generation BIGINT NOT NULL DEFAULT 0,
        route_url TEXT,
        message TEXT,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (container_port >= 1 AND container_port <= 65535),
        CHECK (state IN ('pending','assigned','starting','running','stopping','stopped','failed'))
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS kosh_cloud_deployments_node_idx
      ON kosh_cloud_deployments(node_id, state, updated_at DESC)
    `;

    this.initialized = true;
  }

  async registerNode(input: {
    name: string;
    region: string;
    architecture: string;
    publicUrl: string | null;
    totalSlots: number;
    capabilities: string[];
    labels: Record<string, string>;
  }) {
    await this.ready();
    const sql = this.requireSql();
    const id = randomUUID();
    const token = `kosh_node_${randomBytes(32).toString("base64url")}`;
    const rows = await sql`
      INSERT INTO kosh_cloud_nodes (
        id, name, region, architecture, public_url, state, token_hash,
        total_slots, used_slots, capabilities, labels, last_seen_at, created_at, updated_at
      ) VALUES (
        ${id}, ${input.name}, ${input.region}, ${input.architecture}, ${input.publicUrl},
        'online', ${tokenHash(token)}, ${input.totalSlots}, 0,
        ${sql.json(input.capabilities)}, ${sql.json(input.labels)}, NOW(), NOW(), NOW()
      )
      RETURNING *
    `;
    return { node: rowToNode(rows[0] as Record<string, unknown>), token };
  }

  async authenticateNode(id: string, token: string) {
    await this.ready();
    if (!token.startsWith("kosh_node_")) return null;
    const sql = this.requireSql();
    const rows = await sql`
      SELECT * FROM kosh_cloud_nodes
      WHERE id=${id} AND token_hash=${tokenHash(token)}
      LIMIT 1
    `;
    return rows[0] ? rowToNode(rows[0] as Record<string, unknown>) : null;
  }

  async heartbeat(
    nodeId: string,
    input: {
      totalSlots: number;
      usedSlots: number;
      publicUrl: string | null;
      capabilities: string[];
      labels: Record<string, string>;
    }
  ) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`
      UPDATE kosh_cloud_nodes SET
        state = CASE WHEN state='draining' THEN state ELSE 'online' END,
        total_slots=${input.totalSlots},
        used_slots=${Math.min(input.usedSlots, input.totalSlots)},
        public_url=${input.publicUrl},
        capabilities=${sql.json(input.capabilities)},
        labels=${sql.json(input.labels)},
        last_seen_at=NOW(),
        updated_at=NOW()
      WHERE id=${nodeId}
      RETURNING *
    `;
    return rows[0] ? rowToNode(rows[0] as Record<string, unknown>) : null;
  }

  async markStaleNodesOffline(staleSeconds = 75) {
    await this.ready();
    const sql = this.requireSql();
    await sql`
      UPDATE kosh_cloud_nodes
      SET state='offline', updated_at=NOW()
      WHERE state='online'
        AND last_seen_at < NOW() - (${staleSeconds} * INTERVAL '1 second')
    `;
  }

  async listNodes() {
    await this.markStaleNodesOffline();
    const sql = this.requireSql();
    const rows = await sql`SELECT * FROM kosh_cloud_nodes ORDER BY created_at ASC`;
    return rows.map((row) => rowToNode(row as Record<string, unknown>));
  }

  async createDeployment(input: {
    slug: string;
    name: string;
    image: string;
    containerPort: number;
    createdByUserId: string;
  }) {
    await this.ready();
    const sql = this.requireSql();
    try {
      const rows = await sql`
        INSERT INTO kosh_cloud_deployments (
          id, slug, name, image, container_port, state, created_by_user_id,
          assignment_generation, created_at, updated_at
        ) VALUES (
          ${randomUUID()}, ${input.slug}, ${input.name}, ${input.image}, ${input.containerPort},
          'pending', ${input.createdByUserId}, 0, NOW(), NOW()
        )
        RETURNING *
      `;
      return rowToDeployment(rows[0] as Record<string, unknown>);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        String((error as { code?: unknown }).code) === "23505"
      ) {
        throw Object.assign(new Error("deployment_slug_exists"), { status: 409 });
      }
      throw error;
    }
  }

  async scheduleDeployment(deploymentId: string) {
    await this.markStaleNodesOffline();
    const sql = this.requireSql();
    return sql.begin(async (tx) => {
      const deployments = await tx`
        SELECT * FROM kosh_cloud_deployments
        WHERE id=${deploymentId} AND state='pending'
        FOR UPDATE
      `;
      if (!deployments[0]) return null;

      const nodes = await tx`
        SELECT * FROM kosh_cloud_nodes
        WHERE state='online'
          AND last_seen_at >= NOW() - INTERVAL '75 seconds'
          AND used_slots < total_slots
        ORDER BY (used_slots::double precision / total_slots::double precision) ASC,
                 last_seen_at DESC,
                 created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (!nodes[0]) return rowToDeployment(deployments[0] as Record<string, unknown>);

      const nodeId = String(nodes[0].id);
      await tx`
        UPDATE kosh_cloud_nodes
        SET used_slots=used_slots+1, updated_at=NOW()
        WHERE id=${nodeId}
      `;
      const updated = await tx`
        UPDATE kosh_cloud_deployments
        SET state='assigned', node_id=${nodeId},
            assignment_generation=assignment_generation+1,
            message=NULL, updated_at=NOW()
        WHERE id=${deploymentId}
        RETURNING *
      `;
      return rowToDeployment(updated[0] as Record<string, unknown>);
    });
  }

  async listDeployments() {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`SELECT * FROM kosh_cloud_deployments ORDER BY created_at DESC`;
    return rows.map((row) => rowToDeployment(row as Record<string, unknown>));
  }

  async assignmentsForNode(nodeId: string) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`
      SELECT * FROM kosh_cloud_deployments
      WHERE node_id=${nodeId} AND state IN ('assigned','starting','running','stopping')
      ORDER BY created_at ASC
    `;
    return rows.map((row) => rowToDeployment(row as Record<string, unknown>));
  }

  async updateDeploymentFromNode(input: {
    deploymentId: string;
    nodeId: string;
    assignmentGeneration: number;
    state: Extract<KoshCloudDeploymentState, "starting" | "running" | "stopped" | "failed">;
    routeUrl: string | null;
    message: string | null;
  }) {
    await this.ready();
    const sql = this.requireSql();
    return sql.begin(async (tx) => {
      const rows = await tx`
        SELECT * FROM kosh_cloud_deployments
        WHERE id=${input.deploymentId}
        FOR UPDATE
      `;
      if (!rows[0]) return null;
      const current = rowToDeployment(rows[0] as Record<string, unknown>);
      if (
        current.nodeId !== input.nodeId ||
        current.assignmentGeneration !== input.assignmentGeneration
      ) {
        throw Object.assign(new Error("stale_assignment"), { status: 409 });
      }

      const terminal = input.state === "stopped" || input.state === "failed";
      const updated = await tx`
        UPDATE kosh_cloud_deployments
        SET state=${input.state}, route_url=${input.routeUrl}, message=${input.message}, updated_at=NOW()
        WHERE id=${input.deploymentId}
        RETURNING *
      `;
      if (terminal) {
        await tx`
          UPDATE kosh_cloud_nodes
          SET used_slots=GREATEST(0, used_slots-1), updated_at=NOW()
          WHERE id=${input.nodeId}
        `;
      }
      return rowToDeployment(updated[0] as Record<string, unknown>);
    });
  }
}

let singleton: KoshCloudStore | null = null;
export function getKoshCloudStore() {
  singleton ??= new KoshCloudStore();
  return singleton;
}
