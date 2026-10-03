import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import {
  getKoshPlatformStore,
  type StoredKoshPlatformResource
} from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const platformStore = getKoshPlatformStore();
const repositoryStore = getKoshStore();
const MAX_PAYLOAD_BYTES = 256 * 1024;

export type KoshWebhookEvent =
  | "push"
  | "change_review.opened"
  | "change_review.merged"
  | "issue.created"
  | "issue.updated"
  | "workflow.completed"
  | "package.published"
  | "release.published"
  | "webhook.test";

export const koshWebhookEvents: readonly KoshWebhookEvent[] = [
  "push",
  "change_review.opened",
  "change_review.merged",
  "issue.created",
  "issue.updated",
  "workflow.completed",
  "package.published",
  "release.published"
];

type JsonBody = Record<string, unknown>;

type DeliveryAttempt = {
  attempt: number;
  status: number | null;
  ok: boolean;
  error: string | null;
  durationMs: number;
};

class WebhookError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

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

async function readJson(
  request: IncomingMessage,
  limit = 256 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new WebhookError("webhook_payload_too_large", 413);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonBody)
      : {};
  } catch {
    throw new WebhookError("invalid_json", 400);
  }
}

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
}

function webhookTimeoutMs() {
  return Math.floor(
    clamp(process.env.KOSH_WEBHOOK_TIMEOUT_MS, 8_000, 1_000, 15_000)
  );
}

function webhookMaxAttempts() {
  return Math.floor(
    clamp(process.env.KOSH_WEBHOOK_MAX_ATTEMPTS, 3, 1, 5)
  );
}

function deliveryRetention() {
  return Math.floor(
    clamp(process.env.KOSH_WEBHOOK_DELIVERY_RETENTION, 500, 50, 5_000)
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPublicIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51) return false;
  if (a === 203 && b === 0) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIp(address: string) {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;

  const normalized = address.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized === "2001:db8::" ||
    normalized.startsWith("2001:db8:")
  ) {
    return false;
  }

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicIpv4(mapped[1]);
  return true;
}

async function validateWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebhookError("invalid_webhook_url");
  }

  const production = process.env.NODE_ENV === "production";
  if (
    production
      ? url.protocol !== "https:"
      : !["https:", "http:"].includes(url.protocol)
  ) {
    throw new WebhookError("webhook_https_required");
  }
  if (url.username || url.password) {
    throw new WebhookError("webhook_url_credentials_not_allowed");
  }
  if (url.hash) throw new WebhookError("webhook_url_fragment_not_allowed");
  if (!url.hostname || url.hostname.length > 253) {
    throw new WebhookError("invalid_webhook_url");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home") ||
    hostname.endsWith(".lan")
  ) {
    throw new WebhookError("webhook_private_network_not_allowed");
  }

  if (process.env.KOSH_WEBHOOK_BLOCK_PRIVATE_NETWORKS !== "false") {
    const literalVersion = isIP(hostname);
    if (literalVersion && !isPublicIp(hostname)) {
      throw new WebhookError("webhook_private_network_not_allowed");
    }
    if (!literalVersion) {
      let addresses: Array<{ address: string; family: number }> = [];
      try {
        addresses = await lookup(hostname, { all: true, verbatim: true });
      } catch {
        throw new WebhookError("webhook_dns_lookup_failed", 422);
      }
      if (
        !addresses.length ||
        addresses.some((entry) => !isPublicIp(entry.address))
      ) {
        throw new WebhookError("webhook_private_network_not_allowed");
      }
    }
  }

  return url.toString();
}

function isEndpoint(resource: StoredKoshPlatformResource) {
  return resource.type === "webhook" && resource.payload.kind !== "delivery";
}

function isDelivery(resource: StoredKoshPlatformResource) {
  return resource.type === "webhook" && resource.payload.kind === "delivery";
}

function isWebhookEvent(value: string): value is KoshWebhookEvent {
  return (
    value === "webhook.test" ||
    koshWebhookEvents.includes(value as KoshWebhookEvent)
  );
}

function normalizedEvents(value: unknown) {
  if (!Array.isArray(value)) return [] as KoshWebhookEvent[];
  return [...new Set(value.map(String))].filter(
    (event): event is KoshWebhookEvent =>
      koshWebhookEvents.includes(event as KoshWebhookEvent)
  );
}

