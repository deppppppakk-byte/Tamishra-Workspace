import { hostname } from "node:os";
import {
  claimKoshOpsJob,
  completeKoshOpsJob,
  failKoshOpsJob,
  heartbeatKoshOpsJob,
  readyKoshOpsStore
} from "./kosh-ops-store.js";
import { processKoshOpsJob } from "./kosh-ops-processor.js";
import { enqueueDueKoshOpsSchedules } from "./kosh-ops-scheduler.js";

const workerId =
  process.env.KOSH_OPS_WORKER_ID?.trim() ||
  `${hostname()}:${process.pid}`;
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
let stopping = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runClaimLoop(slot: number) {
  while (!stopping) {
    const job = await claimKoshOpsJob(`${workerId}:${slot}`);
    if (!job || !job.leaseToken) {
      await sleep(pollMs);
      continue;
    }

    const leaseToken = job.leaseToken;
    const heartbeat = setInterval(() => {
      void heartbeatKoshOpsJob(job.id, leaseToken).catch((error) => {
        console.error("Kosh operations heartbeat failed", { jobId: job.id, error });
      });
    }, 30_000);
    heartbeat.unref();

    try {
      const result = await processKoshOpsJob(job);
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
  await readyKoshOpsStore();
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
