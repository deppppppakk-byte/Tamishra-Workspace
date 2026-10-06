import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshDeployRevisionState = "pending" | "active" | "superseded" | "failed" | "stopped";

export type KoshDeployService = {
  id: string;
  slug: string;
  name: string;
  repositoryId: string;
  namespace: string;
  repositorySlug: string;
  containerPort: number;
  dockerfilePath: string;
  contextPath: string;
  healthPath: string;
  exposure: "private" | "public";
  activeRevisionId: string | null;
  pendingRevisionId: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type KoshDeployRevision = {
  id: string;
  serviceId: string;
  revision: number;
  refName: string;
  commitSha: string;
  cloudDeploymentId: string | null;
  cloudDeploymentSlug: string | null;
  state: KoshDeployRevisionState;
  rollbackOfRevision: number | null;
  createdByUserId: string;
  createdAt: string;
  promotedAt: string | null;
};

type Sql = ReturnType<typeof postgres>;
type Row = Record<string, unknown>;

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serviceFromRow(row: Row): KoshDeployService {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    repositoryId: String(row.repository_id),
    namespace: String(row.namespace),
    repositorySlug: String(row.repository_slug),
    containerPort: Number(row.container_port),
    dockerfilePath: String(row.dockerfile_path || "Dockerfile"),
    contextPath: String(row.context_path || "."),
    healthPath: String(row.health_path || "/"),
    exposure: String(row.exposure) === "public" ? "public" : "private",
    activeRevisionId: row.active_revision_id ? String(row.active_revision_id) : null,
    pendingRevisionId: row.pending_revision_id ? String(row.pending_revision_id) : null,
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date(0).toISOString()
  };
}

function revisionFromRow(row: Row): KoshDeployRevision {
  return {
    id: String(row.id),
    serviceId: String(row.service_id),
    revision: Number(row.revision),
    refName: String(row.ref_name),
    commitSha: String(row.commit_sha),
    cloudDeploymentId: row.cloud_deployment_id ? String(row.cloud_deployment_id) : null,
    cloudDeploymentSlug: row.cloud_deployment_slug ? String(row.cloud_deployment_slug) : null,
    state: String(row.state) as KoshDeployRevisionState,
    rollbackOfRevision: row.rollback_of_revision == null ? null : Number(row.rollback_of_revision),
    createdByUserId: String(row.created_by_user_id),
    createdAt: iso(row.created_at) ?? new Date(0).toISOString(),
    promotedAt: iso(row.promoted_at)
  };
}

export class KoshDeployStore {
  private readonly sql: Sql | null;
  private initialized = false;

  constructor(databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim() || "") {
    this.sql = databaseUrl ? postgres(databaseUrl, { max: 5, prepare: false }) : null;
  }

  private requireSql() {
    if (!this.sql) throw Object.assign(new Error("kosh_deploy_database_required"), { status: 503 });
    return this.sql;
  }

  async ready() {
    if (this.initialized) return;
    const sql = this.requireSql();
    await sql`
      CREATE TABLE IF NOT EXISTS kosh_deploy_services (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        namespace TEXT NOT NULL,
        repository_slug TEXT NOT NULL,
        container_port INTEGER NOT NULL,
        dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
        context_path TEXT NOT NULL DEFAULT '.',
        health_path TEXT NOT NULL DEFAULT '/',
        exposure TEXT NOT NULL DEFAULT 'private',
        active_revision_id TEXT,
        pending_revision_id TEXT,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK(container_port >= 1 AND container_port <= 65535),
        CHECK(exposure IN ('private','public'))
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS kosh_deploy_revisions (
        id TEXT PRIMARY KEY,
        service_id TEXT NOT NULL REFERENCES kosh_deploy_services(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        ref_name TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        cloud_deployment_id TEXT,
        cloud_deployment_slug TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        rollback_of_revision INTEGER,
        created_by_user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        promoted_at TIMESTAMPTZ,
        UNIQUE(service_id, revision),
        CHECK(state IN ('pending','active','superseded','failed','stopped'))
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS kosh_deploy_services_repo_idx ON kosh_deploy_services(repository_id, updated_at DESC)`;
    await sql`CREATE INDEX IF NOT EXISTS kosh_deploy_revisions_service_idx ON kosh_deploy_revisions(service_id, revision DESC)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS kosh_deploy_revisions_cloud_idx ON kosh_deploy_revisions(cloud_deployment_id) WHERE cloud_deployment_id IS NOT NULL`;
    this.initialized = true;
  }

  async listServices() {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`SELECT * FROM kosh_deploy_services ORDER BY updated_at DESC LIMIT 500`;
    return rows.map((row) => serviceFromRow(row as Row));
  }

