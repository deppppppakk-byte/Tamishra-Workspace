"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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

type ChangeRequest = {
  id: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  authorName: string;
  status: "open" | "merged" | "closed";
  createdAt: string;
  updatedAt: string;
  mergeCommitSha: string | null;
};

type BranchPolicy = {
  repositoryId: string;
  branch: string;
  requiredApprovals: number;
  blockOnChangesRequested: boolean;
  allowDirectPush: boolean;
  allowDelete: boolean;
  updatedAt: string;
};

type View = "code" | "commits" | "branches" | "tags" | "reviews";

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
  const router = useRouter();
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [overview, setOverview] = useState<RepositoryOverview | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [changeRequests, setChangeRequests] = useState<ChangeRequest[]>([]);
  const [selectedRef, setSelectedRef] = useState("");
  const [path, setPath] = useState("");
  const [preview, setPreview] = useState<BlobPreview | null>(null);
  const [view, setView] = useState<View>("code");
  const [loading, setLoading] = useState(true);
  const [contentLoading, setContentLoading] = useState(false);
  const [error, setError] = useState("");

  const [branchName, setBranchName] = useState("");
  const [branchFrom, setBranchFrom] = useState("");
  const [creatingBranch, setCreatingBranch] = useState(false);

  const [policyBranch, setPolicyBranch] = useState("");
  const [policy, setPolicy] = useState<BranchPolicy | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const [reviewFormOpen, setReviewFormOpen] = useState(false);
  const [reviewTitle, setReviewTitle] = useState("");
  const [reviewDescription, setReviewDescription] = useState("");
  const [reviewBase, setReviewBase] = useState("");
  const [reviewHead, setReviewHead] = useState("");
  const [creatingReview, setCreatingReview] = useState(false);

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

  const mutateJson = useCallback(
    async <T,>(
      url: string,
      method: "POST" | "PUT" | "PATCH" | "DELETE",
      body?: unknown
    ): Promise<T> => {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
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

  const refreshBranches = useCallback(async () => {
    if (!resourceBase) return;
    const payload = await fetchJson<{ branches: Branch[] }>(
      resourceBase + "/branches"
    );
    setBranches(payload.branches);
    return payload.branches;
  }, [fetchJson, resourceBase]);

  const refreshReviews = useCallback(async () => {
    if (!resourceBase) return;
    const payload = await fetchJson<{ changeRequests: ChangeRequest[] }>(
      resourceBase + "/change-requests"
    );
    setChangeRequests(payload.changeRequests);
  }, [fetchJson, resourceBase]);

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
        const [repoPayload, branchPayload, tagPayload, reviewPayload] =
          await Promise.all([
            fetchJson<RepositoryOverview>(resourceBase),
            fetchJson<{ branches: Branch[] }>(resourceBase + "/branches"),
            fetchJson<{ tags: Tag[] }>(resourceBase + "/tags"),
            fetchJson<{ changeRequests: ChangeRequest[] }>(
              resourceBase + "/change-requests"
            )
          ]);

        if (cancelled) return;

        setOverview(repoPayload);
        setBranches(branchPayload.branches);
        setTags(tagPayload.tags);
        setChangeRequests(reviewPayload.changeRequests);

        const initialRef =
          branchPayload.branches.find(
            (branch) =>
              branch.name === repoPayload.repository.defaultBranch
          )?.name ??
          branchPayload.branches[0]?.name ??
          "";

        setSelectedRef(initialRef);
        setBranchFrom(initialRef);
        setReviewBase(repoPayload.repository.defaultBranch);
        setReviewHead(
          branchPayload.branches.find(
            (branch) => branch.name !== repoPayload.repository.defaultBranch
          )?.name ?? ""
        );
        setPolicyBranch(repoPayload.repository.defaultBranch);

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

  useEffect(() => {
    if (!resourceBase || !policyBranch) {
      setPolicy(null);
      return;
    }

    let cancelled = false;

    void fetchJson<BranchPolicy>(
      resourceBase + "/policies/" + encodeURIComponent(policyBranch)
    )
      .then((value) => {
        if (!cancelled) setPolicy(value);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not load branch policy.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fetchJson, policyBranch, resourceBase]);

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

  async function createBranch() {
    if (!resourceBase || !branchName.trim()) return;
    setCreatingBranch(true);
    setError("");

    try {
      await mutateJson(
        resourceBase + "/branches",
        "POST",
        { name: branchName.trim(), from: branchFrom || selectedRef }
      );
      setBranchName("");
      const updated = await refreshBranches();
      if (updated?.length) {
        setBranchFrom(branchFrom || updated[0].name);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Branch creation failed.");
    } finally {
      setCreatingBranch(false);
    }
  }

  async function deleteBranch(name: string) {
    if (!resourceBase) return;
    setError("");

    try {
      await mutateJson(
        resourceBase + "/branches/" + encodeURIComponent(name),
        "DELETE"
      );
      await refreshBranches();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Branch deletion failed.");
    }
  }

  async function savePolicy() {
    if (!resourceBase || !policyBranch || !policy) return;
    setSavingPolicy(true);
    setError("");

    try {
      const saved = await mutateJson<BranchPolicy>(
        resourceBase + "/policies/" + encodeURIComponent(policyBranch),
        "PUT",
        {
          requiredApprovals: policy.requiredApprovals,
          blockOnChangesRequested: policy.blockOnChangesRequested,
          allowDirectPush: policy.allowDirectPush,
          allowDelete: policy.allowDelete
        }
      );
      setPolicy(saved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save branch policy.");
    } finally {
      setSavingPolicy(false);
    }
  }

  async function createChangeRequest() {
    if (!resourceBase || !reviewTitle.trim() || !reviewHead) return;
    setCreatingReview(true);
    setError("");

    try {
      const created = await mutateJson<ChangeRequest>(
        resourceBase + "/change-requests",
        "POST",
        {
          title: reviewTitle.trim(),
          description: reviewDescription.trim(),
          baseBranch: reviewBase,
          headBranch: reviewHead
        }
      );
      setReviewFormOpen(false);
      setReviewTitle("");
      setReviewDescription("");
      await refreshReviews();
      router.push(
        "/apps/kosh/review?namespace=" +
          encodeURIComponent(namespace) +
          "&slug=" +
          encodeURIComponent(slug) +
          "&number=" +
          created.number
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Change Request creation failed."
      );
    } finally {
      setCreatingReview(false);
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
          {(["code", "commits", "branches", "tags", "reviews"] as View[]).map(
            (item) => (
              <button
                key={item}
                className={view === item ? styles.activeTab : ""}
                onClick={() => setView(item)}
              >
                {item === "code"
                  ? "Code"
                  : item === "reviews"
                    ? "Change Reviews"
                    : item.charAt(0).toUpperCase() + item.slice(1)}
                {item === "commits" && commits.length
                  ? " " + commits.length
                  : item === "branches"
                    ? " " + overview.branchCount
                    : item === "tags"
                      ? " " + overview.tagCount
                      : item === "reviews"
                        ? " " + changeRequests.filter((item) => item.status === "open").length
                        : ""}
              </button>
            )
          )}
          <Link
            href={
              "/apps/kosh/work?namespace=" +
              encodeURIComponent(namespace) +
              "&slug=" +
              encodeURIComponent(slug)
            }
          >
            Work
          </Link>
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
            {view !== "reviews" && (
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
            )}

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
                            const parent = breadcrumbs.slice(0, -1).join("/");
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
              <section className={styles.managementGrid}>
                <div className={styles.listPanel}>
                  <div className={styles.panelTitle}>
                    <div>
                      <strong>Branches</strong>
                      <span>Create feature branches and manage refs.</span>
                    </div>
                  </div>
                  <div className={styles.inlineForm}>
                    <input
                      value={branchName}
                      onChange={(event) => setBranchName(event.target.value)}
                      placeholder="feature/new-work"
                    />
                    <select
                      value={branchFrom}
                      onChange={(event) => setBranchFrom(event.target.value)}
                    >
                      {branches.map((branch) => (
                        <option key={branch.name} value={branch.name}>
                          from {branch.name}
                        </option>
                      ))}
                    </select>
                    <button
                      disabled={creatingBranch || !branchName.trim()}
                      onClick={() => void createBranch()}
                    >
                      {creatingBranch ? "Creating…" : "Create"}
                    </button>
                  </div>

                  {branches.map((branch) => (
                    <article className={styles.refRow} key={branch.name}>
                      <div>
                        <strong>{branch.name}</strong>
                        <span>
                          {branch.subject || "No commit subject"} ·{" "}
                          {ageLabel(branch.committedAt)}
                        </span>
                      </div>
                      <div className={styles.rowActions}>
                        <code>{branch.sha.slice(0, 8)}</code>
                        {branch.name !== repository.defaultBranch && (
                          <button
                            className={styles.dangerButton}
                            onClick={() => void deleteBranch(branch.name)}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>

                <aside className={styles.policyPanel}>
                  <div className={styles.panelTitle}>
                    <div>
                      <strong>Branch policy</strong>
                      <span>Rules are enforced by Kosh and Git receive hooks.</span>
                    </div>
                  </div>

                  <label>
                    <span>Branch</span>
                    <select
                      value={policyBranch}
                      onChange={(event) => setPolicyBranch(event.target.value)}
                    >
                      {branches.map((branch) => (
                        <option key={branch.name} value={branch.name}>
                          {branch.name}
                        </option>
                      ))}
                    </select>
                  </label>

                  {policy && (
                    <>
                      <label>
                        <span>Required approvals</span>
                        <input
                          type="number"
                          min={0}
                          max={20}
                          value={policy.requiredApprovals}
                          onChange={(event) =>
                            setPolicy({
                              ...policy,
                              requiredApprovals: Math.max(
                                0,
                                Math.min(20, Number(event.target.value) || 0)
                              )
                            })
                          }
                        />
                      </label>
                      <label className={styles.checkLabel}>
                        <input
                          type="checkbox"
                          checked={policy.blockOnChangesRequested}
                          onChange={(event) =>
                            setPolicy({
                              ...policy,
                              blockOnChangesRequested: event.target.checked
                            })
                          }
                        />
                        <span>Block merge when changes are requested</span>
                      </label>
                      <label className={styles.checkLabel}>
                        <input
                          type="checkbox"
                          checked={policy.allowDirectPush}
                          onChange={(event) =>
                            setPolicy({
                              ...policy,
                              allowDirectPush: event.target.checked
                            })
                          }
                        />
                        <span>Allow direct Git push</span>
                      </label>
                      <label className={styles.checkLabel}>
                        <input
                          type="checkbox"
                          checked={policy.allowDelete}
                          onChange={(event) =>
                            setPolicy({
                              ...policy,
                              allowDelete: event.target.checked
                            })
                          }
                        />
                        <span>Allow branch deletion</span>
                      </label>
                      <button
                        className={styles.primaryAction}
                        disabled={savingPolicy}
                        onClick={() => void savePolicy()}
                      >
                        {savingPolicy ? "Saving…" : "Save policy"}
                      </button>
                    </>
                  )}
                </aside>
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

            {view === "reviews" && (
              <section>
                <div className={styles.reviewHeader}>
                  <div>
                    <strong>Change Reviews</strong>
                    <span>
                      Compare branches, discuss changes, approve and merge.
                    </span>
                  </div>
                  <button
                    className={styles.primaryAction}
                    onClick={() => setReviewFormOpen((open) => !open)}
                  >
                    + New Change Request
                  </button>
                </div>

                {reviewFormOpen && (
                  <div className={styles.reviewCreate}>
                    <label>
                      <span>Title</span>
                      <input
                        value={reviewTitle}
                        onChange={(event) => setReviewTitle(event.target.value)}
                        placeholder="Describe this change"
                      />
                    </label>
                    <label>
                      <span>Description</span>
                      <textarea
                        value={reviewDescription}
                        onChange={(event) =>
                          setReviewDescription(event.target.value)
                        }
                        placeholder="Context, testing notes and review guidance"
                      />
                    </label>
                    <div className={styles.branchPair}>
                      <label>
                        <span>Base</span>
                        <select
                          value={reviewBase}
                          onChange={(event) => setReviewBase(event.target.value)}
                        >
                          {branches.map((branch) => (
                            <option key={branch.name} value={branch.name}>
                              {branch.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <span>← merge from ←</span>
                      <label>
                        <span>Head</span>
                        <select
                          value={reviewHead}
                          onChange={(event) => setReviewHead(event.target.value)}
                        >
                          <option value="">Select branch</option>
                          {branches
                            .filter((branch) => branch.name !== reviewBase)
                            .map((branch) => (
                              <option key={branch.name} value={branch.name}>
                                {branch.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                    <div className={styles.formButtons}>
                      <button
                        className={styles.secondaryAction}
                        onClick={() => setReviewFormOpen(false)}
                      >
                        Cancel
                      </button>
                      <button
                        className={styles.primaryAction}
                        disabled={
                          creatingReview ||
                          !reviewTitle.trim() ||
                          !reviewHead ||
                          reviewHead === reviewBase
                        }
                        onClick={() => void createChangeRequest()}
                      >
                        {creatingReview ? "Creating…" : "Open Change Request"}
                      </button>
                    </div>
                  </div>
                )}

                <div className={styles.reviewList}>
                  {changeRequests.map((item) => (
                    <Link
                      key={item.id}
                      className={styles.reviewRow}
                      href={
                        "/apps/kosh/review?namespace=" +
                        encodeURIComponent(namespace) +
                        "&slug=" +
                        encodeURIComponent(slug) +
                        "&number=" +
                        item.number
                      }
                    >
                      <div>
                        <strong>
                          #{item.number} {item.title}
                        </strong>
                        <span>
                          {item.headBranch} → {item.baseBranch} ·{" "}
                          {item.authorName} · {ageLabel(item.updatedAt)}
                        </span>
                      </div>
                      <em className={styles[item.status]}>{item.status}</em>
                    </Link>
                  ))}
                  {!changeRequests.length && (
                    <div className={styles.progress}>
                      No Change Requests yet.
                    </div>
                  )}
                </div>
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}
