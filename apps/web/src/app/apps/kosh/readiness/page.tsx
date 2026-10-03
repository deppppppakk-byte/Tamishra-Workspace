"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./readiness.module.css";

type Status = "ready" | "degraded" | "not_ready";
type CheckStatus = "pass" | "warn" | "fail";

type Check = {
  id: string;
  status: CheckStatus;
  detail: string;
};

type PlatformReadiness = {
  status: Status;
  passing: number;
  warnings: number;
  failures: number;
  scope: "platform";
  production: boolean;
  persistence: string;
  checkedAt: string;
  checks: Check[];
  evidence: {
    repositories: number;
    recentAuditEvents: number;
  };
};

type RepositoryReadiness = {
  repository: {
    id: string;
    namespace: string;
    slug: string;
    state: string;
  };
  status: Status;
  passing: number;
  warnings: number;
  failures: number;
  scope: "repository";
  checkedAt: string;
  checks: Check[];
  storage: {
    usage: {
      packageBytes: number;
      releaseBytes: number;
      artifactBytes: number;
      backupBytes: number;
      knownBytes: number;
    };
    limits: {
      maxTotalBytes: number;
      maxArtifactBytes: number;
      maxPackageBytes: number;
      maxReleaseBytes: number;
      maxBackupBytes: number;
    };
    ratio: number;
  };
  recovery: {
    restorePoints: number;
    verifiedRestorePoints: number;
    invalidRestorePoints: number;
    latestVerifiedAt: string | null;
  };
  activity: {
    recentAuditEvents: number;
    automationRuns: number;
    runningAutomationRuns: number;
    failedAutomationRuns: number;
    deployments: number;
    runningDeployments: number;
    failedDeployments: number;
    mergeQueueEntries: number;
    processingMergeQueueEntries: number;
    failedMergeQueueEntries: number;
  };
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function stamp(value: string | null) {
  if (!value) return "No verified restore yet";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function title(value: string) {
  return value
    .split("-")
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(" ");
}

function StatusBadge({ status }: { status: Status }) {
  return <span className={`${styles.badge} ${styles[status]}`}>{status.replace("_", " ")}</span>;
}

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <div className={styles.checks}>
      {checks.map((check) => (
        <div className={styles.check} key={check.id}>
          <span className={`${styles.dot} ${styles[check.status]}`} aria-hidden="true" />
          <div>
            <strong>{title(check.id)}</strong>
            <p>{check.detail}</p>
          </div>
          <em>{check.status}</em>
        </div>
      ))}
    </div>
  );
}

