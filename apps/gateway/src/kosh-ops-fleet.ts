import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  getKoshOpsWorkerFleetSummary,
  listKoshOpsWorkers,
  readyKoshOpsWorkerRegistry,
  koshOpsWorkerStaleMs
} from "./kosh-ops-worker-registry.js";
import { getKoshStore } from "./kosh-store.js";

const repositories = getKoshStore();

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

function json(
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

export async function handleKoshOpsFleetRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (request.method !== "GET") return false;
  const platform = url.pathname === "/v1/kosh/systems/workers";
  const repositoryMatch = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/workers$/
  );
  if (!platform && !repositoryMatch) return false;

  await readyKoshOpsWorkerRegistry();
  const summary = await getKoshOpsWorkerFleetSummary();

  if (platform) {
    const identity = await resolveKoshIdentity(request);
    if (!identity || !platformAdministrator(identity)) {
      json(response, identity ? 403 : 401, {
        error: identity ? "platform_admin_required" : "authentication_required"
      }, origin, allowedOrigins);
      return true;
    }
    const workers = await listKoshOpsWorkers(500);
    json(response, 200, {
      scope: "platform",
      staleAfterMs: koshOpsWorkerStaleMs(),
      summary,
      workers
    }, origin, allowedOrigins);
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
    repository: {
      id: repository.id,
      namespace: repository.namespace,
      slug: repository.slug
    },
    staleAfterMs: koshOpsWorkerStaleMs(),
    summary
  }, origin, allowedOrigins);
  return true;
}
