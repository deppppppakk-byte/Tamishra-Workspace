import postgres from "postgres";
import type { KoshCloudDeployment, KoshCloudNode } from "./kosh-cloud-store.js";

type Sql = ReturnType<typeof postgres>;

type Row = Record<string, unknown>;

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function rowToNode(row: Row): KoshCloudNode {
  return {
    id: String(row.id),
    name: String(row.name),
    region: String(row.region || "unknown"),
    architecture: String(row.architecture || "unknown"),
    publicUrl: row.public_url ? String(row.public_url) : null,
    state: String(row.state) as KoshCloudNode["state"],
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

function rowToDeployment(row: Row): KoshCloudDeployment {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    image: String(row.image),
    containerPort: Number(row.container_port),
    state: String(row.state) as KoshCloudDeployment["state"],
    nodeId: row.node_id ? String(row.node_id) : null,
    assignmentGeneration: Number(row.assignment_generation || 0),
    routeUrl: row.route_url ? String(row.route_url) : null,
    message: row.message ? String(row.message) : null,
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function activeState(state: KoshCloudDeployment["state"]) {
  return new Set(["assigned", "starting", "running", "stopping"]).has(state);
}

export class KoshCloudOperations {
  private readonly sql: Sql | null;

  constructor(databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim() || "") {
    this.sql = databaseUrl ? postgres(databaseUrl, { max: 3, prepare: false }) : null;
  }

  private requireSql() {
    if (!this.sql) {
      throw Object.assign(new Error("kosh_cloud_database_required"), { status: 503 });
    }
    return this.sql;
  }

  async stopDeployment(deploymentId: string) {
    const sql = this.requireSql();
    return sql.begin(async (tx) => {
      const rows = await tx`
        SELECT * FROM kosh_cloud_deployments
        WHERE id=${deploymentId}
        FOR UPDATE
      `;
      if (!rows[0]) return null;
      const current = rowToDeployment(rows[0] as Row);

      if (current.nodeId && activeState(current.state)) {
        await tx`
          UPDATE kosh_cloud_nodes
          SET used_slots=GREATEST(0, used_slots-1), updated_at=NOW()
          WHERE id=${current.nodeId}
        `;
      }

      const updated = await tx`
        UPDATE kosh_cloud_deployments
        SET state='stopped', node_id=NULL, route_url=NULL,
            message='Stopped by Kosh Cloud administrator', updated_at=NOW()
        WHERE id=${deploymentId}
        RETURNING *
      `;
      return rowToDeployment(updated[0] as Row);
    });
  }

  async restartDeployment(deploymentId: string) {
    const sql = this.requireSql();
    return sql.begin(async (tx) => {
      const rows = await tx`
        SELECT * FROM kosh_cloud_deployments
        WHERE id=${deploymentId}
        FOR UPDATE
      `;
      if (!rows[0]) return null;
      const current = rowToDeployment(rows[0] as Row);

      if (current.nodeId && activeState(current.state)) {
        await tx`
          UPDATE kosh_cloud_nodes
          SET used_slots=GREATEST(0, used_slots-1), updated_at=NOW()
          WHERE id=${current.nodeId}
        `;
      }

      const updated = await tx`
        UPDATE kosh_cloud_deployments
        SET state='pending', node_id=NULL, route_url=NULL,
            message='Restart requested; awaiting fresh assignment', updated_at=NOW()
        WHERE id=${deploymentId}
        RETURNING *
      `;
      return rowToDeployment(updated[0] as Row);
    });
  }

  async drainNode(nodeId: string) {
    const sql = this.requireSql();
    return sql.begin(async (tx) => {
      const nodes = await tx`
        UPDATE kosh_cloud_nodes
        SET state='draining', used_slots=0, updated_at=NOW()
        WHERE id=${nodeId}
        RETURNING *
      `;
      if (!nodes[0]) return null;

      const deployments = await tx`
        UPDATE kosh_cloud_deployments
        SET state='pending', node_id=NULL, route_url=NULL,
            message='Node draining; rescheduling with a new assignment', updated_at=NOW()
        WHERE node_id=${nodeId}
          AND state IN ('assigned','starting','running','stopping')
        RETURNING id
      `;

      return {
        node: rowToNode(nodes[0] as Row),
        deploymentIds: deployments.map((row) => String(row.id))
      };
    });
  }

  async resumeNode(nodeId: string) {
    const sql = this.requireSql();
    const rows = await sql`
      UPDATE kosh_cloud_nodes
      SET state=CASE
        WHEN last_seen_at >= NOW() - INTERVAL '75 seconds' THEN 'online'
        ELSE 'offline'
      END,
      updated_at=NOW()
      WHERE id=${nodeId}
      RETURNING *
    `;
    return rows[0] ? rowToNode(rows[0] as Row) : null;
  }

  async reconcileOfflineAssignments() {
    const sql = this.requireSql();
    return sql.begin(async (tx) => {
      const staleNodes = await tx`
        UPDATE kosh_cloud_nodes
        SET state='offline', used_slots=0, updated_at=NOW()
        WHERE state='online'
          AND last_seen_at < NOW() - INTERVAL '75 seconds'
        RETURNING id
      `;
      const nodeIds = staleNodes.map((row) => String(row.id));
      if (!nodeIds.length) return [] as string[];

      const deployments = await tx`
        UPDATE kosh_cloud_deployments
        SET state='pending', node_id=NULL, route_url=NULL,
            message='Assigned node became unavailable; Kosh Cloud is rescheduling', updated_at=NOW()
        WHERE node_id = ANY(${nodeIds})
          AND state IN ('assigned','starting','running','stopping')
        RETURNING id
      `;
      return deployments.map((row) => String(row.id));
    });
  }
}

let singleton: KoshCloudOperations | null = null;
export function getKoshCloudOperations() {
  singleton ??= new KoshCloudOperations();
  return singleton;
}
