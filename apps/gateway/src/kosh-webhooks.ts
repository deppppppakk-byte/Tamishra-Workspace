import { createHmac, randomUUID } from "node:crypto";
import { getKoshPlatformStore } from "./kosh-platform-store.js";

const platformStore = getKoshPlatformStore();

export type KoshWebhookEvent =
  | "push"
  | "change_review.opened"
  | "change_review.merged"
  | "issue.created"
  | "issue.updated"
  | "workflow.completed"
  | "package.published"
  | "release.published";

function allowedWebhookUrl(value: string) {
  try {
    const url = new URL(value);
    if (process.env.NODE_ENV === "production") {
      return url.protocol === "https:";
    }
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export async function dispatchKoshWebhooks(
  repositoryId: string,
  event: KoshWebhookEvent,
  payload: Record<string, unknown>
) {
  await platformStore.ready();
  const hooks = (await platformStore.listResources("webhook", repositoryId))
    .filter(
      (hook) =>
        hook.state === "active" &&
        hook.payload.active !== false &&
        Array.isArray(hook.payload.events) &&
        (hook.payload.events as unknown[]).map(String).includes(event)
    );

  const deliveries: Array<{
    webhookId: string;
    deliveryId: string;
    ok: boolean;
    status: number | null;
    error: string | null;
  }> = [];

  for (const hook of hooks) {
    const url = String(hook.payload.url ?? "");
    const deliveryId = randomUUID();

    if (!allowedWebhookUrl(url)) {
      deliveries.push({
        webhookId: hook.id,
        deliveryId,
        ok: false,
        status: null,
        error: "invalid_webhook_url"
      });
      continue;
    }

    const envelope = {
      deliveryId,
      event,
      repositoryId,
      sentAt: new Date().toISOString(),
      payload
    };
    const body = JSON.stringify(envelope);
    const secretName = String(hook.payload.secretName ?? "");
    const secret = secretName
      ? await platformStore.resolveSecret(repositoryId, null, secretName)
      : null;
    const signature = secret
      ? "sha256=" +
        createHmac("sha256", secret).update(body).digest("hex")
      : "";

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Kosh-Webhooks/1.0",
          "x-kosh-event": event,
          "x-kosh-delivery": deliveryId,
          ...(signature ? { "x-kosh-signature-256": signature } : {})
        },
        body,
        signal: AbortSignal.timeout(10_000),
        redirect: "error"
      });

      deliveries.push({
        webhookId: hook.id,
        deliveryId,
        ok: response.ok,
        status: response.status,
        error: response.ok ? null : "http_" + response.status
      });
    } catch (error) {
      deliveries.push({
        webhookId: hook.id,
        deliveryId,
        ok: false,
        status: null,
        error: error instanceof Error ? error.message : "delivery_failed"
      });
    }
  }

  for (const delivery of deliveries) {
    await platformStore.appendAudit({
      repositoryId,
      actorUserId: null,
      actorName: "Kosh Webhooks",
      eventType: delivery.ok
        ? "webhook_delivery_succeeded"
        : "webhook_delivery_failed",
      resourceType: "webhook",
      resourceId: delivery.webhookId,
      metadata: {
        event,
        deliveryId: delivery.deliveryId,
        status: delivery.status,
        error: delivery.error
      }
    });
  }

  return deliveries;
}
