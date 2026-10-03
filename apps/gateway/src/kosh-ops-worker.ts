import { hostname } from "node:os";
import {
  claimKoshOpsJob,
  completeKoshOpsJob,
  failKoshOpsJob,
  heartbeatKoshOpsJob,
  readyKoshOpsStore
} from "./kosh-ops-store.js";
import {
  heartbeatKoshOpsWorker,
  readyKoshOpsWorkerRegistry
} from "./kosh-ops-worker-registry.js";
import { processKoshOpsJobWithPostprocessing } from "./kosh-ops-processing.js";
import { enqueueDueKoshOpsSchedules } from "./kosh-ops-scheduler.js";

const host = hostname();
const workerId =
  process.env.KOSH_OPS_WORKER_ID?.trim() ||
  `${host}:${process.pid}`;
const pollMs = Math.max(
  250,
  Math.min(30_000, Number(process.env.KOSH_OPS_POLL_MS ?? 1500) || 1500)
);
const concurrency = Math.max(
  1,
  Math.min(16, Math.floor(Number(process.env.KOSH_OPS_WORKER_CONCURRENCY ?? 2) || 2))
);
const schedulerEnabled = process.env.KOSH_OPS_SCHEDULER === "true";
const schedulerPollMs = Math.max(
  10_000,
  Math.min(10 * 60_000, Number(process.env.KOSH_OPS_SCHEDULER_POLL_MS ?? 60_000) || 60_000)
);
const fleetHeartbeatMs = Math.max(
  5_000,
  Math.min(60_000, Number(process.env.KOSH_OPS_WORKER_HEARTBEAT_SECONDS ?? 15) * 1000 || 15_000)
);
const startedAt = new Date().toISOString();
let stopping = false;
let activeJobs = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishFleetHeartbeat() {
  await heartbeatKoshOpsWorker({
    workerId,
    hostname: host,
    processId: process.pid,
    releaseVersion: process.env.WORKSPACE_RELEASE_VERSION ?? "dev",
    concurrency,
    activeJobs,
    scheduler: schedulerEnabled,
    startedAt
  });
}

async function runClaimLoop(slot: number) {
  while (!stopping) {
    const job = await claimKoshOpsJob(`${workerId}:${slot}`);
    if (!job || !job.leaseToken) {
      await sleep(pollMs);
      continue;
    }

    activeJobs += 1;
    void publishFleetHeartbeat().catch((error) => {
      console.error("Kosh operations fleet heartbeat failed", error);
    });

    const leaseToken = job.leaseToken;
    const heartbeat = setInterval(() => {
      void heartbeatKoshOpsJob(job.id, leaseToken).catch((error) => {
        console.error("Kosh operations heartbeat failed", { jobId: job.id, error });
      });
    }, 30_000);
    heartbeat.unref();

    try {
      const result = await processKoshOpsJobWithPostprocessing(job);
      const completed = await completeKoshOpsJob(job.id, leaseToken, result);
      if (!completed) {
        console.error("Kosh operations job lost its lease before completion", job.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "operations_job_failed";
      console.error("Kosh operations job failed", { jobId: job.id, type: job.type, error });
      await failKoshOpsJob(job.id, leaseToken, message).catch((failure) => {
        console.error("Kosh operations failure persistence failed", { jobId: job.id, failure });
      });
    } finally {
      clearInterval(heartbeat);
      activeJobs = Math.max(0, activeJobs - 1);
      void publishFleetHeartbeat().catch((error) => {
        console.error("Kosh operations fleet heartbeat failed", error);
      });
    }
  }
}

async function runSchedulerLoop() {
  while (!stopping) {
    try {
      const outcomes = await enqueueDueKoshOpsSchedules();
      if (outcomes.length) {
        console.log(`Kosh operations scheduler enqueued ${outcomes.length} due schedule(s).`);
      }
    } catch (error) {
      console.error("Kosh operations scheduler cycle failed", error);
    }
    await sleep(schedulerPollMs);
  }
}

async function main() {
  await Promise.all([readyKoshOpsStore(), readyKoshOpsWorkerRegistry()]);
  await publishFleetHeartbeat();
  const fleetHeartbeat = setInterval(() => {
    void publishFleetHeartbeat().catch((error) => {
      console.error("Kosh operations fleet heartbeat failed", error);
    });
  }, fleetHeartbeatMs);
  fleetHeartbeat.unref();

  console.log(
    `Kosh operations worker ${workerId} starting with concurrency ${concurrency}` +
    (schedulerEnabled ? " and scheduler leadership." : ".")
  );
  const loops: Promise<void>[] = Array.from(
    { length: concurrency },
    (_, index) => runClaimLoop(index + 1)
  );
  if (schedulerEnabled) loops.push(runSchedulerLoop());
  await Promise.all(loops);
  clearInterval(fleetHeartbeat);
}

function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`Kosh operations worker received ${signal}; stopping after active jobs.`);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

void main().catch((error) => {
  console.error("Kosh operations worker terminated", error);
  process.exitCode = 1;
});
