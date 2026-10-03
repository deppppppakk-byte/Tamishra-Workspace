import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();

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

export async function handleKoshAdministrationGate(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/(?:webhooks|platform)(?:\/|$)/
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
    "repository.manage"
  );

  if (!authorization.decision.allowed || !authorization.identity) {
    sendJson(
      response,
      authorization.identity ? 403 : 401,
      {
        error: authorization.identity
          ? "repository_permission_denied"
          : "authentication_required",
        permission: "repository.manage",
        role: authorization.decision.role
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  return false;
}
