import postgres from "postgres";

let sql: ReturnType<typeof postgres> | null = null;

function database() {
  const url = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!url) throw Object.assign(new Error("kosh_deploy_database_required"), { status: 503 });
  sql ??= postgres(url, { max: 2, prepare: false });
  return sql;
}

export async function failKoshDeployRevision(revisionId: string) {
  const db = database();
  await db.begin(async (tx) => {
    const rows = await tx`
      SELECT service_id, state
      FROM kosh_deploy_revisions
      WHERE id=${revisionId}
      FOR UPDATE
    `;
    if (!rows[0] || String(rows[0].state) !== "pending") return;
    const serviceId = String(rows[0].service_id);
    await tx`
      UPDATE kosh_deploy_revisions
      SET state='failed'
      WHERE id=${revisionId} AND state='pending'
    `;
    await tx`
      UPDATE kosh_deploy_services
      SET pending_revision_id=NULL, updated_at=NOW()
      WHERE id=${serviceId} AND pending_revision_id=${revisionId}
    `;
  });
}
