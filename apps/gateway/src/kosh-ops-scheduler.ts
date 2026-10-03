import { enqueueKoshOpsJobWithPoolAdmission } from "./kosh-ops-pool-policy.js";
import { type KoshOpsJobType } from "./kosh-ops-store.js";
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

function priority(value: unknown) {
  const parsed = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(parsed) ? Math.floor(parsed) : 50));
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
    const scheduledFor = new Date(nextRunAt).toISOString();
    const next = new Date(now + intervalMinutes * 60_000).toISOString();

    try {
      const job = await enqueueKoshOpsJobWithPoolAdmission({
        repositoryId: resource.repositoryId,
        type,
        payload: record(resource.payload.jobPayload),
        maxAttempts: 3,
        priority: priority(resource.payload.priority),
        idempotencyKey: `schedule:${resource.id}:${scheduledFor}`,
        createdByUserId: resource.createdByUserId,
        createdByName: `Kosh schedule: ${resource.name}`
      });
      await platformStore.updateResource(resource.id, {
        payload: {
          ...resource.payload,
          nextRunAt: next,
          lastEnqueuedAt: new Date(now).toISOString(),
          lastJobId: job.id,
          lastError: null
        }
      });
      outcomes.push({ scheduleId: resource.id, jobId: job.id, type, scheduledFor });
    } catch (error) {
      try {
        await platformStore.updateResource(resource.id, {
          payload: {
            ...resource.payload,
            lastError: error instanceof Error ? error.message : "schedule_enqueue_failed"
          }
        });
      } catch {
        // Preserve the original nextRunAt so the same occurrence is retried with the same idempotency key.
      }
      outcomes.push({
        scheduleId: resource.id,
        type,
        scheduledFor,
        error: error instanceof Error ? error.message : "schedule_enqueue_failed"
      });
    }
  }
  return outcomes;
}
