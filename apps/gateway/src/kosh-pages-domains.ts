import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { enqueueKoshOpsJob } from "./kosh-ops-store.js";
import {
  claimKoshPagesDomain,
  releaseKoshPagesDomain
} from "./kosh-pages-domain-claims.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const repositories = getKoshStore();
const platformStore = getKoshPlatformStore();

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function hostname(value: unknown) {
  const result = clean(value, 253).toLowerCase().replace(/\.$/, "");
  if (!result || !/^[a-z0-9.-]+$/.test(result) || result.includes("..") || !result.includes(".")) {
    throw Object.assign(new Error("invalid_custom_domain"), { status: 400 });
  }
  return result;
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

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 128 * 1024) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(bytes);
  }
  if (!chunks.length) return {} as Record<string, unknown>;
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function requireOrigin(request: IncomingMessage, origin: string | undefined, allowedOrigins: ReadonlySet<string>) {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") && origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

export async function handleKoshPagesDomainRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/pages\/domains(?:\/([^/]+))?(?:\/(verify|archive))?$/
  );
  if (!match) return false;

  try {
    requireOrigin(request, origin, allowedOrigins);
    const repository = await repositories.get(match[1], match[2]);
    if (!repository) {
      sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
      return true;
    }
    const permission = request.method === "GET" ? "repository.read" as const : "repository.manage" as const;
    const auth = await authorizeKoshRepositoryRequest(request, repository, permission);
    if (!auth.identity || !auth.decision.allowed) {
      sendJson(response, auth.identity ? 403 : 401, {
        error: auth.identity ? "repository_permission_denied" : "authentication_required",
        permission
      }, origin, allowedOrigins);
      return true;
    }
    await platformStore.ready();
    const domains = (await platformStore.listResources("page_site", repository.id))
      .filter((item) => item.payload.kind === "domain");

    if (request.method === "GET" && !match[3]) {
      sendJson(response, 200, {
        domains: domains.map((item) => ({
          id: item.id,
          hostname: item.payload.hostname,
          state: item.state,
          verified: item.payload.verified === true,
          verifiedAt: item.payload.verifiedAt ?? null,
          tlsState: item.payload.tlsState ?? "unverified",
          dns: item.payload.hostname && item.payload.verificationToken
            ? {
                type: "TXT",
                name: `_kosh.${item.payload.hostname}`,
                value: `kosh-domain=${item.payload.verificationToken}`
              }
            : null
        }))
      }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && !match[3]) {
      const body = await readJson(request);
      const host = hostname(body.hostname);
      const key = `domain:${host}`;
      const existing = domains.find((item) => item.key === key);
      if (existing && existing.state !== "archived") {
        sendJson(response, 409, { error: "custom_domain_exists" }, origin, allowedOrigins);
        return true;
      }

      const claim = await claimKoshPagesDomain(host, repository.id);
      try {
        const verificationToken = randomBytes(24).toString("base64url");
        const payload = {
          kind: "domain",
          hostname: host,
          verificationToken,
          verified: false,
          verifiedAt: null,
          tlsState: "unverified",
          createdAt: new Date().toISOString()
        };
        const resource = existing
          ? await platformStore.updateResource(existing.id, { state: "pending", name: host, payload })
          : await platformStore.createResource({
              repositoryId: repository.id,
              namespace: repository.namespace,
              type: "page_site",
              key,
              name: host,
              state: "pending",
              payload,
              createdByUserId: auth.identity.user.id,
              createdByName: auth.identity.user.displayName
            });
        await platformStore.appendAudit({
          repositoryId: repository.id,
          actorUserId: auth.identity.user.id,
          actorName: auth.identity.user.displayName,
          eventType: "pages_custom_domain_created",
          resourceType: "page_site",
          resourceId: resource?.id ?? existing?.id ?? null,
          metadata: { hostname: host, globalClaim: true }
        });
        sendJson(response, 201, {
          domain: resource,
          dns: { type: "TXT", name: `_kosh.${host}`, value: `kosh-domain=${verificationToken}` }
        }, origin, allowedOrigins);
        return true;
      } catch (error) {
        if (claim.created) {
          await releaseKoshPagesDomain(host, repository.id).catch(() => undefined);
        }
        throw error;
      }
    }

    if (!match[3]) {
      sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
      return true;
    }
    const host = hostname(decodeURIComponent(match[3]));
    const resource = domains.find((item) => item.key === `domain:${host}`);
    if (!resource) {
      sendJson(response, 404, { error: "custom_domain_not_found" }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && match[4] === "verify") {
      await claimKoshPagesDomain(host, repository.id);
      const job = await enqueueKoshOpsJob({
        repositoryId: repository.id,
        type: "pages.domain.verify",
        payload: {
          hostname: host,
          verificationToken: resource.payload.verificationToken
        },
        maxAttempts: 3,
        createdByUserId: auth.identity.user.id,
        createdByName: auth.identity.user.displayName
      });
      sendJson(response, 202, { job }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && match[4] === "archive") {
      const archived = await platformStore.updateResource(resource.id, {
        state: "archived",
        payload: { ...resource.payload, archivedAt: new Date().toISOString() }
      });
      await releaseKoshPagesDomain(host, repository.id);
      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: auth.identity.user.id,
        actorName: auth.identity.user.displayName,
        eventType: "pages_custom_domain_archived",
        resourceType: "page_site",
        resourceId: resource.id,
        metadata: { hostname: host, globalClaimReleased: true }
      });
      sendJson(response, 200, { domain: archived }, origin, allowedOrigins);
      return true;
    }

    sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
    return true;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    sendJson(response, status, { error: error instanceof Error ? error.message : "pages_domain_error" }, origin, allowedOrigins);
    return true;
  }
}