function endpointView(resource: StoredKoshPlatformResource) {
  return {
    id: resource.id,
    name: resource.name,
    state: resource.state,
    active: resource.state === "active" && resource.payload.active !== false,
    url: String(resource.payload.url ?? ""),
    events: normalizedEvents(resource.payload.events),
    payloadVersion: String(resource.payload.payloadVersion ?? "2026-10-03"),
    hasSigningSecret: Boolean(resource.payload.secretName),
    lastDeliveryAt: resource.payload.lastDeliveryAt ?? null,
    lastStatus: resource.payload.lastStatus ?? null,
    consecutiveFailures: Number(resource.payload.consecutiveFailures ?? 0),
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    createdByName: resource.createdByName
  };
}

function deliveryView(resource: StoredKoshPlatformResource) {
  const attempts = Array.isArray(resource.payload.attempts)
    ? resource.payload.attempts
    : [];
  return {
    id: resource.id,
    webhookId: String(resource.payload.webhookId ?? ""),
    deliveryId: String(
      resource.payload.deliveryId ?? resource.key.replace(/^delivery:/, "")
    ),
    event: String(resource.payload.event ?? ""),
    state: resource.state,
    ok: resource.state === "succeeded",
    status: resource.payload.status ?? null,
    error: resource.payload.error ?? null,
    attempts,
    attemptCount: attempts.length,
    url: String(resource.payload.url ?? ""),
    startedAt: resource.payload.startedAt ?? resource.createdAt,
    completedAt: resource.payload.completedAt ?? null,
    createdAt: resource.createdAt
  };
}

async function endpointById(repositoryId: string, endpointId: string) {
  const resource = await platformStore.getResource(endpointId);
  return resource && resource.repositoryId === repositoryId && isEndpoint(resource)
    ? resource
    : null;
}

async function deliveryById(repositoryId: string, deliveryId: string) {
  const resource = await platformStore.getResource(deliveryId);
  return resource && resource.repositoryId === repositoryId && isDelivery(resource)
    ? resource
    : null;
}

async function createDeliveryRecord(input: {
  repositoryId: string;
  namespace: string;
  endpoint: StoredKoshPlatformResource;
  deliveryId: string;
  event: KoshWebhookEvent;
  payload: Record<string, unknown>;
  url: string;
}) {
  return platformStore.createResource({
    repositoryId: input.repositoryId,
    namespace: input.namespace,
    type: "webhook",
    key: "delivery:" + input.deliveryId,
    name: input.event + " · " + input.deliveryId.slice(0, 8),
    state: "delivering",
    payload: {
      kind: "delivery",
      webhookId: input.endpoint.id,
      deliveryId: input.deliveryId,
      event: input.event,
      payload: input.payload,
      url: input.url,
      status: null,
      error: null,
      attempts: [],
      startedAt: new Date().toISOString(),
      completedAt: null
    },
    createdByUserId: "kosh-system",
    createdByName: "Kosh Webhooks"
  });
}

async function finishDelivery(
  resource: StoredKoshPlatformResource,
  input: {
    endpoint: StoredKoshPlatformResource;
    attempts: DeliveryAttempt[];
    status: number | null;
    error: string | null;
  }
) {
  const succeeded =
    input.status !== null && input.status >= 200 && input.status < 300;
  const completedAt = new Date().toISOString();
  const updated = await platformStore.updateResource(resource.id, {
    state: succeeded ? "succeeded" : "failed",
    payload: {
      ...resource.payload,
      status: input.status,
      error: input.error,
      attempts: input.attempts,
      completedAt
    }
  });
  if (!updated) {
    throw new WebhookError("webhook_delivery_record_missing", 500);
  }

  const previousFailures = Number(input.endpoint.payload.consecutiveFailures ?? 0);
  await platformStore.updateResource(input.endpoint.id, {
    payload: {
      ...input.endpoint.payload,
      lastDeliveryAt: completedAt,
      lastStatus: succeeded ? "succeeded" : "failed",
      lastHttpStatus: input.status,
      consecutiveFailures: succeeded ? 0 : previousFailures + 1
    }
  });

  await platformStore.appendAudit({
    repositoryId: resource.repositoryId,
    actorUserId: null,
    actorName: "Kosh Webhooks",
    eventType: succeeded
      ? "webhook_delivery_succeeded"
      : "webhook_delivery_failed",
    resourceType: "webhook",
    resourceId: input.endpoint.id,
    metadata: {
      event: resource.payload.event,
      deliveryId: resource.payload.deliveryId,
      deliveryResourceId: resource.id,
      status: input.status,
      error: input.error,
      attempts: input.attempts.length
    }
  });

  return updated;
}

