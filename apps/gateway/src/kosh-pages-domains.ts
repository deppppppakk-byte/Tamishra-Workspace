import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshMaintenanceStore } from "./kosh-maintenance-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const maintenanceStore = getKoshMaintenanceStore();
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type JsonBody = Record<string, unknown>;

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

async function readJson(request: IncomingMessage, maxBytes = 32 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function requireAllowedOrigin(
  request: IncomingMessage,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (mutatingMethods.has(request.method ?? "") && origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

function normalizeDomain(value: unknown) {
  const domain = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (
    domain.length < 4 ||
    domain.length > 253 ||
    domain === "localhost" ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(domain) ||
    !domain.includes(".") ||
    domain.split(".").some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    )
  ) {
    throw Object.assign(new Error("invalid_pages_custom_domain"), { status: 400 });
  }
  return domain;
}

function domainView(resource: Awaited<ReturnType<typeof platformStore.getResource>>) {
  if (!resource) return null;
  return {
    id: resource.id,
    domain: String(resource.payload.domain ?? ""),
    state: resource.state,
    challengeName: String(resource.payload.challengeName ?? ""),
    challengeValue: String(resource.payload.challengeValue ?? ""),
    verifiedAt: resource.payload.verifiedAt ?? null,
    tlsState: resource.payload.tlsState ?? "pending",
    tlsUpdatedAt: resource.payload.tlsUpdatedAt ?? null,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt
  };
}

async function verifyDns(resource: NonNullable<Awaited<ReturnType<typeof platformStore.getResource>>>) {
  const name = String(resource.payload.challengeName ?? "");
  const expected = String(resource.payload.challengeValue ?? "");
  if (!name || !expected) throw Object.assign(new Error("domain_challenge_missing"), { status: 409 });
  let records: string[][] = [];
  try {
    records = await resolveTxt(name);
  } catch {
    records = [];
  }
  const values = records.map((parts) => parts.join(""));
  return { verified: values.includes(expected), records: values.slice(0, 20) };
}

export async function handleKoshPagesDomainsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/pages\/domains(?:\/([^/]+)(?:\/(verify|archive))?)?$/
  );
  if (!match) return false;

  try {
    requireAllowedOrigin(request, origin, allowedOrigins);
    await Promise.all([platformStore.ready(), maintenanceStore.ready()]);
    const repository = await repositoryStore.get(match[1], match[2]);
    if (!repository) {
      sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
      return true;
    }
    const permission = request.method === "GET" ? "repository.read" as const : "repository.manage" as const;
    const auth = await authorizeKoshRepositoryRequest(request, repository, permission);
    if (!auth.identity || !auth.decision.allowed) {
      sendJson(
        response,
        auth.identity ? 403 : 401,
        { error: auth.identity ? "repository_permission_denied" : "authentication_required" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const resources = (await platformStore.listResources("page_site", repository.id))
      .filter((item) => item.payload.kind === "custom_domain");

    if (request.method === "GET" && !match[3]) {
      sendJson(response, 200, { domains: resources.map(domainView) }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && !match[3]) {
      const body = await readJson(request);
      const domain = normalizeDomain(body.domain);
      const duplicate = resources.find((item) => item.payload.domain === domain && item.state !== "archived");
      if (duplicate) {
        sendJson(response, 409, { error: "custom_domain_exists", domain: domainView(duplicate) }, origin, allowedOrigins);
        return true;
      }
      const token = randomBytes(24).toString("base64url");
      const resource = await platformStore.createResource({
        repositoryId: repository.id,
        namespace: repository.namespace,
        type: "page_site",
        key: "domain:" + domain,
        name: "Pages domain " + domain,
        state: "pending_verification",
        payload: {
          kind: "custom_domain",
          domain,
          challengeName: `_kosh.${domain}`,
          challengeValue: `kosh-verification=${token}`,
          verifiedAt: null,
          tlsState: "pending",
          tlsUpdatedAt: null
        },
        createdByUserId: auth.identity.user.id,
        createdByName: auth.identity.user.displayName
      });
      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: auth.identity.user.id,
        actorName: auth.identity.user.displayName,
        eventType: "pages_custom_domain_created",
        resourceType: "page_site",
        resourceId: resource.id,
        metadata: { domain }
      });
      sendJson(response, 201, { domain: domainView(resource) }, origin, allowedOrigins);
      return true;
    }

    const id = decodeURIComponent(match[3] ?? "");
    const resource = resources.find((item) => item.id === id);
    if (!resource) {
      sendJson(response, 404, { error: "custom_domain_not_found" }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "GET" && !match[4]) {
      sendJson(response, 200, { domain: domainView(resource) }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && match[4] === "verify") {
      const dns = await verifyDns(resource);
      const now = new Date().toISOString();
      const tlsConfigured = Boolean(process.env.KOSH_PAGES_DOMAIN_MAINTENANCE_HOOK?.trim());
      const updated = await platformStore.updateResource(resource.id, {
        state: dns.verified ? "verified" : "pending_verification",
        payload: {
          ...resource.payload,
          verifiedAt: dns.verified ? now : null,
          lastDnsCheckAt: now,
          tlsState: dns.verified ? (tlsConfigured ? "queued" : "provider_not_configured") : "pending",
          tlsUpdatedAt: dns.verified ? now : resource.payload.tlsUpdatedAt ?? null
        }
      });
      let job = null;
      if (dns.verified && tlsConfigured) {
        job = await maintenanceStore.enqueue({
          repositoryId: repository.id,
          kind: "pages_domain_maintenance",
          priority: 70,
          dedupeKey: `pages-domain:${resource.id}`,
          payload: {
            action: "ensure_tls",
            domain,
            domainResourceId: resource.id,
            repository: `${repository.namespace}/${repository.slug}`
          }
        });
      }
      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: auth.identity.user.id,
        actorName: auth.identity.user.displayName,
        eventType: dns.verified ? "pages_custom_domain_verified" : "pages_custom_domain_verification_failed",
        resourceType: "page_site",
        resourceId: resource.id,
        metadata: { domain, recordsObserved: dns.records.length, tlsJobId: job?.id ?? null }
      });
      sendJson(response, dns.verified ? 200 : 409, {
        verified: dns.verified,
        records: dns.records,
        domain: domainView(updated),
        tlsJob: job
      }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && match[4] === "archive") {
      const updated = await platformStore.updateResource(resource.id, {
        state: "archived",
        payload: {
          ...resource.payload,
          archivedAt: new Date().toISOString(),
          tlsState: "disabled",
          tlsUpdatedAt: new Date().toISOString()
        }
      });
      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: auth.identity.user.id,
        actorName: auth.identity.user.displayName,
        eventType: "pages_custom_domain_archived",
        resourceType: "page_site",
        resourceId: resource.id,
        metadata: { domain: resource.payload.domain }
      });
      sendJson(response, 200, { domain: domainView(updated) }, origin, allowedOrigins);
      return true;
    }

    sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
    return true;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "pages_custom_domain_error" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
