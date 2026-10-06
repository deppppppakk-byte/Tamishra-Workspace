import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { automationStore } from "./kosh-automation-service.js";
import { getKoshRunnerControlStore, type StoredKoshRunnerNode } from "./kosh-runner-control-store.js";

const runnerStore = getKoshRunnerControlStore();
const automation = automationStore();

type BuildPoolKind = "windows" | "android";

type Identity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function json(response: ServerResponse, status: number, body: unknown, origin: string | undefined, allowed: ReadonlySet<string>) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowed.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

function platformAdmin(identity: Identity) {
  const configured = new Set((process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  if (configured.size) return configured.has(identity.user.id);
  return identity.memberships.some((item) => !item.membership.disabled && ["owner", "admin"].includes(item.membership.role));
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function runnerAuthorized(request: IncomingMessage) {
  const expected = process.env.KOSH_RUNNER_TOKEN?.trim() ?? "";
  if (!expected) return process.env.NODE_ENV !== "production";
  const header = String(request.headers.authorization ?? "").trim();
  const actual = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return safeEqual(actual, expected);
}

function desired(kind: BuildPoolKind) {
  const raw = kind === "windows" ? process.env.KOSH_MANAGED_WINDOWS_BUILD_MIN : process.env.KOSH_MANAGED_ANDROID_BUILD_MIN;
  const value = Number(raw ?? 1);
  return Math.max(1, Math.min(100, Number.isFinite(value) ? Math.floor(value) : 1));
}

function requiredVersion() {
  return process.env.KOSH_RUNNER_REQUIRED_VERSION?.trim() || "0.3.0";
}

function belongs(runner: StoredKoshRunnerNode, kind: BuildPoolKind) {
  const label = kind === "windows" ? "windows-build" : "android-build";
  return runner.labels.includes(label);
}

function poolSummary(runners: StoredKoshRunnerNode[], kind: BuildPoolKind) {
  const scoped = runners.filter((runner) => belongs(runner, kind));
  const online = scoped.filter((runner) => runner.status === "online");
  const version = requiredVersion();
  const current = online.filter((runner) => runner.version === version);
  const outdated = online.filter((runner) => runner.version !== version);
  const freeSlots = current.reduce((sum, runner) => sum + Math.max(0, runner.capacity - runner.activeJobs), 0);
  const desiredWorkers = desired(kind);
  return {
    kind,
    desiredWorkers,
    registeredWorkers: scoped.length,
    onlineWorkers: online.length,
    currentWorkers: current.length,
    outdatedWorkers: outdated.map((runner) => ({ id: runner.id, version: runner.version })),
    freeSlots,
    requiredVersion: version,
    ready: current.length >= desiredWorkers,
    provision: Math.max(0, desiredWorkers - current.length),
    replace: outdated.length
  };
}

export async function getKoshManagedBuildPoolStatus() {
  await runnerStore.ready();
  const runners = await runnerStore.listRunners();
  const windows = poolSummary(runners, "windows");
  const android = poolSummary(runners, "android");
  return {
    checkedAt: new Date().toISOString(),
    managed: true,
    requiredVersion: requiredVersion(),
    windows,
    android,
    ready: windows.ready && android.ready,
    actionsRequired: windows.provision + windows.replace + android.provision + android.replace
  };
}

export async function handleKoshManagedBuildPoolRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/kosh/systems/build-pool")) return false;

  if (url.pathname === "/v1/kosh/systems/build-pool/runner-control") {
    if (request.method !== "GET") return false;
    if (!runnerAuthorized(request)) {
      json(response, 401, { error: "runner_authentication_required" }, origin, allowedOrigins);
      return true;
    }
    const version = url.searchParams.get("version")?.trim() || "";
    const desiredVersion = requiredVersion();
    json(response, 200, {
      desiredVersion,
      action: version && version !== desiredVersion ? "drain" : "continue",
      reason: version && version !== desiredVersion ? "runner_update_required" : "current"
    }, origin, allowedOrigins);
    return true;
  }

  const identity = await resolveKoshIdentity(request);
  if (!identity) {
    json(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/kosh/systems/build-pool") {
    json(response, 200, await getKoshManagedBuildPoolStatus(), origin, allowedOrigins);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/kosh/systems/build-pool/reconcile") {
    if (!platformAdmin(identity)) {
      json(response, 403, { error: "platform_admin_required" }, origin, allowedOrigins);
      return true;
    }
    if (origin && !allowedOrigins.has(origin)) {
      json(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
      return true;
    }
    const requeued = await automation.requeueExpiredJobs();
    json(response, 202, {
      status: await getKoshManagedBuildPoolStatus(),
      recoveredJobs: requeued.map((job) => job.id),
      note: "Queued builds are preserved until current managed capacity is available. Outdated workers are drained before receiving new work."
    }, origin, allowedOrigins);
    return true;
  }

  return false;
}
