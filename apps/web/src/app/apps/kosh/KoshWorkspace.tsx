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

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100";

  return configured.replace(/\/$/, "");
}

export function KoshWorkspace() {
  const [repositories, setRepositories] = useState<KoshRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState("");
  const [persistence, setPersistence] = useState("");
  const [gitStorage, setGitStorage] = useState("");
  const [namespace, setNamespace] = useState("tamishra");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<KoshRepositoryVisibility>("private");

  const base = useMemo(apiBase, []);

  const loadRepositories = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(base + "/v1/kosh/repos", {
        credentials: "include",
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error("Kosh gateway returned " + response.status + ".");
      }
      const payload = (await response.json()) as RepositoryListResponse;
      setRepositories(payload.repositories ?? []);
      setPersistence(payload.persistence ?? "");
      setGitStorage(payload.gitStorage ?? "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not connect to the Kosh gateway.");
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

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

      const payload = (await response.json()) as KoshRepository | { error?: string };
      if (!response.ok) {
        throw new Error("error" in payload && payload.error ? payload.error : "Repository creation failed.");
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
          <a href="#platform">Platform</a>
          <a href="#infrastructure">Infrastructure</a>
        </nav>

        <div className={styles.sidebarNote}>
          <strong>Independent core</strong>
          <p>Standard Git stays compatible. Hosting, metadata, reviews, automation and storage belong to Kosh.</p>
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
            <span className={styles.badge}>Git-compatible foundation</span>
            <h2>A development platform built the Kosh way.</h2>
            <p>
              Kosh starts with real Git repository hosting and grows into reviews, issues,
              automation, packages, releases, security, deployments and generic engineering assets.
            </p>
          </div>
          <div className={styles.heroStats}>
            <div><strong>{loading ? "—" : repositories.length}</strong><span>repositories</span></div>
            <div><strong>{activeModules}</strong><span>active core modules</span></div>
            <div><strong>Git</strong><span>standard protocol</span></div>
          </div>
        </section>

        {error && (
          <div className={styles.error}>
            <strong>Kosh status</strong>
            <span>{error}</span>
            <button onClick={() => void loadRepositories()}>Retry</button>
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
                    <button onClick={() => void copyCloneUrl(repository.cloneHttpUrl)}>Copy</button>
                  </div>
                  <div className={styles.repoMeta}>
                    <Link
                      className={styles.back}
                      href={
                        "/apps/kosh/repository?namespace=" +
                        encodeURIComponent(repository.namespace) +
                        "&slug=" +
                        encodeURIComponent(repository.slug)
                      }
                    >
                      Open repository →
                    </Link>
                  </div>
                  <small>git clone {repository.cloneHttpUrl}</small>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.empty}>
              <strong>No repositories yet.</strong>
              <p>Create the first real Kosh repository. No demo projects are inserted automatically.</p>
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
            <h2>Storage remains replaceable.</h2>
            <p>
              Git repositories use persistent Git-native storage. Database metadata uses the Workspace PostgreSQL layer.
              Releases, build artifacts, backups and large project assets can later use Google Drive or another object-storage adapter.
            </p>
          </div>
          <dl>
            <div><dt>Metadata</dt><dd>{persistence || "gateway decides"}</dd></div>
            <div><dt>Git objects</dt><dd>{gitStorage || "persistent repository root"}</dd></div>
            <div><dt>Protocol</dt><dd>Git smart HTTP</dd></div>
          </dl>
        </section>
      </section>
    </main>
  );
}
