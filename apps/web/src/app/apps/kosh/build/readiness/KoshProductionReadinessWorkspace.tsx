"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../build.module.css";

type Certification = {
  checkedAt: string;
  certified: boolean;
  passed: number;
  total: number;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  artifacts: {
    exePackages: number;
    apkPackages: number;
    aabPackages: number;
    publishedReleases: number;
    stableChannels: number;
  };
};

type PoolStatus = {
  ready: boolean;
  actionsRequired: number;
  windows: { currentWorkers: number; desiredWorkers: number; freeSlots: number; provision: number; replace: number };
  android: { currentWorkers: number; desiredWorkers: number; freeSlots: number; provision: number; replace: number };
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

export function KoshProductionReadinessWorkspace() {
  const gateway = useMemo(apiBase, []);
  const [certification, setCertification] = useState<Certification | null>(null);
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconciling, setReconciling] = useState(false);
  const [error, setError] = useState("");

  const fetchJson = useCallback(async <T,>(url: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(url, { credentials: "include", cache: "no-store", ...init });
    const payload = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Kosh request failed (${response.status}).`);
    return payload;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextCertification, nextPool] = await Promise.all([
        fetchJson<Certification>(`${gateway}/v1/kosh/systems/production-certification`),
        fetchJson<PoolStatus>(`${gateway}/v1/kosh/systems/build-pool`)
      ]);
      setCertification(nextCertification);
      setPool(nextPool);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh readiness state.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, gateway]);

  useEffect(() => void load(), [load]);

  async function reconcile() {
    setReconciling(true);
    setError("");
    try {
      await fetchJson(`${gateway}/v1/kosh/systems/build-pool/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reconcile managed build capacity.");
    } finally {
      setReconciling(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href="/apps/kosh/build">← Build Center</Link>
          <p>KOSH PRODUCTION</p>
          <h1>Production Readiness</h1>
          <span>Kosh only marks itself ready when the real controller, build capacity, repository history, artifacts and release channel are present.</span>
        </div>
        <div className={styles.statusCard}>
          <span>Certification</span>
          <strong>{certification?.certified ? "READY" : loading ? "Checking…" : "BLOCKED"}</strong>
          <em>{certification ? `${certification.passed}/${certification.total} checks passed` : "Live verification"}</em>
        </div>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.grid}>
        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Managed Windows pool</strong><span>EXE build capacity.</span></div>
          </div>
          <div className={styles.buildSummary}>
            <div><span>Current</span><strong>{pool?.windows.currentWorkers ?? 0}</strong></div>
            <div><span>Desired</span><strong>{pool?.windows.desiredWorkers ?? 0}</strong></div>
            <div><span>Free slots</span><strong>{pool?.windows.freeSlots ?? 0}</strong></div>
            <div><span>Replace</span><strong>{pool?.windows.replace ?? 0}</strong></div>
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Managed Android pool</strong><span>APK/AAB build capacity.</span></div>
          </div>
          <div className={styles.buildSummary}>
            <div><span>Current</span><strong>{pool?.android.currentWorkers ?? 0}</strong></div>
            <div><span>Desired</span><strong>{pool?.android.desiredWorkers ?? 0}</strong></div>
            <div><span>Free slots</span><strong>{pool?.android.freeSlots ?? 0}</strong></div>
            <div><span>Replace</span><strong>{pool?.android.replace ?? 0}</strong></div>
          </div>
          <button className={styles.primary} type="button" disabled={reconciling} onClick={() => void reconcile()}>
            {reconciling ? "Reconciling…" : "Reconcile managed capacity"}
          </button>
        </article>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Production certification checks</strong><span>{certification?.checkedAt || "Not checked yet"}</span></div>
          <button type="button" onClick={() => void load()} disabled={loading}>Refresh</button>
        </div>
        <div className={styles.artifacts}>
          {(certification?.checks || []).map((check) => (
            <div key={check.id}>
              <div>
                <strong>{check.ok ? "PASS" : "BLOCKED"} · {check.id}</strong>
                <span>{check.detail}</span>
              </div>
            </div>
          ))}
          {!certification?.checks.length ? <div className={styles.empty}>Loading live Kosh certification checks…</div> : null}
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Verified outputs</strong><span>Real packages and release records, not simulated results.</span></div>
        </div>
        <div className={styles.buildSummary}>
          <div><span>EXE</span><strong>{certification?.artifacts.exePackages ?? 0}</strong></div>
          <div><span>APK</span><strong>{certification?.artifacts.apkPackages ?? 0}</strong></div>
          <div><span>AAB</span><strong>{certification?.artifacts.aabPackages ?? 0}</strong></div>
          <div><span>Stable channels</span><strong>{certification?.artifacts.stableChannels ?? 0}</strong></div>
        </div>
      </section>
    </main>
  );
}
