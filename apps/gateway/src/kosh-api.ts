import type { IncomingMessage, ServerResponse } from "node:http";
import {
  koshApiScopeCatalog,
  normalizeKoshApiScopes,
  resolveKoshIdentity,
  validateKoshApiTokenExpiry
} from "./kosh-auth.js";
import { listKoshRepositoriesVisibleTo } from "./kosh-access.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";

const platformStore = getKoshPlatformStore();
const API_VERSION = "1";
const CONTRACT_DATE = "2026-10-03";

type JsonBody = Record<string, unknown>;

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
  response.setHeader("x-kosh-api-version", API_VERSION);
  response.setHeader("x-kosh-api-contract", CONTRACT_DATE);
  if (origin && allowedOrigins?.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, limit = 64 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_json");
    }
    return parsed as JsonBody;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function requireAllowedOrigin(
  request: IncomingMessage,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (request.method !== "GET" && origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

function requireInteractiveSession(
  identity: NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>
) {
  if (identity.authType !== "session") {
    throw Object.assign(new Error("interactive_session_required"), { status: 403 });
  }
}

async function audit(
  actor: { id: string; displayName: string },
  eventType: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {}
) {
  await platformStore.appendAudit({
    repositoryId: null,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType: "api_token",
    resourceId,
    metadata
  });
}

function publicContract() {
  return {
    product: "Kosh",
    apiVersion: API_VERSION,
    contractDate: CONTRACT_DATE,
    authentication: {
      scheme: "Bearer",
      tokenPrefix: "kosh_pat_",
      tokenManagementRequiresInteractiveSession: true
    },
    scopes: koshApiScopeCatalog,
    endpoints: {
      discovery: "/v1/kosh/api",
      specification: "/v1/kosh/api/openapi.json",
      identity: "/v1/kosh/api/me",
      repositories: "/v1/kosh/api/repositories",
      tokens: "/v1/kosh/api/tokens"
    },
    compatibility: {
      repositoryApiRoot: "/v1/kosh/repos",
      cli: "kosh"
    }
  };
}

function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Kosh Public API",
      version: API_VERSION,
      description: "Stable public control-plane entrypoints for Kosh clients and automation."
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        koshToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "kosh_pat_..."
        }
      }
    },
    paths: {
      "/v1/kosh/api": {
        get: { summary: "Discover the Kosh public API" }
      },
      "/v1/kosh/api/me": {
        get: {
          summary: "Inspect the authenticated Kosh identity",
          security: [{ koshToken: [] }]
        }
      },
      "/v1/kosh/api/repositories": {
        get: {
          summary: "List repositories visible to the authenticated identity",
          security: [{ koshToken: [] }]
        }
      },
      "/v1/kosh/api/tokens": {
        get: { summary: "List personal API tokens (interactive session only)" },
        post: { summary: "Create a personal API token (interactive session only)" }
      },
      "/v1/kosh/api/tokens/{tokenId}": {
        delete: { summary: "Revoke a personal API token (interactive session only)" }
      },
      "/v1/kosh/api/tokens/{tokenId}/rotate": {
        post: { summary: "Rotate a personal API token (interactive session only)" }
      }
    }
  };
}

