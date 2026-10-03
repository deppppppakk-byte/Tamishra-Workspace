import { enqueueKoshOpsJob, type KoshOpsJobType } from "./kosh-ops-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";

const platformStore = getKoshPlatformStore();
const knownTypes = new Set<KoshOpsJobType>([
  "storage.lifecycle",
  "replication.verify",
  "recovery.drill",
  "alerts.evaluate",
  "notification.deliver",
  "pages.domain.verify",
  "extension.execute",
  "load.test",
  "database.backup",
  "secret.rotation.audit",
  "failure.probe"
]);

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function enqueueDueKoshOpsSchedules() {
  await platformStore.ready();
  const resources = await platformStore.listResources("admin_setting");
  const now = Date.now();
  const outcomes: Array<Record<string, unknown>> = [];

  for (const resource of resources) {
    if (
      resource.state !== "active" ||
      resource.payload.kind !== "ops_schedule" ||
      resource.payload.enabled === false
    ) continue;
    const type = String(resource.payload.jobType ?? "") as KoshOpsJobType;
    if (!knownTypes.has(type)) continue;
    const nextRunAt = new Date(String(resource.payload.nextRunAt ?? 0)).getTime();
    if (!Number.isFinite(nextRunAt) || nextRunAt > now) continue;
    const intervalMinutes = Math.max(
      5,
      Math.min(30 * 24 * 60, Math.floor(Number(resource.payload.intervalMinutes) || 60))
    );
    const next = new Date(now + intervalMinutes * 60_000).toISOString();
    const payload = {
      ...resource.payload,
      nextRunAt: next,
      lastEnqueuedAt: new Date(now).toISOString(),
      lastError: null
    };
    await platformStore.updateResource(resource.id, { payload });
    try {
      const job = await enqueueKoshOpsJob({
        repositoryId: resource.repositoryId,
        type,
        payload: record(resource.payload.jobPayload),
        maxAttempts: 3,
        createdByUserId: resource.createdByUserId,
        createdByName: `Kosh schedule: ${resource.name}`
      });
      outcomes.push({ scheduleId: resource.id, jobId: job.id, type });
    } catch (error) {
      await platformStore.updateResource(resource.id, {
        payload: {
          ...payload,
          nextRunAt: new Date(now + Math.min(15, intervalMinutes) * 60_000).toISOString(),
          lastError: error instanceof Error ? error.message : "schedule_enqueue_failed"
        }
      });
      outcomes.push({
        scheduleId: resource.id,
        type,
        error: error instanceof Error ? error.message : "schedule_enqueue_failed"
      });
    }
  }
  return outcomes;
}
