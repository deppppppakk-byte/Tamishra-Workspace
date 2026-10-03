import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshMaintenanceStore } from "./kosh-maintenance-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const maintenanceStore = getKoshMaintenanceStore();
const channels = new Set(["email", "push", "webhook"]);
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

async function readJson(request: IncomingMessage, maxBytes = 64 * 1024): Promise<JsonBody> {
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

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
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

function validateTarget(channel: string, raw: unknown) {
  const target = clean(raw, 2000);
  if (!target) throw Object.assign(new Error("notification_target_required"), { status: 400 });
  if (channel === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target) || target.length > 320) {
      throw Object.assign(new Error("notification_email_invalid"), { status: 400 });
    }
  } else if (channel === "webhook") {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw Object.assign(new Error("notification_webhook_invalid"), { status: 400 });
    }
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
      throw Object.assign(new Error("notification_webhook_https_required"), { status: 400 });
    }
    if (!url.hostname || url.username || url.password) {
      throw Object.assign(new Error("notification_webhook_invalid"), { status: 400 });
    }
  } else if (target.length < 16) {
    throw Object.assign(new Error("notification_push_target_invalid"), { status: 400 });
  }
  return target;
}

function publicSubscription(resource: Awaited<ReturnType<typeof platformStore.getResource>>) {
  if (!resource) return null;
  return {
    id: resource.id,
    name: resource.name,
    state: resource.state,
    channel: resource.payload.channel,
    events: resource.payload.events,
    hasEncryptedTarget: true,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt
  };
}

export async function handleKoshNotificationDeliveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/notifications\/channels(?:\/([^/]+)(?:\/(test|archive))?)?$/
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

    const subscriptions = (await platformStore.listResources("subscription", repository.id))
      .filter((item) => item.payload.kind === "delivery_channel");

    if (request.method === "GET" && !match[3]) {
      sendJson(response, 200, {
        channels: subscriptions.map(publicSubscription),
        providerConfigured: Boolean(process.env.KOSH_NOTIFICATION_DELIVERY_HOOK?.trim())
      }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && !match[3]) {
      const body = await readJson(request);
      const channel = clean(body.channel, 40).toLowerCase();
      if (!channels.has(channel)) {
        sendJson(response, 400, { error: "notification_channel_invalid" }, origin, allowedOrigins);
        return true;
      }
      const target = validateTarget(channel, body.target);
      const id = randomUUID();
      const secretName = "notification-target:" + id;
      const events = Array.isArray(body.events)
        ? [...new Set(body.events.map((item) => clean(item, 100)).filter(Boolean))].slice(0, 50)
        : ["production_alerts"];
      await platformStore.putSecret({
        repositoryId: repository.id,
        environmentName: "notification",
        name: secretName,
        value: target,
        createdByUserId: auth.identity.user.id,
        createdByName: auth.identity.user.displayName
      });
      let resource = null;
      try {
        resource = await platformStore.createResource({
          repositoryId: repository.id,
          namespace: repository.namespace,
          type: "subscription",
          key: "delivery:" + id,
          name: clean(body.name, 160) || `${channel} delivery`,
          state: body.enabled === false ? "disabled" : "enabled",
          payload: {
            kind: "delivery_channel",
            channel,
            events,
            secretName
          },
          createdByUserId: auth.identity.user.id,
          createdByName: auth.identity.user.displayName
        });
      } catch (error) {
        const secret = (await platformStore.listSecrets(repository.id)).find(
          (item) => item.environmentName === "notification" && item.name === secretName
        );
        if (secret) await platformStore.deleteSecret(secret.id).catch(() => undefined);
        throw error;
      }
      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: auth.identity.user.id,
        actorName: auth.identity.user.displayName,
        eventType: "notification_delivery_channel_created",
        resourceType: "subscription",
        resourceId: resource.id,
        metadata: { channel, events }
      });
      sendJson(response, 201, { channel: publicSubscription(resource) }, origin, allowedOrigins);
      return true;
    }

    const id = decodeURIComponent(match[3] ?? "");
    const resource = subscriptions.find((item) => item.id === id);
    if (!resource) {
      sendJson(response, 404, { error: "notification_channel_not_found" }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "GET" && !match[4]) {
      sendJson(response, 200, { channel: publicSubscription(resource) }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && match[4] === "test") {
      if (resource.state !== "enabled") {
        sendJson(response, 409, { error: "notification_channel_disabled" }, origin, allowedOrigins);
        return true;
      }
      const job = await maintenanceStore.enqueue({
        repositoryId: repository.id,
        kind: "notification_delivery",
        priority: 80,
        dedupeKey: `notification-test:${resource.id}:${Math.floor(Date.now() / 60_000)}`,
        payload: {
          category: "test",
          subscriptionId: resource.id,
          message: clean((await readJson(request)).message, 1000) || "Kosh notification delivery test",
          repository: `${repository.namespace}/${repository.slug}`
        }
      });
      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: auth.identity.user.id,
        actorName: auth.identity.user.displayName,
        eventType: "notification_delivery_test_enqueued",
        resourceType: "subscription",
        resourceId: resource.id,
        metadata: { jobId: job.id, channel: resource.payload.channel }
      });
      sendJson(response, 202, { job, providerConfigured: Boolean(process.env.KOSH_NOTIFICATION_DELIVERY_HOOK?.trim()) }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && match[4] === "archive") {
      const secretName = clean(resource.payload.secretName, 240);
      if (secretName) {
        const secret = (await platformStore.listSecrets(repository.id)).find(
          (item) => item.environmentName === "notification" && item.name === secretName
        );
        if (secret) await platformStore.deleteSecret(secret.id).catch(() => undefined);
      }
      const updated = await platformStore.updateResource(resource.id, {
        state: "archived",
        payload: { ...resource.payload, secretName: null, archivedAt: new Date().toISOString() }
      });
      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: auth.identity.user.id,
        actorName: auth.identity.user.displayName,
        eventType: "notification_delivery_channel_archived",
        resourceType: "subscription",
        resourceId: resource.id,
        metadata: { channel: resource.payload.channel }
      });
      sendJson(response, 200, { channel: publicSubscription(updated) }, origin, allowedOrigins);
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
      { error: error instanceof Error ? error.message : "notification_delivery_error" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