export async function handleKoshPublicApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/kosh/api")) return false;

  try {
    await platformStore.ready();
    requireAllowedOrigin(request, origin, allowedOrigins);

    if (url.pathname === "/v1/kosh/api" && request.method === "GET") {
      sendJson(response, 200, publicContract(), origin, allowedOrigins);
      return true;
    }

    if (
      url.pathname === "/v1/kosh/api/openapi.json" &&
      request.method === "GET"
    ) {
      sendJson(response, 200, openApiDocument(), origin, allowedOrigins);
      return true;
    }

    if (url.pathname === "/v1/kosh/api/me" && request.method === "GET") {
      const identity = await resolveKoshIdentity(request);
      if (!identity) {
        sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
        return true;
      }
      sendJson(
        response,
        200,
        {
          user: {
            id: identity.user.id,
            displayName: identity.user.displayName,
            email: identity.user.email
          },
          authType: identity.authType,
          token: identity.apiToken
            ? {
                id: identity.apiToken.id,
                name: identity.apiToken.name,
                prefix: identity.apiToken.tokenPrefix,
                scopes: identity.apiToken.scopes,
                expiresAt: identity.apiToken.expiresAt,
                lastUsedAt: identity.apiToken.lastUsedAt,
                createdAt: identity.apiToken.createdAt
              }
            : null
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      url.pathname === "/v1/kosh/api/repositories" &&
      request.method === "GET"
    ) {
      const identity = await resolveKoshIdentity(request, "repo:read");
      if (!identity) {
        sendJson(response, 401, { error: "authentication_or_scope_required", scope: "repo:read" }, origin, allowedOrigins);
        return true;
      }
      const visible = await listKoshRepositoriesVisibleTo(identity);
      sendJson(
        response,
        200,
        {
          repositories: visible.map(({ repository, access }) => ({
            ...repository,
            access: {
              role: access.role,
              source: access.source,
              legacy: access.legacy
            }
          }))
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (url.pathname === "/v1/kosh/api/tokens") {
      const identity = await resolveKoshIdentity(request);
      if (!identity) {
        sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
        return true;
      }
      requireInteractiveSession(identity);

      if (request.method === "GET") {
        sendJson(
          response,
          200,
          {
            tokens: await platformStore.listApiTokens(identity.user.id),
            scopes: koshApiScopeCatalog
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (request.method === "POST") {
        const body = await readJson(request);
        const name = clean(body.name, 120);
        if (!name) {
          throw Object.assign(new Error("token_name_required"), { status: 400 });
        }
        const scopes = normalizeKoshApiScopes(body.scopes);
        const expiresAt = validateKoshApiTokenExpiry(body.expiresAt);
        const created = await platformStore.createApiToken({
          userId: identity.user.id,
          name,
          scopes,
          expiresAt
        });
        await audit(identity.user, "api_token_created", created.record.id, {
          scopes,
          expiresAt
        });
        sendJson(
          response,
          201,
          {
            token: created.token,
            record: created.record,
            warning: "This token value is shown only in this response. Store it securely."
          },
          origin,
          allowedOrigins
        );
        return true;
      }
    }

    const tokenRoute = url.pathname.match(
      /^\/v1\/kosh\/api\/tokens\/([a-f0-9-]{36})(?:\/(rotate))?$/i
    );
    if (tokenRoute) {
      const identity = await resolveKoshIdentity(request);
      if (!identity) {
        sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
        return true;
      }
      requireInteractiveSession(identity);
      const tokenId = tokenRoute[1];
      const action = tokenRoute[2] || "";
      const existing = (await platformStore.listApiTokens(identity.user.id)).find(
        (item) => item.id === tokenId
      );
      if (!existing) {
        throw Object.assign(new Error("api_token_not_found"), { status: 404 });
      }

      if (!action && request.method === "DELETE") {
        const deleted = await platformStore.deleteApiToken(identity.user.id, tokenId);
        if (!deleted) {
          throw Object.assign(new Error("api_token_not_found"), { status: 404 });
        }
        await audit(identity.user, "api_token_revoked", tokenId, {
          prefix: existing.tokenPrefix
        });
        sendJson(response, 200, { revoked: true }, origin, allowedOrigins);
        return true;
      }

      if (action === "rotate" && request.method === "POST") {
        const body = await readJson(request);
        const scopes = body.scopes === undefined
          ? normalizeKoshApiScopes(existing.scopes)
          : normalizeKoshApiScopes(body.scopes);
        const expiresAt = body.expiresAt === undefined
          ? validateKoshApiTokenExpiry(
              existing.expiresAt && new Date(existing.expiresAt).getTime() > Date.now() + 60_000
                ? existing.expiresAt
                : undefined
            )
          : validateKoshApiTokenExpiry(body.expiresAt);
        const replacement = await platformStore.createApiToken({
          userId: identity.user.id,
          name: clean(body.name, 120) || existing.name,
          scopes,
          expiresAt
        });
        const deleted = await platformStore.deleteApiToken(identity.user.id, tokenId);
        if (!deleted) {
          await platformStore.deleteApiToken(identity.user.id, replacement.record.id);
          throw Object.assign(new Error("api_token_rotation_conflict"), { status: 409 });
        }
        await audit(identity.user, "api_token_rotated", replacement.record.id, {
          previousTokenId: tokenId,
          scopes,
          expiresAt
        });
        sendJson(
          response,
          201,
          {
            token: replacement.token,
            record: replacement.record,
            rotatedFrom: tokenId,
            warning: "This replacement token value is shown only in this response."
          },
          origin,
          allowedOrigins
        );
        return true;
      }
    }

    sendJson(response, 404, { error: "kosh_public_api_route_not_found" }, origin, allowedOrigins);
    return true;
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status) || 500
        : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "kosh_public_api_error" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
