import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  getKoshOpsWorkerFleetSummary,
  listKoshOpsWorkers,
  readyKoshOpsWorkerRegistry,
  koshOpsWorkerStaleMs,
  removeStaleKoshOpsWorker,
  setKoshOpsWorkerControl,
  type KoshOpsWorkerRequestedState
} from "./kosh-ops-worker-registry.js";
import { getKoshStore } from "./kosh-store.js";

const repositories = getKoshStore();
const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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
    : process.env.NODE_ENV !== "production" && identity.memberships.some((item) => ["owner", "admin"].includes(item.membership.role));
}

function json(response: ServerResponse, status: number, body: unknown, origin: string | undefined, allowedOrigins: ReadonlySet<string>) {
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

async function readJson(request: IncomingMessage, maxBytes = 64 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(value);
  }
  if (!chunks.length) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_json");
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function requireOrigin(request: IncomingMessage, origin: string | undefined, allowedOrigins: ReadonlySet<string>) {
  if (mutationMethods.has(request.method ?? "") && origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeRequestedState(value: unknown): KoshOpsWorkerRequestedState {
  if (value === "active" || value === "draining" || value === "disabled") return value;
  throw Object.assign(new Error("invalid_worker_requested_state"), { status: 400 });
}

export async function handleKoshOpsFleetRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const platform = url.pathname === "/v1/kosh/systems/workers";
  const control = url.pathname === "/v1/kosh/systems/workers/control";
  const prune = url.pathname === "/v1/kosh/systems/workers/prune";
  const repositoryMatch = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/workers$/
  );
  if (!platform && !control && !prune && !repositoryMatch) return false;

  requireOrigin(request, origin, allowedOrigins);
  await readyKoshOpsWorkerRegistry();

  if (platform || control || prune) {
    const identity = await resolveKoshIdentity(request);
    if (!identity || !platformAdministrator(identity)) {
      json(response, identity ? 403 : 401, {
        error: identity ? "platform_admin_required" : "authentication_required"
      }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "GET" && platform) {
      const [summary, workers] = await Promise.all([
        getKoshOpsWorkerFleetSummary(),
        listKoshOpsWorkers(500)
      ]);
      json(response, 200, {
        scope: "platform",
        staleAfterMs: koshOpsWorkerStaleMs(),
        summary,
        workers
      }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && control) {
      const body = await readJson(request);
      const workerId = clean(body.workerId, 200);
      if (!workerId) {
        json(response, 400, { error: "worker_id_required" }, origin, allowedOrigins);
        return true;
      }
      const desiredConcurrency = body.desiredConcurrency == null || body.desiredConcurrency === ""
        ? null
        : Math.max(1, Math.min(64, Math.floor(Number(body.desiredConcurrency) || 1)));
      const worker = await setKoshOpsWorkerControl(workerId, {
        requestedState: normalizeRequestedState(body.requestedState),
        desiredConcurrency,
        reason: clean(body.reason, 500) || null,
        updatedBy: identity.user.id
      });
      if (!worker) {
        json(response, 404, { error: "worker_not_found" }, origin, allowedOrigins);
        return true;
      }
      json(response, 200, { worker, summary: await getKoshOpsWorkerFleetSummary() }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && prune) {
      const body = await readJson(request);
      const workerId = clean(body.workerId, 200);
      if (!workerId) {
        json(response, 400, { error: "worker_id_required" }, origin, allowedOrigins);
        return true;
      }
      const removed = await removeStaleKoshOpsWorker(workerId);
      json(response, removed ? 200 : 409, {
        removed,
        ...(removed ? {} : { error: "worker_not_stale_or_still_active" })
      }, origin, allowedOrigins);
      return true;
    }

    json(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  if (request.method !== "GET") {
    json(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
    return true;
  }
  const repository = await repositories.get(repositoryMatch![1], repositoryMatch![2]);
  if (!repository) {
    json(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
    return true;
  }
  const authorization = await authorizeKoshRepositoryRequest(request, repository, "repository.read");
  if (!authorization.identity || !authorization.decision.allowed) {
    json(response, authorization.identity ? 403 : 401, {
      error: authorization.identity ? "repository_permission_denied" : "authentication_required",
      permission: "repository.read"
    }, origin, allowedOrigins);
    return true;
  }
  json(response, 200, {
    scope: "repository",
    repository: { id: repository.id, namespace: repository.namespace, slug: repository.slug },
    staleAfterMs: koshOpsWorkerStaleMs(),
    summary: await getKoshOpsWorkerFleetSummary()
  }, origin, allowedOrigins);
  return true;
}
