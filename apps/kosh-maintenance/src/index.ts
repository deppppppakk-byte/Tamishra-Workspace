import os from "node:os";

const origin = (process.env.KOSH_GATEWAY_ORIGIN?.trim() || "http://localhost:4100").replace(/\/$/, "");
const token = process.env.KOSH_MAINTENANCE_TOKEN?.trim() || "";
const workerId =
  process.env.KOSH_MAINTENANCE_WORKER_ID?.trim() ||
  `maintenance-${os.hostname()}-${process.pid}`;
const pollMs = Math.max(1_000, Math.min(60_000, Number(process.env.KOSH_MAINTENANCE_POLL_MS) || 5_000));
const scheduleMs = Math.max(
  60_000,
  Math.min(60 * 60_000, Number(process.env.KOSH_MAINTENANCE_SCHEDULE_MS) || 5 * 60_000)
);

if (!token && process.env.NODE_ENV === "production") {
  throw new Error("KOSH_MAINTENANCE_TOKEN is required in production");
}

let stopping = false;
let lastScheduleAt = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function post(path: string, body: Record<string, unknown>) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15 * 60_000)
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(`maintenance_http_${response.status}`) as Error & { payload?: unknown };
    error.payload = payload;
    throw error;
  }
  return payload as Record<string, unknown>;
}

async function schedule() {
  const payload = await post("/v1/kosh/maintenance/schedule", { workerId });
  const queued = Array.isArray(payload.queued) ? payload.queued.length : 0;
  if (queued > 0) {
    console.log(`[kosh-maintenance] scheduled ${queued} job(s)`);
  }
}

async function claim() {
  const payload = await post("/v1/kosh/maintenance/claim", {
    workerId,
    leaseSeconds: 600
  });
  return payload.job && typeof payload.job === "object"
    ? payload.job as Record<string, unknown>
    : null;
}

async function execute(job: Record<string, unknown>) {
  const id = String(job.id ?? "");
  const leaseToken = String(job.leaseToken ?? "");
  if (!id || !leaseToken) throw new Error("maintenance_claim_missing_lease");
  console.log(`[kosh-maintenance] executing ${String(job.kind ?? "unknown")} ${id}`);
  const payload = await post(`/v1/kosh/maintenance/jobs/${encodeURIComponent(id)}/execute`, {
    workerId,
    leaseToken
  });
  const finished = payload.job && typeof payload.job === "object"
    ? payload.job as Record<string, unknown>
    : null;
  console.log(
    `[kosh-maintenance] ${id} -> ${finished ? String(finished.status ?? "unknown") : "unknown"}`
  );
}

async function loop() {
  console.log(`[kosh-maintenance] worker ${workerId} connected to ${origin}`);
  while (!stopping) {
    try {
      if (Date.now() - lastScheduleAt >= scheduleMs) {
        await schedule();
        lastScheduleAt = Date.now();
      }
      const job = await claim();
      if (job) {
        await execute(job);
        continue;
      }
    } catch (error) {
      console.error("[kosh-maintenance] cycle failed", error);
    }
    await sleep(pollMs);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    console.log(`[kosh-maintenance] received ${signal}; stopping after current cycle`);
  });
}

await loop();
