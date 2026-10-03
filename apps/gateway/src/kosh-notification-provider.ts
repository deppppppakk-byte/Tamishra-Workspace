import type { StoredKoshMaintenanceJob } from "./kosh-maintenance-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";

const platformStore = getKoshPlatformStore();

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

export async function executeKoshNotificationDeliveryJob(job: StoredKoshMaintenanceJob) {
  const hook = process.env.KOSH_NOTIFICATION_DELIVERY_HOOK?.trim();
  if (!hook) {
    throw Object.assign(new Error("notification_delivery_provider_not_configured"), { status: 503 });
  }
  const url = new URL(hook);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw Object.assign(new Error("notification_delivery_provider_https_required"), { status: 503 });
  }

  await platformStore.ready();
  const subscriptionId = clean(job.payload.subscriptionId, 100);
  let delivery: Record<string, unknown> | null = null;
  if (subscriptionId) {
    const subscription = await platformStore.getResource(subscriptionId);
    if (
      !subscription ||
      subscription.type !== "subscription" ||
      subscription.repositoryId !== job.repositoryId ||
      subscription.payload.kind !== "delivery_channel" ||
      subscription.state !== "enabled"
    ) {
      throw Object.assign(new Error("notification_subscription_unavailable"), { status: 409 });
    }
    const secretName = clean(subscription.payload.secretName, 240);
    const target = secretName
      ? await platformStore.resolveSecret(job.repositoryId, "notification", secretName)
      : null;
    if (!target) {
      throw Object.assign(new Error("notification_delivery_target_missing"), { status: 409 });
    }
    delivery = {
      subscriptionId: subscription.id,
      channel: subscription.payload.channel,
      target,
      events: subscription.payload.events
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.KOSH_MAINTENANCE_PROVIDER_TOKEN
        ? { authorization: `Bearer ${process.env.KOSH_MAINTENANCE_PROVIDER_TOKEN}` }
        : {})
    },
    body: JSON.stringify({
      jobId: job.id,
      repositoryId: job.repositoryId,
      payload: job.payload,
      delivery
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const text = (await response.text()).slice(0, 128 * 1024);
  if (!response.ok) {
    throw Object.assign(
      new Error(`notification_delivery_http_${response.status}:${text.slice(0, 1000)}`),
      { status: response.status >= 400 && response.status < 500 ? 502 : 503 }
    );
  }
  let providerResponse: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      providerResponse = parsed as Record<string, unknown>;
    }
  } catch {
    providerResponse = { response: text };
  }
  return {
    provider: url.origin,
    subscriptionId: subscriptionId || null,
    delivered: true,
    response: providerResponse
  };
}
