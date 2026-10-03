import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { automationStore } from "./kosh-automation-service.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { koshKnownStorageUsage, koshStorageLimits } from "./kosh-storage-policy.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const automation = automationStore();

type Check = {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

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

function configured(name: string, minimum = 1) {
  const value = process.env[name]?.trim() ?? "";
  return value.length >= minimum && !/^change-me/i.test(value);
}

function platformAdministrator(userId: string, memberships: Array<{ membership: { role: string; disabled?: boolean } }>) {
  const configuredIds = new Set(
    (process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (configuredIds.size) return configuredIds.has(userId);
  return process.env.NODE_ENV !== "production" && memberships.some(
    (item) =>
      !item.membership.disabled &&
      (item.membership.role === "owner" || item.membership.role === "admin")
  );
}

function summary(checks: Check[]) {
  const fail = checks.filter((item) => item.status === "fail").length;
  const warn = checks.filter((item) => item.status === "warn").length;
  return {
    status: fail ? "not_ready" : warn ? "degraded" : "ready",
    passing: checks.length - fail - warn,
    warnings: warn,
    failures: fail
  };
}

async function globalReadiness() {
  await Promise.all([platformStore.ready(), automation.ready()]);
  const production = process.env.NODE_ENV === "production";
  const checks: Check[] = [
    {
      id: "persistence",
      status: configured("WORKSPACE_DATABASE_URL", 12) ? "pass" : production ? "fail" : "warn",
      detail: configured("WORKSPACE_DATABASE_URL", 12) ? "PostgreSQL persistence configured" : "Ephemeral persistence"
    },
    {
      id: "master-key",
      status: configured("KOSH_MASTER_KEY", 32) ? "pass" : production ? "fail" : "warn",
      detail: configured("KOSH_MASTER_KEY", 32) ? "Kosh secret encryption key configured" : "Strong KOSH_MASTER_KEY not configured"
    },
    {
      id: "platform-admins",
      status: configured("KOSH_PLATFORM_ADMIN_USER_IDS") ? "pass" : production ? "fail" : "warn",
      detail: configured("KOSH_PLATFORM_ADMIN_USER_IDS") ? "Explicit platform administrators configured" : "No explicit production platform administrator list"
    },
    {
      id: "runner-auth",
      status: configured("KOSH_RUNNER_TOKEN", 24) ? "pass" : production ? "fail" : "warn",
      detail: configured("KOSH_RUNNER_TOKEN", 24) ? "Runner authentication configured" : "Runner token not production-ready"
    },
    {
      id: "repository-root",
      status: configured("KOSH_REPO_ROOT", 2) ? "pass" : production ? "warn" : "pass",
      detail: configured("KOSH_REPO_ROOT", 2) ? "Explicit repository root configured" : "Using default repository root"
    },
    {
      id: "backup-root",
      status: configured("KOSH_BACKUP_ROOT", 2) ? "pass" : production ? "warn" : "pass",
      detail: configured("KOSH_BACKUP_ROOT", 2) ? "Explicit recovery storage configured" : "Using default recovery root"
    },
    {
      id: "legacy-access",
      status: (process.env.KOSH_ACCESS_LEGACY_MODE ?? "deny") === "deny" ? "pass" : "warn",
      detail: "Legacy repository ACL mode: " + (process.env.KOSH_ACCESS_LEGACY_MODE ?? "deny")
    },
    {
      id: "webhook-network",
      status: (process.env.KOSH_WEBHOOK_BLOCK_PRIVATE_NETWORKS ?? "true") !== "false" ? "pass" : "warn",
      detail: (process.env.KOSH_WEBHOOK_BLOCK_PRIVATE_NETWORKS ?? "true") !== "false"
        ? "Private-network webhook targets blocked"
        : "Private-network webhook targets permitted"
    },
    {
      id: "runner-network",
      status: (process.env.KOSH_RUNNER_ALLOW_NETWORK ?? "false") === "false" ? "pass" : "warn",
      detail: (process.env.KOSH_RUNNER_ALLOW_NETWORK ?? "false") === "false"
        ? "Runner outbound network denied by default"
        : "Runner outbound network can be requested"
    }
  ];

  const repositories = await repositoryStore.list();
  const resources = await Promise.all(
    ["backup", "deployment_policy", "extension", "storage_policy", "merge_queue_entry"].map(async (type) => [
      type,
      (await platformStore.listResources(type as never, null)).length
    ] as const)
  );

  return {
    ...summary(checks),
    production,
    checks,
    counts: {
      repositories: repositories.length,
      globalResources: Object.fromEntries(resources)
    }
  };
}

async function repositoryReadiness(repositoryId: string) {
  await Promise.all([platformStore.ready(), automation.ready()]);
  const [usage, limits, backups, queue, runs, deployments] = await Promise.all([
    koshKnownStorageUsage(repositoryId),
    koshStorageLimits(repositoryId),
    platformStore.listResources("backup", repositoryId),
    platformStore.listResources("merge_queue_entry", repositoryId),
    automation.listRuns(repositoryId, 200),
    automation.listDeployments(repositoryId, 200)
  ]);

  const usageRatio = limits.maxTotalBytes > 0 ? usage.knownBytes / limits.maxTotalBytes : 1;
  const verifiedBackups = backups.filter(
    (item) => item.state !== "invalid" && item.payload.verificationValid === true
  );
  const failedRuns = runs.filter((item) => item.status === "failure").length;
  const failedDeployments = deployments.filter((item) => item.status === "failure").length;
  const processingQueue = queue.filter((item) => item.state === "processing").length;

  const checks: Check[] = [
    {
      id: "storage",
      status: usageRatio >= 1 ? "fail" : usageRatio >= 0.85 ? "warn" : "pass",
      detail: `${Math.round(usageRatio * 100)}% of known repository quota used`
    },
    {
      id: "recovery",
      status: verifiedBackups.length ? "pass" : backups.length ? "warn" : "warn",
      detail: verifiedBackups.length
        ? `${verifiedBackups.length} verified restore point(s)`
        : backups.length
          ? "Restore points exist but none are verified"
          : "No repository restore point recorded"
    },
    {
      id: "automation",
      status: failedRuns ? "warn" : "pass",
      detail: failedRuns ? `${failedRuns} failed run(s) in recent history` : "No failed recent Automation runs"
    },
    {
      id: "deployments",
      status: failedDeployments ? "warn" : "pass",
      detail: failedDeployments ? `${failedDeployments} failed deployment(s) in recent history` : "No failed recent deployments"
    },
    {
      id: "merge-queue",
      status: processingQueue > 1 ? "warn" : "pass",
      detail: processingQueue ? `${processingQueue} queue entr${processingQueue === 1 ? "y" : "ies"} processing` : "No merge queue entry currently processing"
    }
  ];

  return {
    ...summary(checks),
    checks,
    storage: { usage, limits, ratio: usageRatio },
    recovery: {
      restorePoints: backups.length,
      verifiedRestorePoints: verifiedBackups.length,
      latestVerifiedAt: verifiedBackups
        .map((item) => String(item.payload.lastVerifiedAt ?? item.updatedAt))
        .sort()
        .at(-1) ?? null
    },
    recent: {
      failedRuns,
      failedDeployments,
      queueEntries: queue.length
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
      sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
      return true;
    }
    if (!platformAdministrator(identity.user.id, identity.memberships)) {
      sendJson(response, 403, { error: "platform_admin_required" }, origin, allowedOrigins);
      return true;
    }
    sendJson(response, 200, await globalReadiness(), origin, allowedOrigins);
    return true;
  }

  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/readiness$/
  );
  if (!match) return false;

  const repository = await repositoryStore.get(match[1], match[2]);
  if (!repository) {
    sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
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
      { error: authorization.identity ? "repository_permission_denied" : "authentication_required" },
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
