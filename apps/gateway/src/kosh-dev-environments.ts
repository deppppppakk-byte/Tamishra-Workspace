import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshDevEnvironmentStore } from "./kosh-dev-environment-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshRunnerControlStore } from "./kosh-runner-control-store.js";
import { getKoshStore } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const store = getKoshStore();
const envStore = getKoshDevEnvironmentStore();
const platformStore = getKoshPlatformStore();
const runnerControlStore = getKoshRunnerControlStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");

type JsonBody = Record<string, unknown>;

class EnvironmentError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

function sendJson(response: ServerResponse, status: number, body: unknown, origin?: string, allowedOrigins?: ReadonlySet<string>) {
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

async function readJson(request: IncomingMessage, limit = 512 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > limit) throw new EnvironmentError("payload_too_large", 413);
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonBody : {};
  } catch {
    throw new EnvironmentError("invalid_json", 400);
  }
}

function runnerAuthorized(request: IncomingMessage) {
  const expected = process.env.KOSH_RUNNER_TOKEN?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  const authorization = request.headers.authorization?.trim() ?? "";
  const actual = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function clean(value: unknown, max = 200) { return String(value ?? "").trim().slice(0, max); }
function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function validRef(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/.test(value) && !value.includes("..") && !value.includes("@{") && !value.includes("//");
}
function repositoryPath(namespace: string, slug: string) { return resolve(repositoryRoot, namespace, slug + ".git"); }

async function resolveCommit(namespace: string, slug: string, refName: string) {
  try {
    const result = await execFileAsync("git", ["--git-dir", repositoryPath(namespace, slug), "rev-parse", "--verify", "refs/heads/" + refName + "^{commit}"], {
      timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8"
    });
    const sha = String(result.stdout).trim();
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error("invalid_sha");
    return sha;
  } catch {
    throw new EnvironmentError("environment_ref_not_found", 404);
  }
}

async function audit(repositoryId: string, actorUserId: string | null, actorName: string, eventType: string, resourceId: string, metadata: Record<string, unknown> = {}) {
  await platformStore.appendAudit({ repositoryId, actorUserId, actorName, eventType, resourceType: "dev_environment", resourceId, metadata });
}

function publicView(value: Awaited<ReturnType<typeof envStore.get>>) {
  if (!value) return null;
  const { leaseHash, ...safe } = value;
  return safe;
}

export async function handleKoshDevEnvironmentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const runnerRoute = url.pathname.match(/^\/v1\/kosh\/dev-environments\/runner\/(claim|heartbeat|complete)$/);
  if (runnerRoute) {
    if (!runnerAuthorized(request)) {
      sendJson(response, 401, { error: "runner_authentication_required" }, origin, allowedOrigins);
      return true;
    }
    try {
      const body = await readJson(request);
      const runnerId = clean(body.runnerId, 160);
      if (!runnerId) throw new EnvironmentError("runner_id_required");

      if (runnerRoute[1] === "claim" && request.method === "POST") {
        const claimed = await envStore.claim(runnerId, 60);
        if (!claimed) {
          sendJson(response, 200, { environment: null }, origin, allowedOrigins);
          return true;
        }
        const repository = await store.get(claimed.environment.namespace, claimed.environment.repositorySlug);
        if (!repository) {
          await envStore.complete(claimed.environment.id, runnerId, claimed.leaseToken, "failed", "repository_not_found");
          sendJson(response, 200, { environment: null }, origin, allowedOrigins);
          return true;
        }
        const checkoutCredential = await runnerControlStore.issueCredential({
          jobId: claimed.environment.id,
          repositoryId: claimed.environment.repositoryId,
          scope: "repository.read",
          ttlSeconds: 1800
        });
        sendJson(response, 200, {
          environment: publicView(claimed.environment),
          lease: { token: claimed.leaseToken, expiresAt: claimed.environment.leaseExpiresAt },
          checkoutCredential,
          repository: { namespace: repository.namespace, slug: repository.slug, cloneHttpUrl: repository.cloneHttpUrl }
        }, origin, allowedOrigins);
        return true;
      }

      const environmentId = clean(body.environmentId, 100);
      const leaseToken = clean(body.leaseToken, 200);
      if (!environmentId || !leaseToken) throw new EnvironmentError("environment_lease_required");

      if (runnerRoute[1] === "heartbeat" && request.method === "POST") {
        const current = await envStore.get(environmentId);
        const stopRequested = current?.state === "stopping" || (current ? new Date(current.expiresAt).getTime() <= Date.now() : false);
        const updated = await envStore.heartbeat(environmentId, runnerId, leaseToken, clean(body.containerId, 200) || null);
        if (!updated) throw new EnvironmentError("environment_lease_invalid", 409);
        sendJson(response, 200, { environment: publicView(updated), stopRequested }, origin, allowedOrigins);
        return true;
      }

      if (runnerRoute[1] === "complete" && request.method === "POST") {
        const state = clean(body.state, 20);
        if (!["stopped","failed","expired"].includes(state)) throw new EnvironmentError("invalid_environment_completion_state");
        const updated = await envStore.complete(environmentId, runnerId, leaseToken, state as "stopped"|"failed"|"expired", clean(body.failureReason, 1000) || null);
        if (!updated) throw new EnvironmentError("environment_lease_invalid", 409);
        await runnerControlStore.revokeJobCredentials(environmentId);
        await audit(updated.repositoryId, null, "Kosh Runner " + runnerId, "dev_environment_" + state, updated.id, { runnerId });
        sendJson(response, 200, { environment: publicView(updated) }, origin, allowedOrigins);
        return true;
      }
    } catch (error) {
      const status = error instanceof EnvironmentError ? error.status : 500;
      sendJson(response, status, { error: error instanceof Error ? error.message : "environment_runner_request_failed" }, origin, allowedOrigins);
      return true;
    }
    return false;
  }

  const route = url.pathname.match(/^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/environments(?:\/([a-f0-9-]{36}))?(?:\/(stop))?$/i);
  if (!route) return false;

  try {
    const namespace = route[1];
    const slug = route[2];
    const repository = await store.get(namespace, slug);
    if (!repository) throw new EnvironmentError("repository_not_found", 404);

    const permission = request.method === "GET" ? "repository.read" : "repository.write";
    const authorization = await authorizeKoshRepositoryRequest(request, repository, permission);
    if (!authorization.decision.allowed || !authorization.identity) {
      sendJson(response, authorization.identity ? 403 : 401, { error: authorization.identity ? "repository_permission_denied" : "authentication_required" }, origin, allowedOrigins);
      return true;
    }
    if (request.method !== "GET" && origin && !allowedOrigins.has(origin)) throw new EnvironmentError("origin_not_allowed", 403);

    if (request.method === "GET" && !route[3]) {
      const environments = await envStore.list(repository.id);
      sendJson(response, 200, {
        environments: environments.map(publicView),
        limits: {
          maxTtlMinutes: clamp(process.env.KOSH_DEV_ENV_MAX_TTL_MINUTES, 480, 30, 1440),
          maxCpu: clamp(process.env.KOSH_RUNNER_MAX_CPU, 4, 0.1, 32),
          maxMemoryMb: clamp(process.env.KOSH_RUNNER_MAX_MEMORY_MB, 4096, 128, 65536),
          networkEgressEnabled: process.env.KOSH_RUNNER_ALLOW_NETWORK?.trim().toLowerCase() === "true"
        }
      }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && !route[3]) {
      const body = await readJson(request);
      const refName = clean(body.refName || repository.defaultBranch, 200);
      if (!validRef(refName)) throw new EnvironmentError("invalid_environment_ref");
      const commitSha = await resolveCommit(namespace, slug, refName);
      const name = clean(body.name, 100) || "Development environment";
      const image = clean(body.image, 200) || "node:22-bookworm-slim";
      const command = clean(body.command, 4000) || "while true; do sleep 3600; done";
      const network = clean(body.network, 20) === "egress" ? "egress" as const : "none" as const;
      if (network === "egress" && process.env.KOSH_RUNNER_ALLOW_NETWORK?.trim().toLowerCase() !== "true") {
        throw new EnvironmentError("environment_network_not_allowed", 403);
      }
      const maxTtl = clamp(process.env.KOSH_DEV_ENV_MAX_TTL_MINUTES, 480, 30, 1440);
      const ttlMinutes = Math.floor(clamp(body.ttlMinutes, 120, 15, maxTtl));
      const idleMinutes = Math.floor(clamp(body.idleMinutes, 30, 5, ttlMinutes));
      const cpu = clamp(body.cpu, 1, 0.1, clamp(process.env.KOSH_RUNNER_MAX_CPU, 4, 0.1, 32));
      const memoryMb = Math.floor(clamp(body.memoryMb, 1024, 128, clamp(process.env.KOSH_RUNNER_MAX_MEMORY_MB, 4096, 128, 65536)));
      const pidsLimit = Math.floor(clamp(body.pidsLimit, 256, 32, clamp(process.env.KOSH_RUNNER_MAX_PIDS, 512, 32, 8192)));

      const created = await envStore.create({
        repositoryId: repository.id, namespace, repositorySlug: slug, name, refName, commitSha,
        image, network, cpu, memoryMb, pidsLimit, ttlMinutes, idleMinutes, command,
        expiresAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
        createdByUserId: authorization.identity.user.id,
        createdByName: authorization.identity.user.displayName
      });
      await audit(repository.id, authorization.identity.user.id, authorization.identity.user.displayName, "dev_environment_created", created.id, { refName, commitSha, image, network, cpu, memoryMb, ttlMinutes });
      sendJson(response, 201, { environment: publicView(created) }, origin, allowedOrigins);
      return true;
    }

    const environmentId = route[3];
    if (!environmentId) return false;
    const environment = await envStore.get(environmentId);
    if (!environment || environment.repositoryId !== repository.id) throw new EnvironmentError("environment_not_found", 404);

    if (request.method === "GET" && !route[4]) {
      sendJson(response, 200, { environment: publicView(environment) }, origin, allowedOrigins);
      return true;
    }
    if (request.method === "POST" && route[4] === "stop") {
      const updated = await envStore.requestStop(environment.id);
      if (!updated) throw new EnvironmentError("environment_not_found", 404);
      await audit(repository.id, authorization.identity.user.id, authorization.identity.user.displayName, "dev_environment_stop_requested", environment.id);
      sendJson(response, 200, { environment: publicView(updated) }, origin, allowedOrigins);
      return true;
    }
  } catch (error) {
    const status = error instanceof EnvironmentError ? error.status : Number((error as {status?: number})?.status ?? 500);
    sendJson(response, status, { error: error instanceof Error ? error.message : "development_environment_request_failed" }, origin, allowedOrigins);
    return true;
  }
  return false;
}