export default function KoshReadinessPage() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [namespaceDraft, setNamespaceDraft] = useState("");
  const [slugDraft, setSlugDraft] = useState("");
  const [platform, setPlatform] = useState<PlatformReadiness | null>(null);
  const [platformRestricted, setPlatformRestricted] = useState(false);
  const [repository, setRepository] = useState<RepositoryReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextNamespace = params.get("namespace") ?? "";
    const nextSlug = params.get("slug") ?? "";
    setNamespace(nextNamespace);
    setSlug(nextSlug);
    setNamespaceDraft(nextNamespace);
    setSlugDraft(nextSlug);
  }, []);

  const repositoryEndpoint = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug) +
      "/systems/readiness"
    );
  }, [base, namespace, slug]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const platformResponse = await fetch(base + "/v1/kosh/systems/readiness", {
        credentials: "include",
        cache: "no-store"
      });
      if (platformResponse.ok) {
        setPlatform((await platformResponse.json()) as PlatformReadiness);
        setPlatformRestricted(false);
      } else if (platformResponse.status === 401 || platformResponse.status === 403) {
        setPlatform(null);
        setPlatformRestricted(true);
      } else {
        const payload = (await platformResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `Platform readiness returned ${platformResponse.status}.`);
      }

      if (repositoryEndpoint) {
        const response = await fetch(repositoryEndpoint, {
          credentials: "include",
          cache: "no-store"
        });
        const payload = (await response.json()) as RepositoryReadiness & { error?: string };
        if (!response.ok) {
          throw new Error(payload.error || `Repository readiness returned ${response.status}.`);
        }
        setRepository(payload);
      } else {
        setRepository(null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh readiness.");
    } finally {
      setLoading(false);
    }
  }, [base, repositoryEndpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  function selectRepository(event: FormEvent) {
    event.preventDefault();
    const nextNamespace = namespaceDraft.trim();
    const nextSlug = slugDraft.trim();
    setNamespace(nextNamespace);
    setSlug(nextSlug);
    const params = new URLSearchParams();
    if (nextNamespace) params.set("namespace", nextNamespace);
    if (nextSlug) params.set("slug", nextSlug);
    window.history.replaceState(null, "", params.size ? `?${params.toString()}` : window.location.pathname);
  }

  const storagePercent = repository
    ? Math.max(0, Math.min(100, repository.storage.ratio * 100))
    : 0;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <div className={styles.links}>
            <Link href="/apps/kosh">← Kosh</Link>
            <Link href="/apps/kosh/systems">Systems</Link>
          </div>
          <p className={styles.eyebrow}>KOSH OPERATIONS</p>
          <h1>Readiness</h1>
          <p className={styles.lead}>
            Evidence-backed production posture for Kosh itself and for each repository. Process liveness alone does not count as readiness.
          </p>
        </div>
        <button className={styles.refresh} onClick={() => void load()} disabled={loading}>
          {loading ? "Checking…" : "Refresh evidence"}
        </button>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.selector}>
        <div>
          <strong>Repository evidence</strong>
          <span>Open a repository by namespace and slug.</span>
        </div>
        <form onSubmit={selectRepository}>
          <input
            value={namespaceDraft}
            onChange={(event) => setNamespaceDraft(event.target.value)}
            placeholder="namespace"
            aria-label="Repository namespace"
          />
          <span>/</span>
          <input
            value={slugDraft}
            onChange={(event) => setSlugDraft(event.target.value)}
            placeholder="repository"
            aria-label="Repository slug"
          />
          <button type="submit">Inspect</button>
        </form>
      </section>

      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div>
              <p className={styles.eyebrow}>PLATFORM</p>
              <h2>Kosh control plane</h2>
            </div>
            {platform && <StatusBadge status={platform.status} />}
          </div>

          {platform ? (
            <>
              <div className={styles.metrics}>
                <div><strong>{platform.passing}</strong><span>passing</span></div>
                <div><strong>{platform.warnings}</strong><span>warnings</span></div>
                <div><strong>{platform.failures}</strong><span>failures</span></div>
                <div><strong>{platform.evidence.repositories}</strong><span>repositories</span></div>
              </div>
              <div className={styles.meta}>
                <span>{platform.production ? "Production mode" : "Development mode"}</span>
                <span>{platform.persistence}</span>
                <span>Checked {stamp(platform.checkedAt)}</span>
              </div>
              <CheckList checks={platform.checks} />
            </>
          ) : platformRestricted ? (
            <div className={styles.empty}>
              <strong>Platform readiness is administrator-only.</strong>
              <p>Repository readiness remains available below when you have repository read access.</p>
            </div>
          ) : (
            <div className={styles.empty}>Loading platform readiness…</div>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div>
              <p className={styles.eyebrow}>REPOSITORY</p>
              <h2>{repository ? `${repository.repository.namespace}/${repository.repository.slug}` : "Repository readiness"}</h2>
            </div>
            {repository && <StatusBadge status={repository.status} />}
          </div>

          {repository ? (
            <>
              <div className={styles.metrics}>
                <div><strong>{repository.passing}</strong><span>passing</span></div>
                <div><strong>{repository.warnings}</strong><span>warnings</span></div>
                <div><strong>{repository.failures}</strong><span>failures</span></div>
                <div><strong>{repository.repository.state}</strong><span>repository state</span></div>
              </div>

              <div className={styles.storage}>
                <div className={styles.storageHead}>
                  <div><strong>Known storage</strong><span>{formatBytes(repository.storage.usage.knownBytes)} of {formatBytes(repository.storage.limits.maxTotalBytes)}</span></div>
                  <b>{storagePercent.toFixed(1)}%</b>
                </div>
                <div className={styles.bar}><i style={{ width: `${storagePercent}%` }} /></div>
                <div className={styles.storageBreakdown}>
                  <span>Packages <b>{formatBytes(repository.storage.usage.packageBytes)}</b></span>
                  <span>Releases <b>{formatBytes(repository.storage.usage.releaseBytes)}</b></span>
                  <span>Artifacts <b>{formatBytes(repository.storage.usage.artifactBytes)}</b></span>
                  <span>Recovery <b>{formatBytes(repository.storage.usage.backupBytes)}</b></span>
                </div>
              </div>

              <div className={styles.evidenceGrid}>
                <article>
                  <span>Verified restore points</span>
                  <strong>{repository.recovery.verifiedRestorePoints}</strong>
                  <small>{stamp(repository.recovery.latestVerifiedAt)}</small>
                </article>
                <article>
                  <span>Failed automation</span>
                  <strong>{repository.activity.failedAutomationRuns}</strong>
                  <small>{repository.activity.runningAutomationRuns} running</small>
                </article>
                <article>
                  <span>Failed deployments</span>
                  <strong>{repository.activity.failedDeployments}</strong>
                  <small>{repository.activity.runningDeployments} running</small>
                </article>
                <article>
                  <span>Merge queue failures</span>
                  <strong>{repository.activity.failedMergeQueueEntries}</strong>
                  <small>{repository.activity.processingMergeQueueEntries} processing</small>
                </article>
              </div>

              <CheckList checks={repository.checks} />
            </>
          ) : (
            <div className={styles.empty}>
              <strong>Select a repository to inspect its evidence.</strong>
              <p>Use the namespace/repository selector above or open this page with query parameters.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
