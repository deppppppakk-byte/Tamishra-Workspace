"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./security.module.css";

type Severity = "low" | "medium" | "high" | "critical";
type FindingState = "open" | "acknowledged" | "resolved" | "ignored";

type Finding = {
  id: string;
  scanner: string;
  ruleId: string;
  title: string;
  severity: Severity;
  state: FindingState;
  path: string;
  line: number | null;
  message: string;
  note: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
};

type Scan = {
  id: string;
  commitSha: string;
  scanners: string[];
  counts: Record<string, number>;
  createdByName: string;
  startedAt: string;
  completedAt: string;
};

type Summary = {
  state: "clear" | "watch" | "degraded" | "critical";
  counts: Record<string, number>;
  latestScan: Scan | null;
  sbom: {
    commitSha: string;
    format: string;
    generatedAt: string;
    componentCount: number;
  } | null;
};

type SecurityPayload = {
  summary: Summary;
  findings: Finding[];
  scans: Scan[];
};

type AccessPayload = {
  role: string | null;
  permissions: string[];
};

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100";
  return configured.replace(/\/$/, "");
}

function age(value: string | null) {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";
  return Math.floor(hours / 24) + "d";
}

export function KoshSecurityWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [payload, setPayload] = useState<SecurityPayload | null>(null);
  const [access, setAccess] = useState<AccessPayload | null>(null);
  const [filter, setFilter] = useState<"active" | FindingState | "all">("active");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() ?? "");
    setSlug(params.get("slug")?.trim() ?? "");
  }, []);

  const repositoryBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug)
    );
  }, [base, namespace, slug]);

  const repositoryHref = useMemo(() => {
    if (!namespace || !slug) return "/apps/kosh";
    return (
      "/apps/kosh/repository?namespace=" +
      encodeURIComponent(namespace) +
      "&slug=" +
      encodeURIComponent(slug)
    );
  }, [namespace, slug]);

  const fetchJson = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store"
    });
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error || "Kosh request failed.");
    return body;
  }, []);

  const mutateJson = useCallback(
    async <T,>(url: string, method: "POST" | "PATCH", body?: unknown) => {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers:
          body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = (await response.json()) as T & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Kosh request failed.");
      }
      return payload;
    },
    []
  );

  const load = useCallback(async () => {
    if (!repositoryBase) return;
    setLoading(true);
    setError("");
    try {
      const [security, nextAccess] = await Promise.all([
        fetchJson<SecurityPayload>(repositoryBase + "/security"),
        fetchJson<AccessPayload>(repositoryBase + "/access")
      ]);
      setPayload(security);
      setAccess(nextAccess);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load Security."
      );
    } finally {
      setLoading(false);
    }
  }, [fetchJson, repositoryBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const canManage = Boolean(access?.permissions.includes("security.manage"));

  async function runScan() {
    if (!repositoryBase || !canManage) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(repositoryBase + "/security/scan", "POST");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Security scan failed.");
    } finally {
      setMutating(false);
    }
  }

  async function updateFinding(finding: Finding, state: FindingState) {
    if (!repositoryBase || !canManage) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        repositoryBase +
          "/security/findings/" +
          encodeURIComponent(finding.id),
        "PATCH",
        {
          state,
          note:
            state === "ignored"
              ? "Ignored from Kosh Security workspace."
              : ""
        }
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Finding update failed."
      );
    } finally {
      setMutating(false);
    }
  }

  if (loading && !payload) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Security</strong>
        <span>Reading repository security state…</span>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className={styles.loading}>
        <strong>Security unavailable</strong>
        <span>{error || "No repository security data is available."}</span>
        <Link href={repositoryHref}>Back to repository</Link>
      </main>
    );
  }

  const findings = payload.findings.filter((finding) => {
    if (filter === "all") return true;
    if (filter === "active") {
      return finding.state === "open" || finding.state === "acknowledged";
    }
    return finding.state === filter;
  });

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH SECURITY</p>
          <h1>
            {namespace}/{slug}
          </h1>
          <span>
            Repository-native secret detection, dependency policy, durable
            findings and software inventory.
          </span>
        </div>

        <div className={styles.headerActions}>
          <div className={styles.stateCard}>
            <span>SECURITY STATE</span>
            <strong className={styles["state_" + payload.summary.state]}>
              {payload.summary.state}
            </strong>
            <em>
              {payload.summary.counts.active || 0} active findings
            </em>
          </div>
          <button
            disabled={!canManage || mutating}
            onClick={() => void runScan()}
          >
            {mutating ? "Working…" : "Run security scan"}
          </button>
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        <section className={styles.stats}>
          <div><span>Critical</span><strong>{payload.summary.counts.critical || 0}</strong></div>
          <div><span>High</span><strong>{payload.summary.counts.high || 0}</strong></div>
          <div><span>Medium</span><strong>{payload.summary.counts.medium || 0}</strong></div>
          <div><span>Low</span><strong>{payload.summary.counts.low || 0}</strong></div>
          <div><span>Resolved</span><strong>{payload.summary.counts.resolved || 0}</strong></div>
        </section>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Latest scan</strong>
                <span>Secret exposure + dependency policy</span>
              </div>
            </div>
            {payload.summary.latestScan ? (
              <div className={styles.scanCard}>
                <strong>
                  {payload.summary.latestScan.commitSha.slice(0, 12)}
                </strong>
                <span>
                  {payload.summary.latestScan.scanners.join(" · ")}
                </span>
                <small>
                  {payload.summary.latestScan.createdByName} ·{" "}
                  {age(payload.summary.latestScan.completedAt)}
                </small>
              </div>
            ) : (
              <div className={styles.empty}>No security scan has run yet.</div>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Kosh SBOM</strong>
                <span>Declared software components for the scanned commit</span>
              </div>
            </div>
            {payload.summary.sbom ? (
              <div className={styles.scanCard}>
                <strong>{payload.summary.sbom.componentCount} components</strong>
                <span>{payload.summary.sbom.format}</span>
                <small>
                  {payload.summary.sbom.commitSha.slice(0, 12)} ·{" "}
                  {age(payload.summary.sbom.generatedAt)}
                </small>
                <a
                  href={repositoryBase + "/security/sbom"}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open SBOM JSON →
                </a>
              </div>
            ) : (
              <div className={styles.empty}>SBOM appears after the first scan.</div>
            )}
          </section>
        </div>

        <section className={styles.panel}>
          <div className={styles.findingHeader}>
            <div>
              <strong>Findings</strong>
              <span>Secret values are never stored in finding metadata.</span>
            </div>
            <select
              value={filter}
              onChange={(event) =>
                setFilter(event.target.value as typeof filter)
              }
            >
              <option value="active">Active</option>
              <option value="open">Open</option>
              <option value="acknowledged">Acknowledged</option>
              <option value="resolved">Resolved</option>
              <option value="ignored">Ignored</option>
              <option value="all">All</option>
            </select>
          </div>

          <div className={styles.findings}>
            {findings.map((finding) => (
              <article key={finding.id}>
                <span className={styles[finding.severity]}>
                  {finding.severity}
                </span>
                <div>
                  <strong>{finding.title}</strong>
                  <small>
                    {finding.scanner} · {finding.ruleId} · {finding.state}
                  </small>
                  <p>{finding.message}</p>
                  <code>
                    {finding.path}
                    {finding.line ? ":" + finding.line : ""}
                  </code>
                </div>
                {canManage ? (
                  <select
                    value={finding.state}
                    disabled={mutating}
                    onChange={(event) =>
                      void updateFinding(
                        finding,
                        event.target.value as FindingState
                      )
                    }
                  >
                    <option value="open">Open</option>
                    <option value="acknowledged">Acknowledged</option>
                    <option value="resolved">Resolved</option>
                    <option value="ignored">Ignored</option>
                  </select>
                ) : (
                  <em>{finding.state}</em>
                )}
              </article>
            ))}
            {!findings.length && (
              <div className={styles.empty}>No findings in this view.</div>
            )}
          </div>
        </section>

        {!canManage && (
          <div className={styles.notice}>
            Your repository role can read security state but does not include
            <code> security.manage</code>.
          </div>
        )}
      </section>
    </main>
  );
}
