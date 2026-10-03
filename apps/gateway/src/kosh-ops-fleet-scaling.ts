import { getKoshOpsWorkerFleetSummary } from "./kosh-ops-worker-registry.js";
import { getKoshOpsSchedulerLeadership } from "./kosh-ops-scheduler-leader.js";
import { getKoshOpsQueueStats } from "./kosh-ops-store.js";
import {
  getKoshOpsScalingState,
  updateKoshOpsScalingState
} from "./kosh-ops-scaling-state.js";

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function koshOpsAutoscalePolicy() {
  return {
    enabled: process.env.KOSH_OPS_AUTOSCALE_ENABLED === "true",
    minWorkers: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_MIN_WORKERS, 1, 1, 1000),
    maxWorkers: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_MAX_WORKERS, 20, 1, 1000),
    targetQueuedPerSlot: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_TARGET_QUEUED_PER_SLOT, 2, 1, 100),
    assumedConcurrency: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_ASSUMED_CONCURRENCY, 2, 1, 64),
    scaleDownIdleSlots: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_SCALE_DOWN_IDLE_SLOTS, 4, 0, 1000),
    cooldownMs: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_COOLDOWN_SECONDS, 180, 30, 3600) * 1000,
    scaleDownStabilizationMs: boundedInteger(process.env.KOSH_OPS_AUTOSCALE_SCALE_DOWN_STABILIZATION_SECONDS, 600, 60, 86_400) * 1000
  };
}

export async function getKoshOpsFleetRecommendation() {
  const [fleet, queueStats, scheduler, scalingState] = await Promise.all([
    getKoshOpsWorkerFleetSummary(),
    getKoshOpsQueueStats(undefined),
    getKoshOpsSchedulerLeadership(),
    getKoshOpsScalingState()
  ]);
  const config = koshOpsAutoscalePolicy();
  const queued = Number(queueStats.byState.queued ?? 0);
  const leased = Number(queueStats.byState.leased ?? 0);
  const effectiveConcurrency = fleet.online > 0
    ? Math.max(1, Math.round(fleet.totalConcurrency / fleet.online))
    : config.assumedConcurrency;
  const targetSlots = leased + Math.ceil(queued / config.targetQueuedPerSlot);
  const pressureWorkers = Math.ceil(targetSlots / effectiveConcurrency);
  let desiredWorkers = Math.max(config.minWorkers, Math.min(config.maxWorkers, pressureWorkers || config.minWorkers));
  let reason = queued > fleet.availableSlots ? "queue_pressure" : "steady";
  if (queued === 0 && fleet.availableSlots >= config.scaleDownIdleSlots) {
    desiredWorkers = Math.max(
      config.minWorkers,
      Math.min(desiredWorkers, Math.ceil(Math.max(leased, 1) / effectiveConcurrency))
    );
    reason = desiredWorkers < fleet.online ? "idle_capacity" : "steady";
  }
  if (fleet.online === 0) {
    desiredWorkers = Math.max(config.minWorkers, desiredWorkers);
    reason = "no_online_workers";
  }
  if (!scheduler.active) reason = "scheduler_leader_missing";
  return {
    checkedAt: new Date().toISOString(),
    currentWorkers: fleet.online,
    desiredWorkers,
    delta: desiredWorkers - fleet.online,
    reason,
    queue: {
      queued,
      leased,
      oldestQueuedAgeMs: queueStats.oldestQueuedAgeMs,
      retrying: queueStats.retrying,
      deadLettered: queueStats.deadLettered
    },
    fleet,
    scheduler,
    scalingState,
    policy: config,
    scalerConfigured: Boolean(process.env.KOSH_OPS_SCALER_URL?.trim())
  };
}

async function sendScaleRequest(recommendation: Awaited<ReturnType<typeof getKoshOpsFleetRecommendation>>) {
  const scalerUrl = process.env.KOSH_OPS_SCALER_URL?.trim();
  if (!scalerUrl) throw Object.assign(new Error("operations_scaler_not_configured"), { status: 503 });
  const token = process.env.KOSH_OPS_SCALER_TOKEN?.trim();
  if (process.env.NODE_ENV === "production" && !token) {
    throw Object.assign(new Error("operations_scaler_token_required"), { status: 503 });
  }
  const target = new URL(scalerUrl);
  if (target.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw Object.assign(new Error("operations_scaler_https_required"), { status: 503 });
  }
  const upstream = await fetch(target, {
    method: "POST",
    redirect: "error",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      product: "Kosh",
      component: "operations-workers",
      desiredWorkers: recommendation.desiredWorkers,
      currentWorkers: recommendation.currentWorkers,
      reason: recommendation.reason,
      checkedAt: recommendation.checkedAt
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!upstream.ok) {
    throw Object.assign(new Error("operations_scaler_rejected"), { status: 502, upstreamStatus: upstream.status });
  }
}

export async function reconcileKoshOpsFleet(options: { apply: boolean; automatic?: boolean }) {
  const recommendation = await getKoshOpsFleetRecommendation();
  const policy = recommendation.policy;
  const now = Date.now();
  const pressure = recommendation.queue.queued > recommendation.fleet.availableSlots || recommendation.currentWorkers === 0;
  const idle = recommendation.reason === "idle_capacity";
  const observedState = await updateKoshOpsScalingState({
    desiredWorkers: recommendation.desiredWorkers,
    reason: recommendation.reason,
    pressure,
    idle
  });

  if (!options.apply) return { applied: false, skipped: "dry_run", recommendation, scalingState: observedState };
  if (options.automatic && !policy.enabled) {
    return { applied: false, skipped: "automatic_scaling_disabled", recommendation, scalingState: observedState };
  }
  if (!recommendation.scalerConfigured) {
    return { applied: false, skipped: "scaler_not_configured", recommendation, scalingState: observedState };
  }
  if (recommendation.delta === 0) {
    return { applied: false, skipped: "already_at_desired_capacity", recommendation, scalingState: observedState };
  }

  const lastAppliedAt = observedState.lastAppliedAt ? new Date(observedState.lastAppliedAt).getTime() : 0;
  if (lastAppliedAt && now - lastAppliedAt < policy.cooldownMs) {
    return {
      applied: false,
      skipped: "cooldown",
      retryAfterMs: policy.cooldownMs - (now - lastAppliedAt),
      recommendation,
      scalingState: observedState
    };
  }

  if (recommendation.delta < 0) {
    const idleSince = observedState.idleSince ? new Date(observedState.idleSince).getTime() : now;
    if (now - idleSince < policy.scaleDownStabilizationMs) {
      return {
        applied: false,
        skipped: "scale_down_stabilization",
        retryAfterMs: policy.scaleDownStabilizationMs - (now - idleSince),
        recommendation,
        scalingState: observedState
      };
    }
  }

  await sendScaleRequest(recommendation);
  const appliedState = await updateKoshOpsScalingState({
    desiredWorkers: recommendation.desiredWorkers,
    reason: recommendation.reason,
    applied: true,
    pressure,
    idle
  });
  return { applied: true, recommendation, scalingState: appliedState };
}