  async getService(slug: string) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`SELECT * FROM kosh_deploy_services WHERE slug=${slug} LIMIT 1`;
    return rows[0] ? serviceFromRow(rows[0] as Row) : null;
  }

  async getRevision(id: string) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`SELECT * FROM kosh_deploy_revisions WHERE id=${id} LIMIT 1`;
    return rows[0] ? revisionFromRow(rows[0] as Row) : null;
  }

  async listRevisions(serviceId: string) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`
      SELECT * FROM kosh_deploy_revisions
      WHERE service_id=${serviceId}
      ORDER BY revision DESC
      LIMIT 100
    `;
    return rows.map((row) => revisionFromRow(row as Row));
  }

  async createRevision(input: {
    slug: string;
    name: string;
    repositoryId: string;
    namespace: string;
    repositorySlug: string;
    refName: string;
    commitSha: string;
    containerPort: number;
    dockerfilePath: string;
    contextPath: string;
    healthPath: string;
    exposure: "private" | "public";
    createdByUserId: string;
    rollbackOfRevision?: number | null;
  }) {
    await this.ready();
    const sql = this.requireSql();
    return sql.begin(async (tx) => {
      const existingRows = await tx`SELECT * FROM kosh_deploy_services WHERE slug=${input.slug} FOR UPDATE`;
      let service: KoshDeployService;
      if (!existingRows[0]) {
        const id = randomUUID();
        const inserted = await tx`
          INSERT INTO kosh_deploy_services(
            id, slug, name, repository_id, namespace, repository_slug,
            container_port, dockerfile_path, context_path, health_path, exposure,
            active_revision_id, pending_revision_id, created_by_user_id, created_at, updated_at
          ) VALUES (
            ${id}, ${input.slug}, ${input.name}, ${input.repositoryId}, ${input.namespace}, ${input.repositorySlug},
            ${input.containerPort}, ${input.dockerfilePath}, ${input.contextPath}, ${input.healthPath}, ${input.exposure},
            NULL, NULL, ${input.createdByUserId}, NOW(), NOW()
          ) RETURNING *
        `;
        service = serviceFromRow(inserted[0] as Row);
      } else {
        service = serviceFromRow(existingRows[0] as Row);
        if (service.repositoryId !== input.repositoryId) {
          throw Object.assign(new Error("deploy_service_repository_mismatch"), { status: 409 });
        }
        const updated = await tx`
          UPDATE kosh_deploy_services SET
            name=${input.name}, container_port=${input.containerPort},
            dockerfile_path=${input.dockerfilePath}, context_path=${input.contextPath},
            health_path=${input.healthPath}, exposure=${input.exposure}, updated_at=NOW()
          WHERE id=${service.id}
          RETURNING *
        `;
        service = serviceFromRow(updated[0] as Row);
      }

      if (service.pendingRevisionId) {
        const pendingRows = await tx`SELECT state FROM kosh_deploy_revisions WHERE id=${service.pendingRevisionId} LIMIT 1`;
        if (pendingRows[0] && String(pendingRows[0].state) === "pending") {
          throw Object.assign(new Error("deploy_revision_already_pending"), { status: 409 });
        }
      }

      const numberRows = await tx`SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM kosh_deploy_revisions WHERE service_id=${service.id}`;
      const revisionNumber = Number(numberRows[0]?.revision || 1);
      const revisionId = randomUUID();
      const revisionRows = await tx`
        INSERT INTO kosh_deploy_revisions(
          id, service_id, revision, ref_name, commit_sha, state,
          rollback_of_revision, created_by_user_id, created_at
        ) VALUES (
          ${revisionId}, ${service.id}, ${revisionNumber}, ${input.refName}, ${input.commitSha}, 'pending',
          ${input.rollbackOfRevision ?? null}, ${input.createdByUserId}, NOW()
        ) RETURNING *
      `;
      await tx`
        UPDATE kosh_deploy_services
        SET pending_revision_id=${revisionId}, updated_at=NOW()
        WHERE id=${service.id}
      `;
      return { service: { ...service, pendingRevisionId: revisionId }, revision: revisionFromRow(revisionRows[0] as Row) };
    });
  }

  async attachCloudDeployment(revisionId: string, cloudDeploymentId: string, cloudDeploymentSlug: string) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`
      UPDATE kosh_deploy_revisions
      SET cloud_deployment_id=${cloudDeploymentId}, cloud_deployment_slug=${cloudDeploymentSlug}
      WHERE id=${revisionId}
      RETURNING *
    `;
    return rows[0] ? revisionFromRow(rows[0] as Row) : null;
  }

  async sourceForCloudDeployment(cloudDeploymentId: string) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`
      SELECT
        s.id AS service_id, s.slug AS service_slug, s.repository_id, s.namespace, s.repository_slug,
        s.dockerfile_path, s.context_path, s.health_path, s.container_port,
        r.id AS revision_id, r.revision, r.ref_name, r.commit_sha, r.state
      FROM kosh_deploy_revisions r
      JOIN kosh_deploy_services s ON s.id=r.service_id
      WHERE r.cloud_deployment_id=${cloudDeploymentId}
      LIMIT 1
    `;
    if (!rows[0]) return null;
    const row = rows[0] as Row;
    return {
      serviceId: String(row.service_id),
      serviceSlug: String(row.service_slug),
      repositoryId: String(row.repository_id),
      namespace: String(row.namespace),
      repositorySlug: String(row.repository_slug),
      dockerfilePath: String(row.dockerfile_path),
      contextPath: String(row.context_path),
      healthPath: String(row.health_path),
      containerPort: Number(row.container_port),
      revisionId: String(row.revision_id),
      revision: Number(row.revision),
      refName: String(row.ref_name),
      commitSha: String(row.commit_sha),
      state: String(row.state) as KoshDeployRevisionState
    };
  }

  async activeTarget(slug: string) {
    await this.ready();
    const sql = this.requireSql();
    const rows = await sql`
      SELECT s.id AS service_id, s.slug AS service_slug, s.exposure,
             d.id AS deployment_id, d.node_id, d.assignment_generation, d.state
      FROM kosh_deploy_services s
      JOIN kosh_deploy_revisions r ON r.id=s.active_revision_id
      JOIN kosh_cloud_deployments d ON d.id=r.cloud_deployment_id
      WHERE s.slug=${slug}
      LIMIT 1
    `;
    if (!rows[0]) return null;
    const row = rows[0] as Row;
    return {
      serviceId: String(row.service_id),
      slug: String(row.service_slug),
      exposure: String(row.exposure) === "public" ? "public" as const : "private" as const,
      deploymentId: String(row.deployment_id),
      nodeId: row.node_id ? String(row.node_id) : null,
      assignmentGeneration: Number(row.assignment_generation || 0),
      state: String(row.state)
    };
  }

  async onCloudDeploymentState(cloudDeploymentId: string, state: "running" | "failed" | "stopped") {
    await this.ready();
    const sql = this.requireSql();
    return sql.begin(async (tx) => {
      const rows = await tx`
        SELECT r.*, s.active_revision_id, s.pending_revision_id
        FROM kosh_deploy_revisions r
        JOIN kosh_deploy_services s ON s.id=r.service_id
        WHERE r.cloud_deployment_id=${cloudDeploymentId}
        FOR UPDATE OF r, s
      `;
      if (!rows[0]) return null;
      const row = rows[0] as Row;
      const revision = revisionFromRow(row);
      const pendingId = row.pending_revision_id ? String(row.pending_revision_id) : null;
      const activeId = row.active_revision_id ? String(row.active_revision_id) : null;

      if (state === "running" && pendingId === revision.id) {
        let oldCloudDeploymentId: string | null = null;
        if (activeId && activeId !== revision.id) {
          const oldRows = await tx`
            UPDATE kosh_deploy_revisions
            SET state='superseded'
            WHERE id=${activeId}
            RETURNING cloud_deployment_id
          `;
          oldCloudDeploymentId = oldRows[0]?.cloud_deployment_id ? String(oldRows[0].cloud_deployment_id) : null;
        }
        await tx`
          UPDATE kosh_deploy_revisions
          SET state='active', promoted_at=NOW()
          WHERE id=${revision.id}
        `;
        await tx`
          UPDATE kosh_deploy_services
          SET active_revision_id=${revision.id}, pending_revision_id=NULL, updated_at=NOW()
          WHERE id=${revision.serviceId}
        `;
        return { promoted: true, oldCloudDeploymentId, serviceId: revision.serviceId, revisionId: revision.id };
      }

      if ((state === "failed" || state === "stopped") && pendingId === revision.id) {
        await tx`UPDATE kosh_deploy_revisions SET state=${state === "failed" ? "failed" : "stopped"} WHERE id=${revision.id}`;
        await tx`UPDATE kosh_deploy_services SET pending_revision_id=NULL, updated_at=NOW() WHERE id=${revision.serviceId}`;
        return { promoted: false, oldCloudDeploymentId: null, serviceId: revision.serviceId, revisionId: revision.id };
      }
      return { promoted: false, oldCloudDeploymentId: null, serviceId: revision.serviceId, revisionId: revision.id };
    });
  }
}

let singleton: KoshDeployStore | null = null;
export function getKoshDeployStore() {
  singleton ??= new KoshDeployStore();
  return singleton;
}
