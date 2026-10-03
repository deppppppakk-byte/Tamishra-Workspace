import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  getKoshOpsQueueStats,
  listKoshOpsJobs,
  type KoshOpsJob
} from "./kosh-ops-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { koshKnownStorageUsage, koshStorageLimits } from "./kosh-storage-policy.js";
import { getKoshStore } from "./kosh-store.js";

const repositories = getKoshStore();
const platformStore = getKoshPlatformStore();

type Identity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function platformAdministrator(identity: Identity) {
  const ids = new Set(
    (process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return ids.size > 0
    ? ids.has(identity.user.id)
    : process.env.NODE_ENV !== "production" &&
        identity.memberships.some((item) => ["owner", "admin"].includes(item.membership.role));
}

function cors(response: ServerResponse, origin: string | undefined, allowed: ReadonlySet<string>) {
  if (origin && allowed.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
}

function json(response: ServerResponse, status: number, body: unknown, origin: string | undefined, allowed: ReadonlySet<string>) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  cors(response, origin, allowed);
  response.end(JSON.stringify(body));
}

function metricLine(name: string, value: number, labels: Record<string, string> = {}) {
  const pairs = Object.entries(labels)
    .map(([key, item]) => `${key}="${item.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join(",");
  return `${name}${pairs ? `{${pairs}}` : ""} ${Number.isFinite(value) ? value : 0}`;
}

function successLatency(jobs: KoshOpsJob[]) {
  const durations = jobs
    .filter((item) => item.state === "succeeded")
    .map((item) => new Date(item.finishedAt ?? item.updatedAt).getTime() - new Date(item.createdAt).getTime())
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const percentile = (p: number) => durations[
    Math.min(durations.length - 1, Math.floor(Math.max(0, durations.length - 1) * p))
  ] ?? 0;
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99)
  };
}

async function repositoryMetrics(repositoryId: string) {
  const [jobs, queue, usage, limits, audits, backups] = await Promise.all([
    listKoshOpsJobs(repositoryId, 1000),
    getKoshOpsQueueStats(repositoryId),
    koshKnownStorageUsage(repositoryId),
    koshStorageLimits(repositoryId),
    platformStore.listAudit(repositoryId, 1000),
    platformStore.listResources("backup", repositoryId)
  ]);
  return {
    queue: {
      ...queue,
      successLatencyMs: successLatency(jobs)
    },
    storage: {
      usage,
      limits,
      ratio: limits.maxTotalBytes > 0 ? usage.knownBytes / limits.maxTotalBytes : 0
    },
    evidence: {
      recentAuditEvents: audits.length,
      restorePoints: backups.length,
      verifiedRestorePoints: backups.filter((item) => item.state === "verified").length
    }
  };
}

function renderPrometheus(
  scope: "platform" | "repository",
  metrics: Awaited<ReturnType<typeof repositoryMetrics>>,
  labels: Record<string, string>
) {
  const lines = [
    "# HELP kosh_ops_jobs Kosh asynchronous operations by state.",
    "# TYPE kosh_ops_jobs gauge"
  ];
  for (const [state, count] of Object.entries(metrics.queue.byState)) {
    lines.push(metricLine("kosh_ops_jobs", Number(count), { ...labels, scope, state }));
  }
  lines.push(metricLine("kosh_ops_dead_lettered", metrics.queue.deadLettered, { ...labels, scope }));
  lines.push(metricLine("kosh_ops_retrying", metrics.queue.retrying, { ...labels, scope }));
  lines.push(metricLine("kosh_ops_oldest_queued_age_ms", metrics.queue.oldestQueuedAgeMs, { ...labels, scope }));
  lines.push(metricLine("kosh_ops_throughput", metrics.queue.throughput.lastHour, { ...labels, scope, window: "1h" }));
  lines.push(metricLine("kosh_ops_throughput", metrics.queue.throughput.last24Hours, { ...labels, scope, window: "24h" }));
  for (const [priority, count] of Object.entries(metrics.queue.queuedByPriority)) {
    lines.push(metricLine("kosh_ops_queued_by_priority", Number(count), { ...labels, scope, priority }));
  }
  lines.push(metricLine("kosh_ops_queue_limit", metrics.queue.limits.globalQueued, { ...labels, scope, kind: "global" }));
  lines.push(metricLine("kosh_ops_queue_limit", metrics.queue.limits.repositoryQueued, { ...labels, scope, kind: "repository" }));
  lines.push("# HELP kosh_storage_known_bytes Known Kosh object-storage bytes.");
  lines.push("# TYPE kosh_storage_known_bytes gauge");
  lines.push(metricLine("kosh_storage_known_bytes", metrics.storage.usage.knownBytes, labels));
  lines.push("# HELP kosh_storage_quota_bytes Configured Kosh repository storage quota.");
  lines.push("# TYPE kosh_storage_quota_bytes gauge");
  lines.push(metricLine("kosh_storage_quota_bytes", metrics.storage.limits.maxTotalBytes, labels));
  lines.push("# HELP kosh_storage_quota_ratio Fraction of repository storage quota consumed.");
  lines.push("# TYPE kosh_storage_quota_ratio gauge");
  lines.push(metricLine("kosh_storage_quota_ratio", metrics.storage.ratio, labels));
  lines.push(metricLine("kosh_ops_success_latency_ms", metrics.queue.successLatencyMs.p50, { ...labels, quantile: "0.50" }));
  lines.push(metricLine("kosh_ops_success_latency_ms", metrics.queue.successLatencyMs.p95, { ...labels, quantile: "0.95" }));
  lines.push(metricLine("kosh_ops_success_latency_ms", metrics.queue.successLatencyMs.p99, { ...labels, quantile: "0.99" }));
  lines.push(metricLine("kosh_audit_events_recent", metrics.evidence.recentAuditEvents, labels));
  lines.push(metricLine("kosh_restore_points", metrics.evidence.restorePoints, labels));
  lines.push(metricLine("kosh_restore_points_verified", metrics.evidence.verifiedRestorePoints, labels));
  return lines.join("\n") + "\n";
}

export async function handleKoshOperationsMetricsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (request.method !== "GET") return false;
  const platformMatch = url.pathname === "/v1/kosh/systems/metrics";
  const repoMatch = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/metrics$/
  );
  if (!platformMatch && !repoMatch) return false;
  await platformStore.ready();

  if (platformMatch) {
    const identity = await resolveKoshIdentity(request);
    if (!identity || !platformAdministrator(identity)) {
      json(response, identity ? 403 : 401, { error: identity ? "platform_admin_required" : "authentication_required" }, origin, allowedOrigins);
      return true;
    }
    const all = await repositories.list();
    const [perRepository, globalJobs, globalQueue] = await Promise.all([
      Promise.all(all.map(async (repository) => ({
        repository,
        metrics: await repositoryMetrics(repository.id)
      }))),
      listKoshOpsJobs(undefined, 1000),
      getKoshOpsQueueStats(undefined)
    ]);
    const aggregate = {
      queue: {
        ...globalQueue,
        successLatencyMs: successLatency(globalJobs)
      },
      storage: {
        usage: {
          packageBytes: 0,
          releaseBytes: 0,
          artifactBytes: 0,
          backupBytes: 0,
          knownBytes: perRepository.reduce((sum, item) => sum + item.metrics.storage.usage.knownBytes, 0)
        },
        limits: {
          policyId: null,
          maxTotalBytes: perRepository.reduce((sum, item) => sum + item.metrics.storage.limits.maxTotalBytes, 0),
          maxArtifactBytes: 0,
          maxPackageBytes: 0,
          maxReleaseBytes: 0,
          maxBackupBytes: 0
        },
        ratio: 0
      },
      evidence: {
        recentAuditEvents: perRepository.reduce((sum, item) => sum + item.metrics.evidence.recentAuditEvents, 0),
        restorePoints: perRepository.reduce((sum, item) => sum + item.metrics.evidence.restorePoints, 0),
        verifiedRestorePoints: perRepository.reduce((sum, item) => sum + item.metrics.evidence.verifiedRestorePoints, 0)
      }
    };
    aggregate.storage.ratio = aggregate.storage.limits.maxTotalBytes > 0
      ? aggregate.storage.usage.knownBytes / aggregate.storage.limits.maxTotalBytes
      : 0;
    if ((request.headers.accept ?? "").includes("text/plain")) {
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      cors(response, origin, allowedOrigins);
      response.end(renderPrometheus("platform", aggregate, {}));
      return true;
    }
    json(response, 200, {
      scope: "platform",
      checkedAt: new Date().toISOString(),
      repositories: all.length,
      metrics: aggregate,
      perRepository: perRepository.map((item) => ({
        id: item.repository.id,
        namespace: item.repository.namespace,
        slug: item.repository.slug,
        metrics: item.metrics
      }))
    }, origin, allowedOrigins);
    return true;
  }

  const repository = await repositories.get(repoMatch![1], repoMatch![2]);
  if (!repository) {
    json(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
    return true;
  }
  const authorization = await authorizeKoshRepositoryRequest(request, repository, "repository.read");
  if (!authorization.identity || !authorization.decision.allowed) {
    json(response, authorization.identity ? 403 : 401, {
      error: authorization.identity ? "repository_permission_denied" : "authentication_required"
    }, origin, allowedOrigins);
    return true;
  }
  const metrics = await repositoryMetrics(repository.id);
  if ((request.headers.accept ?? "").includes("text/plain")) {
    response.statusCode = 200;
    response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    cors(response, origin, allowedOrigins);
    response.end(renderPrometheus("repository", metrics, {
      namespace: repository.namespace,
      repository: repository.slug
    }));
    return true;
  }
  json(response, 200, {
    scope: "repository",
    checkedAt: new Date().toISOString(),
    repository: { id: repository.id, namespace: repository.namespace, slug: repository.slug },
    metrics
  }, origin, allowedOrigins);
  return true;
}