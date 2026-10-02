"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { KoshRepository } from "@tamishra/kosh-core";
import styles from "./repository.module.css";

type RepositoryOverview = {
  repository: KoshRepository;
  headSha: string | null;
  empty: boolean;
  branchCount: number;
  tagCount: number;
};

type Branch = {
  name: string;
  sha: string;
  subject: string;
  author: string;
  committedAt: string;
};

type Tag = {
  name: string;
  sha: string;
  subject: string;
  creator: string;
  createdAt: string;
};

type Commit = {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  body: string;
};

type TreeEntry = {
  name: string;
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number | null;
};

type BlobPreview = {
  ref: string;
  commitSha: string;
  path: string;
  size: number;
  preview: string | null;
  encoding: "utf8" | "base64" | "too-large";
};

type View = "code" | "commits" | "branches" | "tags";

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100";

  return configured.replace(/\/$/, "");
}

function ageLabel(value: string) {
  if (!value) return "Unknown";
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d ago";
  return date.toLocaleDateString();
}

function sizeLabel(size: number | null) {
  if (size === null) return "—";
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / 1024 / 1024).toFixed(1) + " MB";
}

export function RepositoryWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [overview, setOverview] = useState<RepositoryOverview | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [selectedRef, setSelectedRef] = useState("");
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<BlobPreview | null>(null);
  const [view, setView] = useState<View>("code");
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() ?? "");
    setSlug(params.get("slug")?.trim() ?? "");
  }, []);

  const resourceBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug)
    );
  }, [base, namespace, slug]);

  const fetchJson = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store"
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "Kosh request failed.");
    }
    return payload;
  }, []);

  const loadGitView = useCallback(
    async (ref: string, nextPath = "") => {
      if (!ref || !resourceBase) return;
      setContentLoading(true);
      setError("");
      setPreview(null);

      try {
        const queryRef = encodeURIComponent(ref);
        const queryPath = encodeURIComponent(nextPath);
        const [commitPayload, treePayload] = await Promise.all([
          fetchJson<{ commits: Commit[] }>(
            resourceBase + "/commits?ref=" + queryRef + "&limit=50"
          ),
          fetchJson<{ entries: TreeEntry[] }>(
            resourceBase +
              "/tree?ref=" +
              queryRef +
              "&path=" +
              queryPath
          )
        ]);

        setCommits(commitPayload.commits);
        setEntries(treePayload.entries);
        setPath(nextPath);
      } catch (reason) {
        setError(
          reason instanceof Error
            ? reason.message
            : "Could not load repository content."
        );
      } finally {
        setContentLoading(false);
      }
    },
    [fetchJson, resourceBase]
  );

  useEffect(() => {
    if (!resourceBase) {
      if (namespace || slug) {
        setLoading(false);
        setError("Repository namespace and slug are required.");
      }
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const [repoPayload, branchPayload, tagPayload] = await Promise.all([
          fetchJson<RepositoryOverview>(resourceBase),
          fetchJson<{ branches: Branch[] }>(resourceBase + "/branches"),
          fetchJson<{ tags: Tag[] }>(resourceBase + "/tags")
        ]);

        if (cancelled) return;

        setOverview(repoPayload);
        setBranches(branchPayload.branches);
        setTags(tagPayload.tags);

        const initialRef =
          branchPayload.branches.find(
            (branch) =>
              branch.name === repoPayload.repository.defaultBranch
          )?.name ??
          branchPayload.branches[0]?.name ??
          "";

        setSelectedRef(initialRef);

        if (initialRef) {
          await loadGitView(initialRef, "");
        }
      } catch (reason) {
        if (!cancelled) {
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load this repository."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchJson, loadGitView, namespace, resourceBase, slug]);

  async function openEntry(entry: TreeEntry) {
    if (entry.type === "tree") {
      await loadGitView(selectedRef, entry.path);
      return;
    }

    if (entry.type !== "blob" || !resourceBase) return;

    setContentLoading(true);
    setError("");

    try {
      const payload = await fetchJson<BlobPreview>(
        resourceBase +
          "/blob?ref=" +
          encodeURIComponent(selectedRef) +
          "&path=" +
          encodeURIComponent(entry.path)
      );
      setPreview(payload);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not preview this file."
      );
    } finally {
      setContentLoading(false);
    }
  }

  const breadcrumbs = path ? path.split("/") : [];

  if (loading && !overview) {
    return (
      <main className={styles.loading}>
        <strong>Kosh</strong>
        <span>Loading repository…</span>
      </main>
    );
  }

  if (!overview) {
    return (
      <main className={styles.loading}>
        <strong>Repository unavailable</strong>
        <span>{error || "Kosh could not open this repository."}</span>
        <Link href="/apps/kosh">Back to Kosh</Link>
      </main>
    );
  }

  const repository = overview.repository;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerTop}>
          <div>
            <Link className={styles.back} href="/apps/kosh">
              ← Kosh
            </Link>
            <div className={styles.identity}>
              <span>{repository.namespace}</span>
              <b>/</b>
              <strong>{repository.name}</strong>
              <em>{repository.visibility}</em>
            </div>
            <p>{repository.description || "No repository description yet."}</p>
          </div>
          <div className={styles.clonePanel}>
            <span>Clone over HTTPS</span>
            <code>{repository.cloneHttpUrl}</code>
          </div>
        </div>

        <nav className={styles.tabs}>
          {(["code", "commits", "branches", "tags"] as View[]).map(
            (item) => (
              <button
                key={item}
                className={view === item ? styles.activeTab : ""}
                onClick={() => setView(item)}
              >
                {item === "code"
                  ? "Code"
                  : item.charAt(0).toUpperCase() + item.slice(1)}
                {item === "commits" && commits.length
                  ? " " + commits.length
                  : item === "branches"
                    ? " " + overview.branchCount
                    : item === "tags"
                      ? " " + overview.tagCount
                      : ""}
              </button>
            )
          )}
        </nav>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        {overview.empty ? (
          <section className={styles.empty}>
            <strong>This repository is empty.</strong>
            <p>Push the first commit using the standard Git client.</p>
            <pre>
              {[
                "git clone " + repository.cloneHttpUrl,
                "cd " + repository.slug,
                "echo \"# " + repository.name + "\" > README.md",
                "git add README.md",
                "git commit -m \"Initial commit\"",
                "git push origin main"
              ].join("\n")}
            </pre>
          </section>
        ) : (
          <>
            <div className={styles.toolbar}>
              <label>
                <span>Branch / ref</span>
                <select
                  value={selectedRef}
                  onChange={(event) => {
                    const next = event.target.value;
                    setSelectedRef(next);
                    void loadGitView(next, "");
                  }}
                >
                  {branches.map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className={styles.summary}>
                <span>{overview.branchCount} branches</span>
                <span>{overview.tagCount} tags</span>
                <span>
                  {overview.headSha
                    ? overview.headSha.slice(0, 8)
                    : "No HEAD"}
                </span>
              </div>
            </div>

            {view === "code" && (
              <section className={styles.codeLayout}>
                <div className={styles.browser}>
                  <div className={styles.breadcrumbs}>
                    <button onClick={() => void loadGitView(selectedRef, "")}>
                      {repository.name}
                    </button>
                    {breadcrumbs.map((part, index) => {
                      const nextPath = breadcrumbs
                        .slice(0, index + 1)
                        .join("/");
                      return (
                        <span key={nextPath}>
                          <b>/</b>
                          <button
                            onClick={() =>
                              void loadGitView(selectedRef, nextPath)
                            }
                          >
                            {part}
                          </button>
                        </span>
                      );
                    })}
                  </div>

                  {contentLoading ? (
                    <div className={styles.progress}>Reading Git objects…</div>
                  ) : (
                    <div className={styles.tree}>
                      {path && (
                        <button
                          className={styles.treeRow}
                          onClick={() => {
                            const parent = breadcrumbs
                              .slice(0, -1)
                              .join("/");
                            void loadGitView(selectedRef, parent);
                          }}
                        >
                          <span className={styles.kind}>↰</span>
                          <strong>..</strong>
                          <span />
                          <small />
                        </button>
                      )}
                      {entries.map((entry) => (
                        <button
                          className={styles.treeRow}
                          key={entry.path}
                          onClick={() => void openEntry(entry)}
                        >
                          <span className={styles.kind}>
                            {entry.type === "tree" ? "▣" : "·"}
                          </span>
                          <strong>{entry.name}</strong>
                          <span>{entry.sha.slice(0, 8)}</span>
                          <small>{sizeLabel(entry.size)}</small>
                        </button>
                      ))}
                      {!entries.length && (
                        <div className={styles.progress}>
                          This tree has no entries.
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <aside className={styles.preview}>
                  {preview ? (
                    <>
                      <div className={styles.previewHeader}>
                        <div>
                          <strong>{preview.path}</strong>
                          <span>{sizeLabel(preview.size)}</span>
                        </div>
                        <button onClick={() => setPreview(null)}>×</button>
                      </div>
                      {preview.encoding === "utf8" ? (
                        <pre>{preview.preview}</pre>
                      ) : preview.encoding === "too-large" ? (
                        <div className={styles.previewMessage}>
                          File is larger than the 1 MB browser preview limit.
                        </div>
                      ) : (
                        <div className={styles.previewMessage}>
                          Binary file detected. Kosh keeps the Git object intact
                          but does not render binary data as text.
                        </div>
                      )}
                    </>
                  ) : (
                    <div className={styles.previewMessage}>
                      Select a text file to preview its contents directly from
                      the Git object database.
                    </div>
                  )}
                </aside>
              </section>
            )}

            {view === "commits" && (
              <section className={styles.listPanel}>
                {commits.map((commit) => (
                  <article className={styles.commit} key={commit.sha}>
                    <div>
                      <strong>{commit.subject || "(no subject)"}</strong>
                      <span>
                        {commit.authorName} · {ageLabel(commit.authoredAt)}
                      </span>
                    </div>
                    <code>{commit.shortSha}</code>
                  </article>
                ))}
              </section>
            )}

            {view === "branches" && (
              <section className={styles.listPanel}>
                {branches.map((branch) => (
                  <article className={styles.refRow} key={branch.name}>
                    <div>
                      <strong>{branch.name}</strong>
                      <span>
                        {branch.subject || "No commit subject"} ·{" "}
                        {ageLabel(branch.committedAt)}
                      </span>
                    </div>
                    <code>{branch.sha.slice(0, 8)}</code>
                  </article>
                ))}
              </section>
            )}

            {view === "tags" && (
              <section className={styles.listPanel}>
                {tags.length ? (
                  tags.map((tag) => (
                    <article className={styles.refRow} key={tag.name}>
                      <div>
                        <strong>{tag.name}</strong>
                        <span>
                          {tag.subject || "Tag"} · {ageLabel(tag.createdAt)}
                        </span>
                      </div>
                      <code>{tag.sha.slice(0, 8)}</code>
                    </article>
                  ))
                ) : (
                  <div className={styles.progress}>No tags yet.</div>
                )}
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}
