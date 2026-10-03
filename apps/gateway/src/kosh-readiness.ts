import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { automationStore } from "./kosh-automation-service.js";
import { probeKoshDriveStorage } from "./kosh-google-drive-admin.js";
import { koshObjectStorageBackend } from "./kosh-object-storage.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { koshKnownStorageUsage, koshStorageLimits } from "./kosh-storage-policy.js";
import { getKoshStorageReconciliationEvidence } from "./kosh-storage-reconciliation.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const automation = automationStore();

type ReadinessStatus = "pass" | "warn" | "fail";
type ReadinessCheck = {
  id: string;
  status: ReadinessStatus;
  detail: string;
};

type KoshIdentity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  allowedOrigins?: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins?.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

function configured(name: string, minimumLength = 1) {
  const value = process.env[name]?.trim() ?? "";
  return value.length >= minimumLength && !/^change-me/i.test(value);
}

function platformAdministrator(identity: KoshIdentity) {
  const configuredIds = new Set(
    (process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return configuredIds.size > 0
    ? configuredIds.has(identity.user.id)
    : process.env.NODE_ENV !== "production" &&
        identity.memberships.some(
          (item) =>
            item.membership.role === "owner" ||
            item.membership.role === "admin"
        );
}

function summarize(checks: ReadinessCheck[]) {
  const failures = checks.filter((item) => item.status === "fail").length;
  const warnings = checks.filter((item) => item.status === "warn").length;
  return {
    status: failures > 0 ? "not_ready" : warnings > 0 ? "degraded" : "ready",
    passing: checks.length - failures - warnings,
    warnings,
    failures
  } as const;
}

function ratioStatus(value: number): ReadinessStatus {
  if (value >= 1) return "fail";
  if (value >= 0.85) return "warn";
  return "pass";
}

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

async function platformReadiness() {
  await platformStore.ready();
  const production = process.env.NODE_ENV === "production";
  const repositories = await repositoryStore.list();
  const recentAudit = await platformStore.listAudit(undefined, 100);
  const storageBackend = koshObjectStorageBackend();
  const driveHealth = storageBackend === "google-drive"
    ? await probeKoshDriveStorage().catch((error) => ({
        ok: false,
        checkedAt: new Date().toISOString(),
        checks: [],
        error: error instanceof Error ? error.message : "drive_probe_failed"
      }))
    : null;

  const checks: ReadinessCheck[] = [
    {
      id: "persistence",
      status: configured("WORKSPACE_DATABASE_URL", 12)
        ? "pass"
        : production
          ? "fail"
          : "warn",
      detail: configured("WORKSPACE_DATABASE_URL", 12)
        ? "Persistent PostgreSQL metadata is configured."
        : "Kosh metadata is using an ephemeral store."
    },
    {
      id: "secret-encryption",
      status: configured("KOSH_MASTER_KEY", 32)
        ? "pass"
        : production
          ? "fail"
          : "warn",
      detail: configured("KOSH_MASTER_KEY", 32)
        ? "A production-strength Kosh encryption key is configured."
        : "A production-strength KOSH_MASTER_KEY is not configured."
    },
    {
      id: "platform-administrators",
      status: configured("KOSH_PLATFORM_ADMIN_USER_IDS")
        ? "pass"
        : production
          ? "fail"
          : "warn",
      detail: configured("KOSH_PLATFORM_ADMIN_USER_IDS")
        ? "Explicit Kosh platform administrators are configured."
        : "No explicit production platform-administrator list is configured."
    },
    {
      id: "runner-authentication",
      status: configured("KOSH_RUNNER_TOKEN", 24)
        ? "pass"
        : production
          ? "fail"
          : "warn",
      detail: configured("KOSH_RUNNER_TOKEN", 24)
        ? "Kosh Runner authentication is configured."
        : "Kosh Runner authentication is not production-ready."
    },
    {
      id: "repository-root",
      status: configured("KOSH_REPO_ROOT", 2) ? "pass" : "warn",
      detail: configured("KOSH_REPO_ROOT", 2)
        ? "An explicit Git repository root is configured."
        : "Kosh is using its default Git repository root."
    },
    {
      id: "recovery-root",
      status: configured("KOSH_BACKUP_ROOT", 2) ? "pass" : "warn",
      detail: configured("KOSH_BACKUP_ROOT", 2)
        ? "An explicit recovery-bundle root is configured."
        : "Kosh is using its default recovery-bundle root."
    },
    {
      id: "object-storage-backend",
      status: storageBackend === "google-drive" ? "pass" : production ? "warn" : "pass",
      detail: storageBackend === "google-drive"
        ? "Kosh object classes are configured for the Google Drive storage adapter."
        : "Kosh object classes are using local object storage."
    },
    ...(storageBackend === "google-drive"
      ? [{
          id: "google-drive-folders",
          status: driveHealth?.ok ? "pass" as const : "fail" as const,
          detail: driveHealth?.ok
            ? "All configured Kosh Drive storage folders are reachable."
            : "One or more configured Kosh Drive storage folders could not be verified."
        }]
      : []),
    {
      id: "legacy-access",
      status: (process.env.KOSH_ACCESS_LEGACY_MODE ?? "deny") === "deny"
        ? "pass"
        : "warn",
      detail:
        "Legacy repository access mode is " +
        (process.env.KOSH_ACCESS_LEGACY_MODE ?? "deny") +
        "."
    },
    {
      id: "webhook-network-boundary",
      status: (process.env.KOSH_WEBHOOK_BLOCK_PRIVATE_NETWORKS ?? "true") !== "false"
        ? "pass"
        : "warn",
      detail: (process.env.KOSH_WEBHOOK_BLOCK_PRIVATE_NETWORKS ?? "true") !== "false"
        ? "Private-network webhook destinations are blocked."
        : "Private-network webhook destinations are permitted."
    },
    {
      id: "runner-network-boundary",
      status: (process.env.KOSH_RUNNER_ALLOW_NETWORK ?? "false") === "false"
        ? "pass"
        : "warn",
      detail: (process.env.KOSH_RUNNER_ALLOW_NETWORK ?? "false") === "false"
        ? "Runner outbound network access is denied by default."
        : "Runner pools can request outbound network access."
    }
  ];

  return {
    ...summarize(checks),
    scope: "platform",
    production,
    persistence: platformStore.kind,
    checkedAt: new Date().toISOString(),
    checks,
    evidence: {
      repositories: repositories.length,
      recentAuditEvents: recentAudit.length,
      objectStorage: {
        backend: storageBackend,
        drive: driveHealth
      }
    }
  };
}

async function repositoryReadiness(repositoryId: string) {
  await Promise.all([platformStore.ready(), automation.ready()]);
  const [usage, limits, backups, queue, runs, deployments, recentAudit, reconciliation] =
    await Promise.all([
      koshKnownStorageUsage(repositoryId),
      koshStorageLimits(repositoryId),
      platformStore.listResources("backup", repositoryId),
      platformStore.listResources("merge_queue_entry", repositoryId),
      automation.listRuns(repositoryId, 200),
      automation.listDeployments(repositoryId, 200),
      platformStore.listAudit(repositoryId, 100),
      getKoshStorageReconciliationEvidence(repositoryId)
    ]);

  const storageRatio = limits.maxTotalBytes > 0
    ? usage.knownBytes / limits.maxTotalBytes
    : 1;
  const verifiedBackups = backups.filter(
    (item) => item.state !== "invalid" && item.payload.verificationValid === true
  );
  const invalidBackups = backups.filter((item) => item.state === "invalid");
  const failedRuns = runs.filter((item) => item.status === "failure");
  const runningRuns = runs.filter((item) => item.status === "running");
  const failedDeployments = deployments.filter((item) => item.status === "failure");
  const runningDeployments = deployments.filter((item) => item.status === "running");
  const processingQueue = queue.filter((item) => item.state === "processing");
  const failedQueue = queue.filter((item) => item.state === "failed");
  const reconciliationPayload = record(reconciliation?.payload);
  const reconciliationSummary = record(reconciliationPayload.summary);
  const driveErrors = record(reconciliationPayload.driveErrors);
  const reconciliationCheckedAt = String(reconciliationPayload.checkedAt ?? "");
  const reconciliationAgeMs = reconciliationCheckedAt
    ? Date.now() - new Date(reconciliationCheckedAt).getTime()
    : Number.POSITIVE_INFINITY;
  const missingStorage = numberValue(reconciliationSummary.missing);
  const mismatchedStorage = numberValue(reconciliationSummary.mismatched);
  const migratableStorage = numberValue(reconciliationSummary.migratable);
  const recoverableStorage = numberValue(reconciliationSummary.recoverable);
  const orphanStorage = numberValue(reconciliationSummary.orphanRemote);
  const staleStorageIndex = numberValue(reconciliationSummary.staleIndex);
  const uncheckedStorage = numberValue(reconciliationSummary.unchecked);
  const driveErrorCount = Object.values(driveErrors).filter(Boolean).length;
  const backend = koshObjectStorageBackend();

  let reconciliationStatus: ReadinessStatus = "pass";
  let reconciliationDetail = "Storage reconciliation is not required for the local object backend.";
  if (backend === "google-drive") {
    if (!reconciliation) {
      reconciliationStatus = "warn";
      reconciliationDetail = "No repository storage reconciliation evidence has been recorded yet.";
    } else if (missingStorage > 0 || mismatchedStorage > 0) {
      reconciliationStatus = "fail";
      reconciliationDetail = `${missingStorage} missing and ${mismatchedStorage} integrity-mismatched storage object(s) require attention.`;
    } else if (driveErrorCount > 0 || uncheckedStorage > 0) {
      reconciliationStatus = "fail";
      reconciliationDetail = "The latest reconciliation could not fully inspect the configured Drive backend.";
    } else if (
      migratableStorage > 0 ||
      recoverableStorage > 0 ||
      orphanStorage > 0 ||
      staleStorageIndex > 0 ||
      reconciliationAgeMs > 24 * 60 * 60 * 1000
    ) {
      reconciliationStatus = "warn";
      reconciliationDetail = `${migratableStorage} local, ${recoverableStorage} recoverable, ${orphanStorage} orphan Drive and ${staleStorageIndex} stale-index object(s) are recorded by the latest reconciliation.`;
    } else {
      reconciliationDetail = "The latest repository storage reconciliation is clean and current.";
    }
  }

  const checks: ReadinessCheck[] = [
    {
      id: "storage-capacity",
      status: ratioStatus(storageRatio),
      detail: `${Math.round(storageRatio * 100)}% of known repository quota is used.`
    },
    {
      id: "storage-reconciliation",
      status: reconciliationStatus,
      detail: reconciliationDetail
    },
    {
      id: "recovery-evidence",
      status: verifiedBackups.length > 0 ? "pass" : "warn",
      detail: verifiedBackups.length > 0
        ? `${verifiedBackups.length} verified restore point(s) are recorded.`
        : backups.length > 0
          ? "Restore points exist, but none currently carry successful verification evidence."
          : "No repository restore point is recorded."
    },
    {
      id: "recovery-integrity",
      status: invalidBackups.length > 0 ? "fail" : "pass",
      detail: invalidBackups.length > 0
        ? `${invalidBackups.length} restore point(s) are marked invalid.`
        : "No restore point is marked invalid."
    },
    {
      id: "automation-history",
      status: failedRuns.length > 0 ? "warn" : "pass",
      detail: failedRuns.length > 0
        ? `${failedRuns.length} failed Automation run(s) exist in recent history.`
        : "No failed Automation run exists in the inspected history."
    },
    {
      id: "deployment-history",
      status: failedDeployments.length > 0 ? "warn" : "pass",
      detail: failedDeployments.length > 0
        ? `${failedDeployments.length} failed deployment(s) exist in recent history.`
        : "No failed deployment exists in the inspected history."
    },
    {
      id: "merge-queue-processing",
      status: processingQueue.length > 1 ? "warn" : "pass",
      detail: processingQueue.length > 0
        ? `${processingQueue.length} merge-queue entr${processingQueue.length === 1 ? "y is" : "ies are"} processing.`
        : "No merge-queue entry is currently processing."
    },
    {
      id: "merge-queue-failures",
      status: failedQueue.length > 0 ? "warn" : "pass",
      detail: failedQueue.length > 0
        ? `${failedQueue.length} merge-queue entr${failedQueue.length === 1 ? "y has" : "ies have"} failed.`
        : "No merge-queue entry is marked failed."
    }
  ];

  return {
    ...summarize(checks),
    scope: "repository",
    checkedAt: new Date().toISOString(),
    checks,
    storage: {
      usage,
      limits,
      ratio: storageRatio,
      reconciliation: reconciliation
        ? {
            checkedAt: reconciliationCheckedAt || null,
            operation: reconciliationPayload.operation ?? null,
            summary: reconciliationSummary,
            driveErrors
          }
        : null
    },
    recovery: {
      restorePoints: backups.length,
      verifiedRestorePoints: verifiedBackups.length,
      invalidRestorePoints: invalidBackups.length,
      latestVerifiedAt:
        verifiedBackups
          .map((item) => String(item.payload.lastVerifiedAt ?? item.updatedAt))
          .sort()
          .at(-1) ?? null
    },
    activity: {
      recentAuditEvents: recentAudit.length,
      automationRuns: runs.length,
      runningAutomationRuns: runningRuns.length,
      failedAutomationRuns: failedRuns.length,
      deployments: deployments.length,
      runningDeployments: runningDeployments.length,
      failedDeployments: failedDeployments.length,
      mergeQueueEntries: queue.length,
      processingMergeQueueEntries: processingQueue.length,
      failedMergeQueueEntries: failedQueue.length
    }
  };
}

export async function handleKoshReadinessRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (request.method !== "GET") return false;

  if (url.pathname === "/v1/kosh/systems/readiness") {
    const identity = await resolveKoshIdentity(request, "repo:read");
    if (!identity) {
      sendJson(
        response,
        401,
        { error: "authentication_required" },
        origin,
        allowedOrigins
      );
      return true;
    }
    if (!platformAdministrator(identity)) {
      sendJson(
        response,
        403,
        { error: "platform_admin_required" },
        origin,
        allowedOrigins
      );
      return true;
    }
    sendJson(response, 200, await platformReadiness(), origin, allowedOrigins);
    return true;
  }

  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/readiness$/
  );
  if (!match) return false;

  const repository = await repositoryStore.get(match[1], match[2]);
  if (!repository) {
    sendJson(
      response,
      404,
      { error: "repository_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  }

  const authorization = await authorizeKoshRepositoryRequest(
    request,
    repository,
    "repository.read"
  );
  if (!authorization.identity || !authorization.decision.allowed) {
    sendJson(
      response,
      authorization.identity ? 403 : 401,
      {
        error: authorization.identity
          ? "repository_permission_denied"
          : "authentication_required"
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  sendJson(
    response,
    200,
    {
      repository: {
        id: repository.id,
        namespace: repository.namespace,
        slug: repository.slug,
        state: repository.state
      },
      ...(await repositoryReadiness(repository.id))
    },
    origin,
    allowedOrigins
  );
  return true;
}
