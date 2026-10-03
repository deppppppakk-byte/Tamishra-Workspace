import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshMaintenanceStore, koshMaintenanceJobKinds } from "./kosh-maintenance-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshProductionPolicy } from "./kosh-production-jobs.js";
import { getKoshStore } from "./kosh-store.js";

const maintenanceStore = getKoshMaintenanceStore();
const platformStore = getKoshPlatformStore();
const repositoryStore = getKoshStore();

type Alert = {
  id: string;
  severity: "warning" | "critical";
  repositoryId: string;
  message: string;
  evidence: Record<string, unknown>;
};

function bearer(request: IncomingMessage) {
  const value = request.headers.authorization?.trim() ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function safeEqual(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function workerAuthorized(request: IncomingMessage) {
  const expected = process.env.KOSH_MAINTENANCE_TOKEN?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  return safeEqual(bearer(request), expected);
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

function escapeLabel(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export async function koshProductionMetrics() {
  await Promise.all([maintenanceStore.ready(), platformStore.ready()]);
  const [jobs, repositories, audit] = await Promise.all([
    maintenanceStore.list(undefined, 500),
    repositoryStore.list(),
    platformStore.listAudit(undefined, 500)
  ]);
  const lines = [
    "# HELP kosh_repositories_total Number of repositories known to Kosh.",
    "# TYPE kosh_repositories_total gauge",
    `kosh_repositories_total ${repositories.length}`,
    "# HELP kosh_maintenance_jobs Maintenance jobs by state and kind.",
    "# TYPE kosh_maintenance_jobs gauge"
  ];
  for (const kind of koshMaintenanceJobKinds) {
    for (const status of ["queued", "running", "succeeded", "failed", "cancelled"] as const) {
      const count = jobs.filter((item) => item.kind === kind && item.status === status).length;
      lines.push(
        `kosh_maintenance_jobs{kind="${escapeLabel(kind)}",status="${status}"} ${count}`
      );
    }
  }
  const running = jobs.filter((item) => item.status === "running");
  const now = Date.now();
  const oldestRunningSeconds = running.length
    ? Math.max(
        ...running.map((item) =>
          Math.max(0, (now - new Date(item.startedAt || item.updatedAt).getTime()) / 1000)
        )
      )
    : 0;
  lines.push("# HELP kosh_maintenance_oldest_running_seconds Age of the oldest running maintenance job.");
  lines.push("# TYPE kosh_maintenance_oldest_running_seconds gauge");
  lines.push(`kosh_maintenance_oldest_running_seconds ${oldestRunningSeconds.toFixed(0)}`);
  lines.push("# HELP kosh_audit_events_sampled Number of recent audit events returned by the bounded telemetry sample.");
  lines.push("# TYPE kosh_audit_events_sampled gauge");
  lines.push(`kosh_audit_events_sampled ${audit.length}`);
  return lines.join("\n") + "\n";
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

async function persistAlerts(repositoryId: string, namespace: string, alerts: Alert[]) {
  const resources = await platformStore.listResources("admin_setting", repositoryId);
  const existing = resources.find((item) => item.key === "production:alerts");
  const payload = {
    kind: "production_alerts",
    checkedAt: new Date().toISOString(),
    alerts
  };
  if (existing) {
    return platformStore.updateResource(existing.id, {
      state: alerts.some((item) => item.severity === "critical")
        ? "critical"
        : alerts.length
          ? "warning"
          : "healthy",
      payload
    });
  }
  return platformStore.createResource({
    repositoryId,
    namespace,
    type: "admin_setting",
    key: "production:alerts",
    name: "Production alerts",
    state: alerts.length ? "warning" : "healthy",
    payload,
    createdByUserId: "kosh-maintenance",
    createdByName: "Kosh Maintenance"
  });
}

export async function evaluateKoshProductionAlerts() {
  await Promise.all([maintenanceStore.ready(), platformStore.ready()]);
  const repositories = await repositoryStore.list();
  const allAlerts: Alert[] = [];

  for (const repository of repositories) {
    const [jobs, policies, policy] = await Promise.all([
      maintenanceStore.list(repository.id, 200),
      platformStore.listResources("storage_policy", repository.id),
      getKoshProductionPolicy(repository.id)
    ]);
    const alerts: Alert[] = [];
    const failed = jobs.filter(
      (item) => item.status === "failed" && Date.now() - new Date(item.updatedAt).getTime() <= 24 * 60 * 60 * 1000
    );
    if (failed.length) {
      alerts.push({
        id: "maintenance-failures",
        severity: failed.length >= 3 ? "critical" : "warning",
        repositoryId: repository.id,
        message: `${failed.length} maintenance job(s) failed in the last 24 hours.`,
        evidence: { jobIds: failed.slice(0, 20).map((item) => item.id) }
      });
    }

    const reconciliation = policies.find((item) => item.key === "reconciliation:evidence");
    const reconciliationPayload = record(reconciliation?.payload);
    const checkedAt = String(reconciliationPayload.checkedAt ?? "");
    const reconciliationAgeHours = checkedAt
      ? (Date.now() - new Date(checkedAt).getTime()) / 3_600_000
      : Number.POSITIVE_INFINITY;
    const summary = record(reconciliationPayload.summary);
    const missing = numberValue(summary.missing);
    const mismatched = numberValue(summary.mismatched);
    if (missing || mismatched) {
      alerts.push({
        id: "storage-integrity",
        severity: "critical",
        repositoryId: repository.id,
        message: `${missing} missing and ${mismatched} mismatched storage object(s) require attention.`,
        evidence: { missing, mismatched }
      });
    } else if (reconciliationAgeHours > Math.max(24, policy.reconciliationHours * 2)) {
      alerts.push({
        id: "storage-reconciliation-stale",
        severity: "warning",
        repositoryId: repository.id,
        message: "Storage reconciliation evidence is stale or absent.",
        evidence: { checkedAt: checkedAt || null, ageHours: reconciliationAgeHours }
      });
    }

    const replication = policies.find((item) => item.key === "replication:evidence");
    const replicationPayload = record(replication?.payload);
    const replicationFailures = numberValue(replicationPayload.failures);
    if (policy.replicationEnabled && replicationFailures > 0) {
      alerts.push({
        id: "replication-failures",
        severity: "critical",
        repositoryId: repository.id,
        message: `${replicationFailures} replicated object(s) failed verification.`,
        evidence: { failures: replicationFailures }
      });
    }

    const backups = await platformStore.listResources("backup", repository.id);
    const latestDrillAt = backups
      .map((item) => String(item.payload.lastDrillAt ?? ""))
      .filter(Boolean)
      .sort()
      .at(-1) ?? "";
    const drillAgeDays = latestDrillAt
      ? (Date.now() - new Date(latestDrillAt).getTime()) / (24 * 60 * 60 * 1000)
      : Number.POSITIVE_INFINITY;
    if (drillAgeDays > policy.recoveryDrillDays * 1.5) {
      alerts.push({
        id: "recovery-drill-overdue",
        severity: "warning",
        repositoryId: repository.id,
        message: "A verified recovery drill is overdue.",
        evidence: { latestDrillAt: latestDrillAt || null, configuredDays: policy.recoveryDrillDays }
      });
    }

    await persistAlerts(repository.id, repository.namespace, alerts);
    allAlerts.push(...alerts);

    if (alerts.length && process.env.KOSH_NOTIFICATION_DELIVERY_HOOK?.trim()) {
      await maintenanceStore.enqueue({
        repositoryId: repository.id,
        kind: "notification_delivery",
        priority: alerts.some((item) => item.severity === "critical") ? 100 : 50,
        dedupeKey: `production-alerts:${repository.id}:${new Date().toISOString().slice(0, 13)}`,
        payload: {
          category: "production_alerts",
          repository: `${repository.namespace}/${repository.slug}`,
          alerts
        }
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    repositories: repositories.length,
    alerts: allAlerts
  };
}

export async function handleKoshProductionObservabilityRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (url.pathname === "/v1/kosh/maintenance/metrics") {
    if (!workerAuthorized(request)) {
      sendJson(response, 401, { error: "maintenance_worker_authentication_required" }, origin, allowedOrigins);
      return true;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
      return true;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(await koshProductionMetrics());
    return true;
  }

  if (url.pathname === "/v1/kosh/maintenance/alerts/evaluate") {
    if (!workerAuthorized(request)) {
      sendJson(response, 401, { error: "maintenance_worker_authentication_required" }, origin, allowedOrigins);
      return true;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
      return true;
    }
    sendJson(response, 200, await evaluateKoshProductionAlerts(), origin, allowedOrigins);
    return true;
  }

  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/production\/alerts$/
  );
  if (!match) return false;
  const repository = await repositoryStore.get(match[1], match[2]);
  if (!repository) {
    sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
    return true;
  }
  const authorization = await authorizeKoshRepositoryRequest(request, repository, "repository.read");
  if (!authorization.identity || !authorization.decision.allowed) {
    sendJson(
      response,
      authorization.identity ? 403 : 401,
      { error: authorization.identity ? "repository_permission_denied" : "authentication_required" },
      origin,
      allowedOrigins
    );
    return true;
  }
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
    return true;
  }
  const resources = await platformStore.listResources("admin_setting", repository.id);
  const alerts = resources.find((item) => item.key === "production:alerts") ?? null;
  sendJson(response, 200, { alerts }, origin, allowedOrigins);
  return true;
}
