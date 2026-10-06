"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  koshModules,
  normalizeKoshSlug,
  type KoshRepository,
  type KoshRepositoryVisibility
} from "@tamishra/kosh-core";
import styles from "./kosh.module.css";

type RepositoryListResponse = {
  repositories: KoshRepository[];
  persistence?: string;
  gitStorage?: string;
};

type GatewayHealth = {
  service?: string;
  status?: string;
  version?: string;
  mode?: string;
  persistence?: string;
};

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "/api/workspace";

  return configured.replace(/\/$/, "");
}

function koshRequestError(status: number, fallback: string, error?: string) {
  if (status === 502 || status === 503 || status === 504) {
    return "Kosh online gateway is temporarily unavailable. Retry in a moment.";
  }
  return error || fallback;
}

export function KoshWorkspace() {
  const [repositories, setRepositories] = useState<KoshRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState("");
  const [persistence, setPersistence] = useState("");
  const [gitStorage, setGitStorage] = useState("");
  const [gateway, setGateway] = useState<GatewayHealth | null>(null);
  const [namespace, setNamespace] = useState("tamishra");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<KoshRepositoryVisibility>("private");

  const base = useMemo(apiBase, []);

  const requireSignIn = useCallback(() => {
    const returnTo = window.location.pathname + window.location.search;
    window.location.assign("/sign-in?redirect_url=" + encodeURIComponent(returnTo));
  }, []);

  const loadGatewayHealth = useCallback(async () => {
    try {
      const response = await fetch(base + "/health", {
        credentials: "include",
        cache: "no-store"
      });
      if (!response.ok) return;
      const payload = (await response.json()) as GatewayHealth;
      setGateway(payload);
    } catch {
      setGateway(null);
    }
  }, [base]);

  const loadRepositories = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(base + "/v1/kosh/repos", {
        credentials: "include",
        cache: "no-store"
      });
      if (response.status === 401) {
        requireSignIn();
        return;
      }
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(
          koshRequestError(
            response.status,
            "Kosh request failed with status " + response.status + ".",
            payload.error
          )
        );
      }
      const payload = (await response.json()) as RepositoryListResponse;
      setRepositories(payload.repositories ?? []);
      setPersistence(payload.persistence ?? "");
      setGitStorage(payload.gitStorage ?? "");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not connect to the Kosh online gateway."
      );
    } finally {
      setLoading(false);
    }
  }, [base, requireSignIn]);

  useEffect(() => {
    void Promise.all([loadGatewayHealth(), loadRepositories()]);
  }, [loadGatewayHealth, loadRepositories]);

  async function createRepository(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError("");

    try {
      const response = await fetch(base + "/v1/kosh/repos", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          namespace: namespace.trim(),
          name: name.trim(),
          description: description.trim(),
          visibility
        })
      });

      if (response.status === 401) {
        requireSignIn();
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as
        | KoshRepository
        | { error?: string };
      if (!response.ok) {
        const payloadError =
          "error" in payload && payload.error ? payload.error : undefined;
        throw new Error(
          koshRequestError(response.status, "Repository creation failed.", payloadError)
        );
      }

      setName("");
      setDescription("");
      setCreateOpen(false);
      await loadRepositories();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Repository creation failed.");
    } finally {
      setCreating(false);
    }
  }

  async function copyCloneUrl(value: string) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      setError("Clipboard access is unavailable. Select and copy the clone URL manually.");
    }
  }

  const activeModules = koshModules.filter((module) => module.status === "active").length;
  const gatewayOnline = gateway?.status === "ok";

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.back}>← Tamishra Workspace</Link>
        <div className={styles.brand}>
          <div className={styles.brandMark}>K</div>
          <div><strong>Kosh</strong><span>Development platform</span></div>
        </div>

        <nav className={styles.nav}>
          <a className={styles.active} href="#overview">Overview</a>
          <a href="#repositories">Repositories</a>
          <Link href="/apps/kosh/mesh">Mesh</Link>
          <Link href="/apps/kosh/pulse">Pulse</Link>
          <Link href="/apps/kosh/readiness">Readiness</Link>
          <Link href="/apps/kosh/operations">Operations</Link>
          <Link href="/apps/kosh/access">Access</Link>
          <Link href="/apps/kosh/api">API & CLI</Link>
          <a href="#platform">Platform</a>
          <a href="#infrastructure">Infrastructure</a>
        </nav>

        <div className={styles.sidebarNote}>
          <strong>Online-native Kosh</strong>
          <p>Git stays compatible while Kosh provides repository hosting, reviews, automation, releases and platform operations.</p>
        </div>
      </aside>

      <section className={styles.content}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>KOSH BY TAMISHRA</p>
            <h1>Build. Version. Collaborate. Deploy.</h1>
          </div>
          <button className={styles.primary} onClick={() => setCreateOpen(true)}>
            + New repository
          </button>
        </header>

        <section id="overview" className={styles.hero}>
          <div>
            <span className={styles.badge}>Online Git-compatible platform</span>
            <h2>A development platform built the Kosh way.</h2>
            <p>
              Kosh connects repository work through Flow, systems through Mesh,
              and live health plus impact through Pulse — all from the online gateway.
            </p>
          </div>
          <div className={styles.heroStats}>
            <div><strong>{loading ? "—" : repositories.length}</strong><span>repositories</span></div>
            <div><strong>{activeModules}</strong><span>active core modules</span></div>
            <div><strong>{gatewayOnline ? "Online" : "Checking"}</strong><span>gateway</span></div>
          </div>
        </section>

        {gatewayOnline && (
          <section className={styles.infrastructure}>
            <div>
              <p className={styles.eyebrow}>KOSH ONLINE</p>
              <h2>Gateway connected.</h2>
              <p>
                Kosh is running through Tamishra&apos;s online gateway on Vercel.
                No local host PC is required to open or manage repositories.
              </p>
            </div>
            <dl>
              <div><dt>Status</dt><dd>Online</dd></div>
              <div><dt>Gateway</dt><dd>{gateway?.version || "0.9.0"}</dd></div>
              <div><dt>Mode</dt><dd>{gateway?.mode || "core"}</dd></div>
            </dl>
          </section>
        )}

        {error && (
          <div className={styles.error}>
            <strong>Kosh status</strong>
            <span>{error}</span>
            <button onClick={() => void Promise.all([loadGatewayHealth(), loadRepositories()])}>Retry</button>
          </div>
        )}

        {createOpen && (
          <section className={styles.createPanel}>
            <div className={styles.createHeading}>
              <div><p className={styles.eyebrow}>CREATE</p><h2>New repository</h2></div>
              <button className={styles.iconButton} onClick={() => setCreateOpen(false)} aria-label="Close">×</button>
            </div>
            <form onSubmit={createRepository} className={styles.formGrid}>
              <label>
                <span>Namespace</span>
                <input value={namespace} onChange={(event) => setNamespace(event.target.value)} required maxLength={64} />
              </label>
              <label>
                <span>Repository name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={100} placeholder="kavyn-2d" />
                {name && <small>Slug: {normalizeKoshSlug(name) || "invalid"}</small>}
              </label>
              <label className={styles.wide}>
                <span>Description</span>
                <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={500} placeholder="What is this project for?" />
              </label>
              <label>
                <span>Visibility</span>
                <select value={visibility} onChange={(event) => setVisibility(event.target.value as KoshRepositoryVisibility)}>
                  <option value="private">Private</option>
                  <option value="internal">Internal</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <div className={styles.formActions}>
                <button type="button" className={styles.secondary} onClick={() => setCreateOpen(false)}>Cancel</button>
                <button type="submit" className={styles.primary} disabled={creating || !normalizeKoshSlug(name)}>
                  {creating ? "Creating…" : "Create repository"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section id="repositories" className={styles.section}>
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}>REPOSITORIES</p><h2>Git hosting</h2></div>
            <button className={styles.secondary} onClick={() => void loadRepositories()}>Refresh</button>
          </div>

          {loading ? (
            <div className={styles.empty}>Loading Kosh repositories…</div>
          ) : repositories.length ? (
            <div className={styles.repoGrid}>
              {repositories.map((repository) => (
                <article className={styles.repoCard} key={repository.id}>
                  <div className={styles.repoTitle}>
                    <div>
                      <span>{repository.namespace}</span>
                      <strong>{repository.name}</strong>
                    </div>
                    <em>{repository.visibility}</em>
                  </div>
                  <p>{repository.description || "No description yet."}</p>
                  <div className={styles.repoMeta}>
                    <span>Default: {repository.defaultBranch}</span>
                    <span className={repository.state === "ready" ? styles.ready : styles.pending}>{repository.state}</span>
                  </div>
                  <div className={styles.cloneBox}>
                    <code>{repository.cloneHttpUrl}</code>
                    <button onClick={() => void copyCloneUrl(repository.cloneHttpUrl)}>Copy HTTPS</button>
                  </div>
                  {repository.cloneSshUrl && (
                    <div className={styles.cloneBox}>
                      <code>{repository.cloneSshUrl}</code>
                      <button onClick={() => void copyCloneUrl(repository.cloneSshUrl!)}>Copy SSH</button>
                    </div>
                  )}
                  <div className={styles.repoMeta}>
                    <Link className={styles.back} href={`/apps/kosh/repository?namespace=${encodeURIComponent(repository.namespace)}&slug=${encodeURIComponent(repository.slug)}`}>Open repository →</Link>
                    <Link className={styles.back} href={`/apps/kosh/wiki?namespace=${encodeURIComponent(repository.namespace)}&slug=${encodeURIComponent(repository.slug)}`}>Wiki →</Link>
                    <Link className={styles.back} href={`/apps/kosh/pages?namespace=${encodeURIComponent(repository.namespace)}&slug=${encodeURIComponent(repository.slug)}`}>Pages →</Link>
                    <Link className={styles.back} href={`/apps/kosh/systems?namespace=${encodeURIComponent(repository.namespace)}&slug=${encodeURIComponent(repository.slug)}`}>Systems →</Link>
                  </div>
                  <small>git clone {repository.cloneSshUrl || repository.cloneHttpUrl}</small>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>
              <strong>No repositories yet.</strong>
              <p>Create the first Kosh repository on the online gateway.</p>
              <button className={styles.primary} onClick={() => setCreateOpen(true)}>Create first repository</button>
            </div>
          )}
        </section>

        <section id="platform" className={styles.section}>
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}>PLATFORM</p><h2>Kosh platform systems</h2></div>
          </div>
          <div className={styles.moduleGrid}>
            {koshModules.map((module) => (
              <article key={module.id} className={styles.moduleCard}>
                <span className={styles[module.status]}>{module.status}</span>
                <strong>{module.name}</strong>
                <p>{module.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="infrastructure" className={styles.infrastructure}>
          <div>
            <p className={styles.eyebrow}>INFRASTRUCTURE</p>
            <h2>Kosh is online-native.</h2>
            <p>
              The browser talks to the Tamishra domain, which routes Kosh requests to the managed online gateway.
              Git remains standard while Kosh controls repository metadata, access, reviews, automation and platform services.
            </p>
          </div>
          <dl>
            <div><dt>Gateway</dt><dd>{gatewayOnline ? "Online" : "Connecting"}</dd></div>
            <div><dt>Metadata</dt><dd>{persistence || gateway?.persistence || "Kosh metadata store"}</dd></div>
            <div><dt>Git objects</dt><dd>{gitStorage || "Kosh repository storage"}</dd></div>
            <div><dt>Protocol</dt><dd>Git smart HTTP</dd></div>
          </dl>
        </section>
      </section>
    </main>
  );
}
