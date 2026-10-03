import { deleteKoshObject } from "./kosh-object-storage.js";
import {
  enqueueKoshOpsJob,
  type KoshOpsJob
} from "./kosh-ops-store.js";
import { processKoshOpsJob } from "./kosh-ops-processor.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";

const platformStore = getKoshPlatformStore();
const objectIndex = getKoshObjectIndex();
const platformObjectRepositoryId = "__kosh_platform__";

function retentionCount() {
  const configured = Number(process.env.KOSH_DATABASE_BACKUP_RETENTION ?? 14);
  return Number.isFinite(configured)
    ? Math.max(1, Math.min(3650, Math.floor(configured)))
    : 14;
}

async function enqueueNotification(
  job: KoshOpsJob,
  event: string,
  message: string,
  data: Record<string, unknown>
) {
  if (!process.env.KOSH_NOTIFICATION_DELIVERY_ENDPOINT?.trim()) return null;
  return enqueueKoshOpsJob({
    repositoryId: job.repositoryId,
    type: "notification.deliver",
    payload: { event, message, data },
    maxAttempts: 3,
    createdByUserId: null,
    createdByName: "Kosh Operations"
  });
}

async function pruneDatabaseBackups() {
  const keep = retentionCount();
  const backups = (await platformStore.listResources("backup", null))
    .filter((item) => item.payload.kind === "postgres-custom")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pruned: string[] = [];
  const failures: Array<{ backupId: string; error: string }> = [];

  for (const backup of backups.slice(keep)) {
    const logicalId = String(backup.payload.storageLogicalId ?? "").trim();
    if (!logicalId) {
      failures.push({ backupId: backup.id, error: "database_backup_logical_id_missing" });
      continue;
    }
    try {
      const indexed = await objectIndex.get(
        platformObjectRepositoryId,
        "backup",
        logicalId
      );
      if (!indexed) {
        throw new Error("database_backup_locator_missing");
      }
      await deleteKoshObject(indexed.locator, "");
      await objectIndex.delete(platformObjectRepositoryId, "backup", logicalId);
      await platformStore.deleteResource(backup.id);
      await platformStore.appendAudit({
        repositoryId: null,
        actorUserId: null,
        actorName: "Kosh Operations",
        eventType: "database_backup_pruned",
        resourceType: "backup",
        resourceId: backup.id,
        metadata: {
          logicalId,
          retentionCount: keep,
          createdAt: backup.createdAt
        }
      });
      pruned.push(backup.id);
    } catch (error) {
      failures.push({
        backupId: backup.id,
        error: error instanceof Error ? error.message : "database_backup_prune_failed"
      });
    }
  }

  return { retentionCount: keep, pruned, failures };
}

export async function processKoshOpsJobWithPostprocessing(job: KoshOpsJob) {
  const result = await processKoshOpsJob(job);
  const postprocess: Record<string, unknown> = {};

  if (job.type === "alerts.evaluate" && job.payload.notify !== false) {
    const fired = Array.isArray(result.fired) ? result.fired : [];
    if (fired.length) {
      const notification = await enqueueNotification(
        job,
        "operations.alert",
        `${fired.length} Kosh operations alert${fired.length === 1 ? "" : "s"} fired.`,
        { fired, context: result.context ?? null }
      );
      if (notification) postprocess.notificationJobId = notification.id;
    }
  }

  if (job.type === "secret.rotation.audit" && job.payload.notify !== false) {
    const overdue = Array.isArray(result.overdue) ? result.overdue : [];
    if (overdue.length) {
      const notification = await enqueueNotification(
        job,
        "security.secret_rotation_overdue",
        `${overdue.length} Kosh secret${overdue.length === 1 ? " is" : "s are"} overdue for rotation.`,
        { overdue }
      );
      if (notification) postprocess.notificationJobId = notification.id;
    }
  }

  if (job.type === "database.backup") {
    postprocess.retention = await pruneDatabaseBackups();
  }

  return Object.keys(postprocess).length
    ? { ...result, postprocess }
    : result;
}