async function pruneDeliveries(repositoryId: string) {
  const keep = deliveryRetention();
  const deliveries = (await platformStore.listResources("webhook", repositoryId))
    .filter((resource) => isDelivery(resource) && resource.state !== "delivering")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  await Promise.all(
    deliveries.slice(keep).map((resource) => platformStore.deleteResource(resource.id))
  );
}

function shouldRetry(status: number | null, attempt: number, maxAttempts: number) {
  if (attempt >= maxAttempts) return false;
  if (status === null) return true;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function deliverToEndpoint(input: {
  repositoryId: string;
  namespace: string;
  endpoint: StoredKoshPlatformResource;
  event: KoshWebhookEvent;
  payload: Record<string, unknown>;
}) {
  if (input.endpoint.state === "archived") {
    throw new WebhookError("webhook_archived", 409);
  }

  const deliveryId = randomUUID();
  const attempts: DeliveryAttempt[] = [];
  const maxAttempts = webhookMaxAttempts();
  const urlText = String(input.endpoint.payload.url ?? "");
  const record = await createDeliveryRecord({
    repositoryId: input.repositoryId,
    namespace: input.namespace,
    endpoint: input.endpoint,
    deliveryId,
    event: input.event,
    payload: input.payload,
    url: urlText
  });

  let finalStatus: number | null = null;
  let finalError: string | null = null;

  try {
    const envelope = {
      deliveryId,
      event: input.event,
      repositoryId: input.repositoryId,
      sentAt: new Date().toISOString(),
      version: String(input.endpoint.payload.payloadVersion ?? "2026-10-03"),
      payload: input.payload
    };
    const body = JSON.stringify(envelope);

    if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES) {
      finalError = "webhook_payload_too_large";
    } else {
      const secretName = String(input.endpoint.payload.secretName ?? "");
      const secret = secretName
        ? await platformStore.resolveSecret(input.repositoryId, null, secretName)
        : null;

      if (!secret) {
        finalError = "webhook_signing_secret_missing";
      } else {
        const signature =
          "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const started = Date.now();
          let status: number | null = null;
          let errorText: string | null = null;
          try {
            const verifiedUrl = await validateWebhookUrl(urlText);
            const response = await fetch(verifiedUrl, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "user-agent": "Kosh-Webhooks/2.1",
                "x-kosh-event": input.event,
                "x-kosh-delivery": deliveryId,
                "x-kosh-hook-id": input.endpoint.id,
                "x-kosh-attempt": String(attempt),
                "x-kosh-signature-256": signature
              },
              body,
              signal: AbortSignal.timeout(webhookTimeoutMs()),
              redirect: "error"
            });
            status = response.status;
            await response.body?.cancel();
            if (!response.ok) errorText = "http_" + response.status;
          } catch (error) {
            errorText = error instanceof Error ? error.message : "delivery_failed";
          }

          attempts.push({
            attempt,
            status,
            ok: status !== null && status >= 200 && status < 300,
            error: errorText,
            durationMs: Date.now() - started
          });
          finalStatus = status;
          finalError = errorText;

          if (!shouldRetry(status, attempt, maxAttempts)) break;
          await sleep(Math.min(1_500, 250 * Math.pow(3, attempt - 1)));
        }
      }
    }
  } catch (error) {
    finalError = error instanceof Error ? error.message : "delivery_failed";
  }

  const finished = await finishDelivery(record, {
    endpoint: input.endpoint,
    attempts,
    status: finalStatus,
    error: finalError
  });
  void pruneDeliveries(input.repositoryId).catch(() => undefined);
  return finished;
}

export async function dispatchKoshWebhooks(
  repositoryId: string,
  event: KoshWebhookEvent,
  payload: Record<string, unknown>
) {
  await platformStore.ready();
  const resources = await platformStore.listResources("webhook", repositoryId);
  const endpoints = resources.filter(
    (resource) =>
      isEndpoint(resource) &&
      resource.state === "active" &&
      resource.payload.active !== false &&
      normalizedEvents(resource.payload.events).includes(event)
  );

  const results = [];
  for (const endpoint of endpoints) {
    try {
      const delivery = await deliverToEndpoint({
        repositoryId,
        namespace: endpoint.namespace,
        endpoint,
        event,
        payload
      });
      results.push(deliveryView(delivery));
    } catch (error) {
      results.push({
        webhookId: endpoint.id,
        deliveryId: "",
        event,
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : "delivery_failed"
      });
    }
  }
  return results;
}

async function auditEndpoint(
  repositoryId: string,
  actor: { id: string; displayName: string },
  eventType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {}
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType: "webhook",
    resourceId,
    metadata
  });
}

