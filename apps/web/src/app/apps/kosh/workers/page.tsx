"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./workers.module.css";

type WorkerState = "active" | "draining" | "disabled";
type Worker = {
  workerId: string;
  hostname: string;
  processId: number;
  releaseVersion: string;
  concurrency: number;
  activeJobs: number;
  scheduler: boolean;
  startedAt: string;
  lastSeenAt: string;
  status: "online" | "stale";
  requestedState: WorkerState;
  desiredConcurrency: number | null;
  controlReason: string | null;
};
type Fleet = {
  online: number;
  stale: number;
  active: number;
  draining: number;
  disabled: number;
  schedulerLeaders: number;
  totalConcurrency: number;
  activeJobs: number;
  availableSlots: number;
  healthy: boolean;
  schedulerState: "healthy" | "missing" | "multiple";
};
type FleetResponse = { summary: Fleet; workers: Worker[]; staleAfterMs: number };

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function stamp(value: string) {
  try { return new Date(value).toLocaleString(); } catch { return value; }
}

export default function KoshWorkersPage() {
  const base = useMemo(apiBase, []);
  const [payload, setPayload] = useState<FleetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [limits, setLimits] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(base + "/v1/kosh/systems/workers", { credentials: "include", cache: "no-store" });
      const body = (await response.json()) as FleetResponse & { error?: string };
      if (!response.ok) throw new Error(body.error || `Worker fleet returned ${response.status}.`);
      setPayload(body);
      setLimits(Object.fromEntries(body.workers.map((worker) => [worker.workerId, String(worker.desiredConcurrency ?? worker.concurrency)])));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load worker fleet.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  async function control(worker: Worker, requestedState: WorkerState) {
    setBusy(worker.workerId);
    setError("");
    try {
      const desired = Number(limits[worker.workerId]);
      const response = await fetch(base + "/v1/kosh/systems/workers/control", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workerId: worker.workerId,
          requestedState,
          desiredConcurrency: Number.isFinite(desired) ? desired : null,
          reason: `Changed from Kosh Worker Fleet workspace to ${requestedState}`
        })
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Worker update returned ${response.status}.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Worker update failed.");
    } finally {
      setBusy("");
    }
  }

  async function prune(worker: Worker) {
    setBusy(worker.workerId);
    setError("");
    try {
      const response = await fetch(base + "/v1/kosh/systems/workers/prune", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workerId: worker.workerId })
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || `Worker prune returned ${response.status}.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Worker prune failed.");
    } finally {
      setBusy("");
    }
  }

  const fleet = payload?.summary;
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>KOSH OPERATIONS</p>
          <h1>Worker Fleet</h1>
          <p>Control asynchronous Kosh capacity without interrupting jobs already in progress.</p>
        </div>
        <div className={styles.actions}>
          <Link href="/apps/kosh/operations">Operations</Link>
          <Link href="/apps/kosh/readiness">Readiness</Link>
          <button onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.summary}>
        <article><span>Fleet</span><strong>{fleet?.healthy ? "Healthy" : loading ? "…" : "Attention"}</strong><small>{fleet?.schedulerState ?? "checking"} scheduler</small></article>
        <article><span>Online</span><strong>{fleet?.online ?? "—"}</strong><small>{fleet?.stale ?? 0} stale</small></article>
        <article><span>Capacity</span><strong>{fleet?.totalConcurrency ?? "—"}</strong><small>{fleet?.availableSlots ?? 0} slots available</small></article>
        <article><span>Active jobs</span><strong>{fleet?.activeJobs ?? "—"}</strong><small>{fleet?.draining ?? 0} draining · {fleet?.disabled ?? 0} disabled</small></article>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHeading}>
          <div><p className={styles.eyebrow}>REGISTERED WORKERS</p><h2>Fleet nodes</h2></div>
          <span>{payload?.workers.length ?? 0} records</span>
        </div>
        {loading ? <div className={styles.empty}>Loading worker fleet…</div> : !payload?.workers.length ? (
          <div className={styles.empty}>No operations workers have registered yet.</div>
        ) : (
          <div className={styles.grid}>
            {payload.workers.map((worker) => {
              const effective = Math.min(worker.concurrency, Number(limits[worker.workerId]) || worker.concurrency);
              return (
                <article className={styles.card} key={worker.workerId}>
                  <div className={styles.cardTop}>
                    <div><strong>{worker.hostname}</strong><code>{worker.workerId}</code></div>
                    <div className={styles.badges}>
                      <span className={styles[worker.status]}>{worker.status}</span>
                      <span className={styles[worker.requestedState]}>{worker.requestedState}</span>
                    </div>
                  </div>
                  <div className={styles.meta}>
                    <span>Release <b>{worker.releaseVersion}</b></span>
                    <span>PID <b>{worker.processId}</b></span>
                    <span>Jobs <b>{worker.activeJobs}</b></span>
                    <span>Scheduler <b>{worker.scheduler ? "leader" : "no"}</b></span>
                  </div>
                  <label className={styles.capacity}>
                    <span>Desired concurrency <small>runtime max {worker.concurrency}</small></span>
                    <input
                      type="number"
                      min={1}
                      max={worker.concurrency}
                      value={limits[worker.workerId] ?? worker.concurrency}
                      onChange={(event) => setLimits((current) => ({ ...current, [worker.workerId]: event.target.value }))}
                    />
                    <em>{effective} effective slots</em>
                  </label>
                  <div className={styles.times}>
                    <span>Started {stamp(worker.startedAt)}</span>
                    <span>Seen {stamp(worker.lastSeenAt)}</span>
                  </div>
                  {worker.controlReason && <p className={styles.reason}>{worker.controlReason}</p>}
                  <div className={styles.controls}>
                    <button disabled={busy === worker.workerId} onClick={() => void control(worker, "active")}>Activate / apply</button>
                    <button disabled={busy === worker.workerId} onClick={() => void control(worker, "draining")}>Drain</button>
                    <button disabled={busy === worker.workerId} onClick={() => void control(worker, "disabled")}>Disable</button>
                    {worker.status === "stale" && worker.activeJobs === 0 && (
                      <button className={styles.danger} disabled={busy === worker.workerId} onClick={() => void prune(worker)}>Prune stale</button>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}
