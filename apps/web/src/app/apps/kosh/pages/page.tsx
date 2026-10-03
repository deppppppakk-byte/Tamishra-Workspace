"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./pages.module.css";

type Site = {
  id: string;
  state: string;
  sourceBranch: string;
  sourcePath: string;
  indexFile: string;
  spaFallback: boolean;
  cacheSeconds: number;
  activeDeploymentId: string | null;
  updatedAt: string;
};

type Deployment = {
  id: string;
  commitSha: string;
  sourceBranch: string;
  sourcePath: string;
  indexFile: string;
  spaFallback: boolean;
  fileCount: number;
  totalBytes: number;
  publishedByName: string;
  publishedAt: string;
};

type PagesResponse = {
  site: Site | null;
  activeDeployment: Deployment | null;
  deployments: Deployment[];
  publicUrl: string;
  limits: {
    maxFileBytes: number;
    maxSiteBytes: number;
    maxFiles: number;
  };
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function bytes(value: number) {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + " MB";
  return (value / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function when(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d ago";
  return new Date(value).toLocaleDateString();
}

export default function KoshPagesWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [data, setData] = useState<PagesResponse | null>(null);
  const [sourceBranch, setSourceBranch] = useState("main");
  const [sourcePath, setSourcePath] = useState("");
  const [indexFile, setIndexFile] = useState("index.html");
  const [spaFallback, setSpaFallback] = useState(false);
  const [cacheSeconds, setCacheSeconds] = useState("60");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() || "");
    setSlug(params.get("slug")?.trim() || "");
  }, []);

  const endpoint = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug) +
      "/pages"
    );
  }, [base, namespace, slug]);

  const request = useCallback(async <T,>(url: string, init?: RequestInit) => {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...init,
      headers:
        init?.body === undefined
          ? init?.headers
          : { "content-type": "application/json", ...(init.headers || {}) }
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Kosh Pages request failed.");
    return payload;
  }, []);

  const apply = useCallback((payload: PagesResponse) => {
    setData(payload);
    if (payload.site) {
      setSourceBranch(payload.site.sourceBranch);
      setSourcePath(payload.site.sourcePath);
      setIndexFile(payload.site.indexFile);
      setSpaFallback(payload.site.spaFallback);
      setCacheSeconds(String(payload.site.cacheSeconds));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!endpoint) return;
    setError("");
    try {
      apply(await request<PagesResponse>(endpoint));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Pages.");
    }
  }, [apply, endpoint, request]);

  useEffect(() => {
    if (!endpoint) return;
    void refresh();
  }, [endpoint]);

  async function save() {
    if (!endpoint) return;
    setBusy(true);
    setError("");
    try {
      apply(
        await request<PagesResponse>(endpoint, {
          method: "PUT",
          body: JSON.stringify({
            sourceBranch: sourceBranch.trim(),
            sourcePath: sourcePath.trim(),
            indexFile: indexFile.trim(),
            spaFallback,
            cacheSeconds: Number(cacheSeconds)
          })
        })
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save Pages configuration.");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!endpoint) return;
    setBusy(true);
    setError("");
    try {
      const saved = await request<PagesResponse>(endpoint, {
        method: "PUT",
        body: JSON.stringify({
          sourceBranch: sourceBranch.trim(),
          sourcePath: sourcePath.trim(),
          indexFile: indexFile.trim(),
          spaFallback,
          cacheSeconds: Number(cacheSeconds)
        })
      });
      apply(saved);
      apply(await request<PagesResponse>(endpoint + "/publish", { method: "POST" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Pages publish failed.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!endpoint) return;
    setBusy(true);
    setError("");
    try {
      apply(await request<PagesResponse>(endpoint + "/disable", { method: "POST" }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not disable Pages.");
    } finally {
      setBusy(false);
    }
  }

  async function activate(deploymentId: string) {
    if (!endpoint) return;
    setBusy(true);
    setError("");
    try {
      apply(
        await request<PagesResponse>(
          endpoint + "/deployments/" + encodeURIComponent(deploymentId) + "/activate",
          { method: "POST" }
        )
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not activate deployment.");
    } finally {
      setBusy(false);
    }
  }

  async function copyUrl() {
    if (!data?.publicUrl) return;
    try {
      await navigator.clipboard.writeText(data.publicUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Clipboard access is unavailable.");
    }
  }

  const activeId = data?.activeDeployment?.id || null;
  const active = data?.site?.state === "active" && data.activeDeployment;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link
            className={styles.back}
            href={
              namespace && slug
                ? "/apps/kosh/repository?namespace=" + encodeURIComponent(namespace) + "&slug=" + encodeURIComponent(slug)
                : "/apps/kosh"
            }
          >
            ← Repository
          </Link>
          <p className={styles.eyebrow}>KOSH PAGES</p>
          <h1>Publish static sites from exact commits.</h1>
          <p className={styles.subtitle}>Configure the source once, publish deliberately, and roll back without moving the repository branch.</p>
        </div>
        <div className={styles.repoBadge}>{namespace && slug ? namespace + "/" + slug : "Repository required"}</div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.statusGrid}>
        <article className={styles.statusCard}>
          <span>Site state</span>
          <strong className={active ? styles.online : styles.offline}>{data?.site?.state || "not configured"}</strong>
          <small>{active ? "Serving pinned deployment" : "No active public deployment"}</small>
        </article>
        <article className={styles.statusCard}>
          <span>Active commit</span>
          <strong className={styles.mono}>{data?.activeDeployment?.commitSha.slice(0, 12) || "—"}</strong>
          <small>{data?.activeDeployment ? data.activeDeployment.sourceBranch : "Publish to pin a commit"}</small>
        </article>
        <article className={styles.statusCard}>
          <span>Deployment size</span>
          <strong>{data?.activeDeployment ? bytes(data.activeDeployment.totalBytes) : "—"}</strong>
          <small>{data?.activeDeployment ? data.activeDeployment.fileCount + " files" : "Validated at publish time"}</small>
        </article>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div><span>PUBLIC URL</span><h2>Published site</h2></div>
          <div className={styles.actions}>
            {data?.site?.state === "active" && <button className={styles.secondary} disabled={busy} onClick={() => void disable()}>Disable</button>}
            <button className={styles.primary} disabled={busy || !endpoint} onClick={() => void publish()}>{busy ? "Working…" : "Publish now"}</button>
          </div>
        </div>
        <div className={styles.urlBox}>
          <code>{data?.publicUrl || "Pages URL will appear here"}</code>
          <button disabled={!data?.publicUrl} onClick={() => void copyUrl()}>{copied ? "Copied" : "Copy"}</button>
          {data?.publicUrl && <a href={data.publicUrl} target="_blank" rel="noreferrer">Open ↗</a>}
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div><span>SOURCE</span><h2>Publishing configuration</h2></div>
          <button className={styles.secondary} disabled={busy || !endpoint} onClick={() => void save()}>Save configuration</button>
        </div>
        <div className={styles.formGrid}>
          <label>Branch<input value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} placeholder="main" /></label>
          <label>Source folder<input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} placeholder="dist or leave empty" /></label>
          <label>Index file<input value={indexFile} onChange={(event) => setIndexFile(event.target.value)} placeholder="index.html" /></label>
          <label>Public cache seconds<input value={cacheSeconds} onChange={(event) => setCacheSeconds(event.target.value)} inputMode="numeric" /></label>
          <label className={styles.toggle}>
            <input type="checkbox" checked={spaFallback} onChange={(event) => setSpaFallback(event.target.checked)} />
            <span><strong>Single-page app fallback</strong><small>Unknown browser routes serve the configured index file.</small></span>
          </label>
        </div>
        {data?.limits && (
          <div className={styles.limits}>
            <span>Max file {bytes(data.limits.maxFileBytes)}</span>
            <span>Max site {bytes(data.limits.maxSiteBytes)}</span>
            <span>Max files {data.limits.maxFiles.toLocaleString()}</span>
          </div>
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelHead}>
          <div><span>HISTORY</span><h2>Deployments</h2></div>
          <strong className={styles.count}>{data?.deployments.length || 0}</strong>
        </div>
        <div className={styles.deployments}>
          {!data?.deployments.length && <div className={styles.empty}>No Pages deployment has been published yet.</div>}
          {data?.deployments.map((deployment) => {
            const isActive = deployment.id === activeId && data.site?.state === "active";
            return (
              <article className={isActive ? styles.deploymentActive : styles.deployment} key={deployment.id}>
                <div className={styles.deployMain}>
                  <div className={styles.commitMark}>{deployment.commitSha.slice(0, 2)}</div>
                  <div>
                    <div className={styles.deployTitle}>
                      <strong>{deployment.sourceBranch}</strong>
                      <code>{deployment.commitSha.slice(0, 12)}</code>
                      {isActive && <em>live</em>}
                    </div>
                    <p>{deployment.sourcePath ? deployment.sourcePath + "/" : "/"}{deployment.indexFile}</p>
                    <small>{deployment.publishedByName} · {when(deployment.publishedAt)}</small>
                  </div>
                </div>
                <div className={styles.deployMeta}>
                  <span>{deployment.fileCount} files</span>
                  <span>{bytes(deployment.totalBytes)}</span>
                  {!isActive && <button className={styles.secondary} disabled={busy} onClick={() => void activate(deployment.id)}>Activate</button>}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