export async function handleKoshWebhookRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const route = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/webhooks(?:\/([a-f0-9-]{36}))?(?:\/(rotate-secret|test|deliveries))?(?:\/([a-f0-9-]{36}))?(?:\/(redeliver))?$/i
  );
  if (!route) return false;

  try {
    await platformStore.ready();
    const namespace = route[1];
    const slug = route[2];
    const endpointId = route[3] || "";
    const action = route[4] || "";
    const deliveryId = route[5] || "";
    const subaction = route[6] || "";
    const repository = await repositoryStore.get(namespace, slug);
    if (!repository) throw new WebhookError("repository_not_found", 404);

    const write = request.method !== "GET";
    const authorization = await authorizeKoshRepositoryRequest(
      request,
      repository,
      write ? "repository.manage" : "repository.read"
    );
    if (!authorization.decision.allowed || (write && !authorization.identity)) {
      sendJson(
        response,
        authorization.identity ? 403 : 401,
        { error: authorization.identity ? "repository_permission_denied" : "authentication_required" },
        origin,
        allowedOrigins
      );
      return true;
    }
    if (write && origin && !allowedOrigins.has(origin)) {
      throw new WebhookError("origin_not_allowed", 403);
    }

    const resources = await platformStore.listResources("webhook", repository.id);

    if (!endpointId && request.method === "GET") {
      const endpoints = resources
        .filter((resource) => isEndpoint(resource) && resource.state !== "archived")
        .sort((a, b) => a.name.localeCompare(b.name));
      const deliveries = resources
        .filter(isDelivery)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      sendJson(
        response,
        200,
        {
          endpoints: endpoints.map(endpointView),
          recentDeliveries: deliveries.slice(0, 50).map(deliveryView),
          events: koshWebhookEvents,
          deliveryRetention: deliveryRetention(),
          signing: "HMAC-SHA256",
          signatureHeader: "x-kosh-signature-256"
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (!endpointId && request.method === "POST") {
      const body = await readJson(request);
      const name = clean(body.name, 120);
      const urlText = clean(body.url, 2048);
      const events = normalizedEvents(body.events);
      if (!name) throw new WebhookError("webhook_name_required");
      if (!urlText) throw new WebhookError("webhook_url_required");
      if (!events.length) throw new WebhookError("webhook_events_required");
      const verifiedUrl = await validateWebhookUrl(urlText);
      const actor = authorization.identity!.user;
      const keyId = randomUUID();
      const secret = randomBytes(32).toString("base64url");
      const secretName = "webhook:" + keyId;
      const secretRecord = await platformStore.putSecret({
        repositoryId: repository.id,
        environmentName: null,
        name: secretName,
        value: secret,
        createdByUserId: actor.id,
        createdByName: actor.displayName
      });

      let endpoint: StoredKoshPlatformResource;
      try {
        endpoint = await platformStore.createResource({
          repositoryId: repository.id,
          namespace,
          type: "webhook",
          key: "endpoint:" + keyId,
          name,
          state: body.active === false ? "disabled" : "active",
          payload: {
            kind: "endpoint",
            url: verifiedUrl,
            events,
            active: body.active !== false,
            secretName,
            payloadVersion: "2026-10-03",
            consecutiveFailures: 0
          },
          createdByUserId: actor.id,
          createdByName: actor.displayName
        });
      } catch (error) {
        await platformStore.deleteSecret(secretRecord.id);
        throw error;
      }

      await auditEndpoint(repository.id, actor, "webhook_endpoint_created", endpoint.id, {
        events,
        active: endpoint.state === "active"
      });
      sendJson(
        response,
        201,
        { endpoint: endpointView(endpoint), signingSecret: secret },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (!endpointId) return false;
    const endpoint = await endpointById(repository.id, endpointId);
    if (!endpoint || endpoint.state === "archived") {
      throw new WebhookError("webhook_not_found", 404);
    }

    if (!action && request.method === "GET") {
      sendJson(response, 200, { endpoint: endpointView(endpoint) }, origin, allowedOrigins);
      return true;
    }

    if (!action && request.method === "PATCH") {
      const body = await readJson(request);
      const nextName = body.name === undefined ? endpoint.name : clean(body.name, 120);
      if (!nextName) throw new WebhookError("webhook_name_required");
      const nextEvents = body.events === undefined
        ? normalizedEvents(endpoint.payload.events)
        : normalizedEvents(body.events);
      if (!nextEvents.length) throw new WebhookError("webhook_events_required");
      const nextUrl = body.url === undefined
        ? String(endpoint.payload.url ?? "")
        : await validateWebhookUrl(clean(body.url, 2048));
      const active = body.active === undefined
        ? endpoint.state === "active" && endpoint.payload.active !== false
        : Boolean(body.active);
      const actor = authorization.identity!.user;
      const updated = await platformStore.updateResource(endpoint.id, {
        name: nextName,
        state: active ? "active" : "disabled",
        payload: {
          ...endpoint.payload,
          kind: "endpoint",
          url: nextUrl,
          events: nextEvents,
          active,
          updatedByUserId: actor.id,
          updatedByName: actor.displayName
        }
      });
      if (!updated) throw new WebhookError("webhook_not_found", 404);
      await auditEndpoint(repository.id, actor, "webhook_endpoint_updated", updated.id, {
        events: nextEvents,
        active
      });
      sendJson(response, 200, { endpoint: endpointView(updated) }, origin, allowedOrigins);
      return true;
    }

    if (!action && request.method === "DELETE") {
      const actor = authorization.identity!.user;
      const secretName = String(endpoint.payload.secretName ?? "");
      const secret = (await platformStore.listSecrets(repository.id)).find(
        (item) => item.environmentName === null && item.name === secretName
      );
      const archived = await platformStore.updateResource(endpoint.id, {
        state: "archived",
        payload: {
          ...endpoint.payload,
          active: false,
          secretName: "",
          archivedAt: new Date().toISOString(),
          archivedByUserId: actor.id,
          archivedByName: actor.displayName
        }
      });
      if (!archived) throw new WebhookError("webhook_not_found", 404);
      if (secret) await platformStore.deleteSecret(secret.id);
      await auditEndpoint(repository.id, actor, "webhook_endpoint_archived", endpoint.id);
      sendJson(response, 200, { deleted: true }, origin, allowedOrigins);
      return true;
    }

    if (action === "rotate-secret" && request.method === "POST") {
      const actor = authorization.identity!.user;
      const secretName = String(endpoint.payload.secretName ?? "") || "webhook:" + randomUUID();
      const secret = randomBytes(32).toString("base64url");
      await platformStore.putSecret({
        repositoryId: repository.id,
        environmentName: null,
        name: secretName,
        value: secret,
        createdByUserId: actor.id,
        createdByName: actor.displayName
      });
      const updated = await platformStore.updateResource(endpoint.id, {
        payload: { ...endpoint.payload, secretName }
      });
      if (!updated) throw new WebhookError("webhook_not_found", 404);
      await auditEndpoint(repository.id, actor, "webhook_secret_rotated", endpoint.id);
      sendJson(
        response,
        200,
        { endpoint: endpointView(updated), signingSecret: secret },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (action === "test" && request.method === "POST") {
      const delivery = await deliverToEndpoint({
        repositoryId: repository.id,
        namespace,
        endpoint,
        event: "webhook.test",
        payload: {
          test: true,
          repository: {
            id: repository.id,
            namespace: repository.namespace,
            slug: repository.slug
          }
        }
      });
      sendJson(response, 201, { delivery: deliveryView(delivery) }, origin, allowedOrigins);
      return true;
    }

    if (action === "deliveries" && !deliveryId && request.method === "GET") {
      const deliveries = resources
        .filter((item) => isDelivery(item) && item.payload.webhookId === endpoint.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 100);
      sendJson(
        response,
        200,
        { deliveries: deliveries.map(deliveryView) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      action === "deliveries" &&
      deliveryId &&
      subaction === "redeliver" &&
      request.method === "POST"
    ) {
      const previous = await deliveryById(repository.id, deliveryId);
      if (!previous || previous.payload.webhookId !== endpoint.id) {
        throw new WebhookError("webhook_delivery_not_found", 404);
      }
      if (previous.state === "delivering") {
        throw new WebhookError("webhook_delivery_in_progress", 409);
      }
      const event = String(previous.payload.event ?? "");
      if (!isWebhookEvent(event)) throw new WebhookError("invalid_webhook_event", 409);
      const payload = previous.payload.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new WebhookError("webhook_delivery_payload_unavailable", 409);
      }
      const delivery = await deliverToEndpoint({
        repositoryId: repository.id,
        namespace,
        endpoint,
        event,
        payload: payload as Record<string, unknown>
      });
      sendJson(response, 201, { delivery: deliveryView(delivery) }, origin, allowedOrigins);
      return true;
    }

    return false;
  } catch (error) {
    const status = error instanceof WebhookError
      ? error.status
      : Number((error as { status?: number })?.status ?? 500);
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "webhook_request_failed" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
