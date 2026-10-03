"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./operations.module.css";

type JobState = "queued" | "leased" | "succeeded" | "failed" | "cancelled";
type JobType =
  | "storage.lifecycle"
  | "replication.verify"
  | "recovery.drill"
  | "alerts.evaluate"
  | "notification.deliver"
  | "pages.domain.verify"
  | "extension.execute"
  | "load.test"
  | "database.backup"
  | "secret.rotation.audit"
  | "failure.probe";

type Job = {
  id: string;
  repositoryId: string | null;
  type: JobType;
  state: JobState;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempt: number;
  maxAttempts: number;
  priority: number;
  idempotencyKey: string | null;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  deadLetteredAt: string | null;
  finishedAt: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

type QueueStats = {
  backend: string;
  total: number;
  byState: Record<JobState, number>;
  deadLettered: number;
  retrying: number;
  oldestQueuedAgeMs: number;
  queuedByPriority: { high: number; normal: number; low: number };
  throughput: { lastHour: number; last24Hours: number };
  limits: { globalQueued: number; repositoryQueued: number };
};

type Schedule = {
  id: string;
  key: string;
  name: string;
  state: string;
  payload: {
    kind?: string;
    jobType?: JobType;
    intervalMinutes?: number;
    priority?: number;
    enabled?: boolean;
    nextRunAt?: string | null;
    lastEnqueuedAt?: string | null;
    lastJobId?: string | null;
  } & Record<string, unknown>;
};

type OperationsResponse = {
  jobs: Job[];
  stats: QueueStats;
  schedules: Schedule[];
  repository?: { id: string; namespace: string; slug: string; name?: string };
};

const repositoryTypes: JobType[] = [
  "storage.lifecycle",
  "replication.verify",
  "recovery.drill",
  "alerts.evaluate",
  "notification.deliver",
  "pages.domain.verify",
  "extension.execute",
  "load.test",
  "secret.rotation.audit",
  "failure.probe"
];

const platformTypes: JobType[] = [
  "alerts.evaluate",
  "notification.deliver",
  "database.backup",
  "secret.rotation.audit",
  "load.test",
  "failure.probe"
];

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function stamp(value: string | null | undefined) {
  if (!value) return "—";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

function duration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function displayType(value: string) {
  return value
    .split(/[.-]/g)
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

export default function KoshOperationsPage() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [namespaceDraft, setNamespaceDraft] = useState("");
  const [slugDraft, setSlugDraft] = useState("");
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [stateFilter, setStateFilter] = useState<"all" | JobState>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | JobType>("all");
  const [search, setSearch] = useState("");
  const [jobType, setJobType] = useState<JobType>("alerts.evaluate");
  const [priority, setPriority] = useState(50);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [payloadText, setPayloadText] = useState("{}");
  const [scheduleMode, setScheduleMode] = useState(false);
  const [scheduleKey, setScheduleKey] = useState("");
  const [scheduleName, setScheduleName] = useState("");
  const [scheduleInterval, setScheduleInterval] = useState(60);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextNamespace = params.get("namespace") ?? "";
    const nextSlug = params.get("slug") ?? "";
    setNamespace(nextNamespace);
    setSlug(nextSlug);
    setNamespaceDraft(nextNamespace);
    setSlugDraft(nextSlug);
  }, []);

  const repositoryScope = Boolean(namespace && slug);
  const endpoint = useMemo(() => {
    if (!repositoryScope) return `${base}/v1/kosh/systems/operations`;
    return `${base}/v1/kosh/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/systems/operations`;
  }, [base, namespace, slug, repositoryScope]);

  const allowedTypes = repositoryScope ? repositoryTypes : platformTypes;

  useEffect(() => {
    if (!allowedTypes.includes(jobType)) setJobType(allowedTypes[0]);
  }, [allowedTypes, jobType]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const response = await fetch(`${endpoint}?limit=250`, {
        credentials: "include",
        cache: "no-store"
      });
      const payload = (await response.json().catch(() => ({}))) as OperationsResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error || `Operations returned ${response.status}.`);
      setData(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Operations.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void load(true), 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, load]);

  function selectScope(event: FormEvent) {
    event.preventDefault();
    const nextNamespace = namespaceDraft.trim();
    const nextSlug = slugDraft.trim();
    setNamespace(nextNamespace);
    setSlug(nextSlug);
    const params = new URLSearchParams();
    if (nextNamespace && nextSlug) {
      params.set("namespace", nextNamespace);
      params.set("slug", nextSlug);
    }
    window.history.replaceState(null, "", params.size ? `?${params.toString()}` : window.location.pathname);
  }

  function platformScope() {
    setNamespace("");
    setSlug("");
    setNamespaceDraft("");
    setSlugDraft("");
    window.history.replaceState(null, "", window.location.pathname);
  }

  async function mutate(path: string, body: Record<string, unknown>, success: string) {
    setMutating(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(endpoint + path, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string; retryAfterSeconds?: number };
      if (!response.ok) {
        const retry = payload.retryAfterSeconds ? ` Retry after ${payload.retryAfterSeconds}s.` : "";
        throw new Error((payload.error || `Operation returned ${response.status}.`) + retry);
      }
      setMessage(success);
      await load(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Operation failed.");
    } finally {
      setMutating(false);
    }
  }

  async function submitJob(event: FormEvent) {
    event.preventDefault();
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payloadText || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch {
      setError("Payload must be a JSON object.");
      return;
    }

    const body: Record<string, unknown> = {
      type: jobType,
      payload,
      priority,
      maxAttempts
    };
    if (idempotencyKey.trim()) body.idempotencyKey = idempotencyKey.trim();
    if (scheduleMode) {
      body.schedule = {
        key: scheduleKey.trim() || jobType,
        name: scheduleName.trim() || `Scheduled ${displayType(jobType)}`,
        intervalMinutes: scheduleInterval,
        priority,
        enabled: true
      };
    }
    await mutate("", body, scheduleMode ? "Schedule saved." : "Operation queued.");
  }

  const filteredJobs = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (data?.jobs ?? []).filter((job) => {
      if (stateFilter !== "all" && job.state !== stateFilter) return false;
      if (typeFilter !== "all" && job.type !== typeFilter) return false;
      if (!needle) return true;
      return [job.id, job.type, job.state, job.createdByName, job.error ?? "", job.idempotencyKey ?? ""]
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [data?.jobs, search, stateFilter, typeFilter]);

  const stats = data?.stats;
  const queued = stats?.byState.queued ?? 0;
  const scopeLimit = repositoryScope ? stats?.limits.repositoryQueued ?? 0 : stats?.limits.globalQueued ?? 0;
  const saturation = scopeLimit > 0 ? Math.min(100, queued / scopeLimit * 100) : 0;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <div className={styles.links}>
            <Link href="/apps/kosh">← Kosh</Link>
            <Link href="/apps/kosh/readiness">Readiness</Link>
            <Link href="/apps/kosh/systems">Systems</Link>
          </div>
          <p className={styles.eyebrow}>KOSH OPERATIONS</p>
          <h1>Operations Control Center</h1>
          <p className={styles.lead}>
            Run and observe production work without blocking Gateway requests. Queue state, retries, schedules, dead letters and throughput stay visible in one place.
          </p>
        </div>
        <div className={styles.headerActions}>
          <label className={styles.toggle}>
            <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
            <span>Auto refresh</span>
          </label>
          <button onClick={() => void load()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
        </div>
      </header>

      {error && <div className={styles.error}>{error}</div>}
      {message && <div className={styles.success}>{message}</div>}

      <section className={styles.scopeBar}>
        <div>
          <span>Current scope</span>
          <strong>{repositoryScope ? `${namespace}/${slug}` : "Platform"}</strong>
        </div>
        <form onSubmit={selectScope}>
          <input value={namespaceDraft} onChange={(event) => setNamespaceDraft(event.target.value)} placeholder="namespace" aria-label="Namespace" />
          <span>/</span>
          <input value={slugDraft} onChange={(event) => setSlugDraft(event.target.value)} placeholder="repository" aria-label="Repository" />
          <button type="submit" disabled={!namespaceDraft.trim() || !slugDraft.trim()}>Open repository</button>
          <button type="button" className={styles.secondary} onClick={platformScope}>Platform</button>
        </form>
      </section>

      <section className={styles.statsGrid}>
        <article><span>Queued</span><strong>{stats?.byState.queued ?? "—"}</strong><small>{stats?.retrying ?? 0} retrying</small></article>
        <article><span>Running</span><strong>{stats?.byState.leased ?? "—"}</strong><small>{stats?.backend ?? "queue backend"}</small></article>
        <article><span>Dead letters</span><strong>{stats?.deadLettered ?? "—"}</strong><small>{stats?.byState.failed ?? 0} failed total</small></article>
        <article><span>Throughput / hour</span><strong>{stats?.throughput.lastHour ?? "—"}</strong><small>{stats?.throughput.last24Hours ?? 0} in 24h</small></article>
        <article><span>Oldest queued</span><strong>{duration(stats?.oldestQueuedAgeMs ?? 0)}</strong><small>priority aware</small></article>
        <article><span>Schedules</span><strong>{data?.schedules.length ?? "—"}</strong><small>recurring controls</small></article>
      </section>

      <section className={styles.saturationCard}>
        <div>
          <div><strong>Queue saturation</strong><span>{queued} / {scopeLimit || "—"} queued</span></div>
          <b>{saturation.toFixed(1)}%</b>
        </div>
        <div className={styles.bar}><i style={{ width: `${saturation}%` }} /></div>
        <div className={styles.priorityRow}>
          <span>High <b>{stats?.queuedByPriority.high ?? 0}</b></span>
          <span>Normal <b>{stats?.queuedByPriority.normal ?? 0}</b></span>
          <span>Low <b>{stats?.queuedByPriority.low ?? 0}</b></span>
        </div>
      </section>

      <div className={styles.twoColumn}>
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div><p className={styles.eyebrow}>EXECUTE</p><h2>{scheduleMode ? "Recurring schedule" : "One-off operation"}</h2></div>
            <label className={styles.toggle}>
              <input type="checkbox" checked={scheduleMode} onChange={(event) => setScheduleMode(event.target.checked)} />
              <span>Schedule</span>
            </label>
          </div>
          <form className={styles.form} onSubmit={submitJob}>
            <label><span>Operation</span><select value={jobType} onChange={(event) => setJobType(event.target.value as JobType)}>{allowedTypes.map((type) => <option key={type} value={type}>{displayType(type)}</option>)}</select></label>
            <div className={styles.formRow}>
              <label><span>Priority</span><input type="number" min={0} max={100} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label>
              <label><span>Max attempts</span><input type="number" min={1} max={10} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} /></label>
            </div>
            {!scheduleMode && <label><span>Idempotency key <small>optional</small></span><input value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} maxLength={200} placeholder="deploy-release-2026-10-03" /></label>}
            {scheduleMode && <>
              <div className={styles.formRow}>
                <label><span>Schedule key</span><input value={scheduleKey} onChange={(event) => setScheduleKey(event.target.value)} placeholder="daily-storage" /></label>
                <label><span>Interval minutes</span><input type="number" min={5} max={43200} value={scheduleInterval} onChange={(event) => setScheduleInterval(Number(event.target.value))} /></label>
              </div>
              <label><span>Schedule name</span><input value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} placeholder={`Scheduled ${displayType(jobType)}`} /></label>
            </>}
            <label><span>Payload JSON</span><textarea value={payloadText} onChange={(event) => setPayloadText(event.target.value)} spellCheck={false} rows={8} /></label>
            <button type="submit" disabled={mutating}>{mutating ? "Submitting…" : scheduleMode ? "Save schedule" : "Queue operation"}</button>
          </form>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHead}><div><p className={styles.eyebrow}>SCHEDULES</p><h2>Recurring operations</h2></div><span className={styles.count}>{data?.schedules.length ?? 0}</span></div>
          <div className={styles.scheduleList}>
            {(data?.schedules ?? []).length ? data!.schedules.map((schedule) => (
              <article key={schedule.id}>
                <div><strong>{schedule.name}</strong><span>{schedule.payload.jobType ? displayType(schedule.payload.jobType) : "Unknown operation"}</span></div>
                <div className={styles.scheduleMeta}>
                  <span>{schedule.state}</span>
                  <span>Every {schedule.payload.intervalMinutes ?? "—"}m</span>
                  <span>Priority {schedule.payload.priority ?? 50}</span>
                  <span>Next {stamp(schedule.payload.nextRunAt)}</span>
                </div>
              </article>
            )) : <div className={styles.empty}>No recurring operations in this scope.</div>}
          </div>
        </section>
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <div><p className={styles.eyebrow}>QUEUE</p><h2>Operation history</h2></div>
          <span className={styles.count}>{filteredJobs.length} shown</span>
        </div>
        <div className={styles.filters}>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search job id, type, actor, error or idempotency key" />
          <select value={stateFilter} onChange={(event) => setStateFilter(event.target.value as "all" | JobState)}>
            <option value="all">All states</option>
            {(["queued", "leased", "succeeded", "failed", "cancelled"] as JobState[]).map((state) => <option key={state} value={state}>{state}</option>)}
          </select>
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as "all" | JobType)}>
            <option value="all">All operations</option>
            {allowedTypes.map((type) => <option key={type} value={type}>{displayType(type)}</option>)}
          </select>
        </div>
        <div className={styles.jobList}>
          {filteredJobs.length ? filteredJobs.map((job) => (
            <article className={styles.job} key={job.id}>
              <div className={styles.jobMain}>
                <div className={styles.jobTitle}>
                  <span className={`${styles.state} ${styles[job.state]}`}>{job.state}</span>
                  <strong>{displayType(job.type)}</strong>
                  {job.deadLetteredAt && <em>dead letter</em>}
                </div>
                <code>{job.id}</code>
                <div className={styles.jobMeta}>
                  <span>Priority {job.priority}</span>
                  <span>Attempt {job.attempt}/{job.maxAttempts}</span>
                  <span>Created {stamp(job.createdAt)}</span>
                  <span>By {job.createdByName}</span>
                  {job.idempotencyKey && <span>Key {job.idempotencyKey}</span>}
                  {job.leaseOwner && <span>Worker {job.leaseOwner}</span>}
                </div>
                {job.error && <p className={styles.jobError}>{job.error}</p>}
                {(Object.keys(job.payload).length > 0 || job.result) && (
                  <details>
                    <summary>Payload / result</summary>
                    <pre>{compactJson({ payload: job.payload, result: job.result })}</pre>
                  </details>
                )}
              </div>
              <div className={styles.jobActions}>
                {(job.state === "queued" || job.state === "leased") && <button className={styles.danger} disabled={mutating} onClick={() => void mutate("/cancel", { id: job.id }, "Operation cancelled.")}>Cancel</button>}
                {job.state === "failed" && <button disabled={mutating} onClick={() => void mutate("/requeue", { id: job.id }, "Dead-letter operation requeued.")}>Requeue</button>}
              </div>
            </article>
          )) : <div className={styles.empty}>No operations match the current filters.</div>}
        </div>
      </section>
    </main>
  );
}
