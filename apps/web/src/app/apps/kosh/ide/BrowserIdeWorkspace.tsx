"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { KoshRepository } from "@tamishra/kosh-core";
import styles from "./ide.module.css";

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

type IdeState = {
  repositoryId: string;
  defaultBranch: string;
  defaultHeadSha: string | null;
  branch: string;
  branchExists: boolean;
  branchHeadSha: string | null;
  baseBranch: string;
  baseSha: string | null;
  expectedHeadSha: string | null;
  editable: boolean;
  limits: {
    maxOperations: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxDiffBytes: number;
  };
};

type PendingOperation =
  | { type: "write"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "rename"; path: string; toPath: string };

type ChangedFile = {
  status: string;
  path: string;
  toPath: string | null;
};

type DiffPreview = {
  branch: string;
  branchExists: boolean;
  previousHeadSha: string | null;
  baseBranch: string;
  expectedHeadSha: string;
  changedFiles: ChangedFile[];
  stats: string;
  diff: string;
  truncated: boolean;
};

type CommitResult = {
  branch: string;
  createdBranch: boolean;
  previousHeadSha: string | null;
  commitSha: string;
  message: string;
  changedFiles: ChangedFile[];
  stats: string;
};

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100";

  return configured.replace(/\/$/, "");
}

function parentPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function sizeLabel(size: number | null) {
  if (size === null) return "—";
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / 1024 / 1024).toFixed(1) + " MB";
}

function operationLabel(operation: PendingOperation) {
  if (operation.type === "write") return "Write";
  if (operation.type === "delete") return "Delete";
  return "Rename";
}

export function BrowserIdeWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [overview, setOverview] = useState<RepositoryOverview | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branch, setBranch] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [ideState, setIdeState] = useState<IdeState | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedExists, setSelectedExists] = useState(false);
  const [editorContent, setEditorContent] = useState("");
  const [loadedContent, setLoadedContent] = useState("");
  const [operations, setOperations] = useState<PendingOperation[]>([]);
  const [newPath, setNewPath] = useState("");
  const [renamePath, setRenamePath] = useState("");
  const [owners, setOwners] = useState<string[]>([]);
  const [diffPreview, setDiffPreview] = useState<DiffPreview | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [treeLoading, setTreeLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

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
    async <T,>(url: string, body: unknown): Promise<T> => {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const payload = (await response.json()) as T & {
        error?: string;
        currentHeadSha?: string;
      };
      if (!response.ok) {
        if (payload.error === "ide_branch_moved" && payload.currentHeadSha) {
          throw new Error(
            "Branch changed on the server. Refresh the IDE state before committing."
          );
        }
        throw new Error(payload.error || "Kosh request failed.");
      }
      return payload;
    },
    []
  );

  const activeRef = useMemo(() => {
    if (!ideState) return baseBranch;
    return ideState.branchExists ? branch : baseBranch;
  }, [baseBranch, branch, ideState]);

  const activeCommit = useMemo(() => {
    if (!ideState) return "";
    return (
      ideState.branchHeadSha ||
      ideState.baseSha ||
      ideState.defaultHeadSha ||
      ""
    );
  }, [ideState]);

  const loadState = useCallback(
    async (nextBranch: string, nextBase: string) => {
      if (!resourceBase || !nextBranch || !nextBase) return null;
      const value = await fetchJson<IdeState>(
        resourceBase +
          "/ide/state?branch=" +
          encodeURIComponent(nextBranch) +
          "&baseBranch=" +
          encodeURIComponent(nextBase)
      );
      setIdeState(value);
      return value;
    },
    [fetchJson, resourceBase]
  );

  const loadTree = useCallback(
    async (ref: string, nextPath = "") => {
      if (!resourceBase || !ref) return;
      setTreeLoading(true);
      try {
        const payload = await fetchJson<{ entries: TreeEntry[] }>(
          resourceBase +
            "/tree?ref=" +
            encodeURIComponent(ref) +
            "&path=" +
            encodeURIComponent(nextPath)
        );
        setEntries(payload.entries);
        setPath(nextPath);
      } finally {
        setTreeLoading(false);
      }
    },
    [fetchJson, resourceBase]
  );

  useEffect(() => {
    if (!resourceBase) {
      if (namespace || slug) {
        setError("Repository namespace and slug are required.");
        setLoading(false);
      }
      return;
    }

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const [repoPayload, branchPayload] = await Promise.all([
          fetchJson<RepositoryOverview>(resourceBase),
          fetchJson<{ branches: Branch[] }>(resourceBase + "/branches")
        ]);
        if (cancelled) return;

        setOverview(repoPayload);
        setBranches(branchPayload.branches);

        const defaultBranch = repoPayload.repository.defaultBranch;
        const existingFeature = branchPayload.branches.find(
          (item) => item.name !== defaultBranch
        );
        const initialBranch = existingFeature?.name || "work/browser-edit";
        setBranch(initialBranch);
        setBaseBranch(defaultBranch);

        const state = await loadState(initialBranch, defaultBranch);
        if (cancelled || !state) return;
        const ref = state.branchExists ? initialBranch : defaultBranch;
        await loadTree(ref, "");
      } catch (reason) {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason.message : "Could not open Kosh IDE."
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [fetchJson, loadState, loadTree, namespace, resourceBase, slug]);

  useEffect(() => {
    if (!resourceBase || !branch || !baseBranch || loading) return;
    let cancelled = false;

    void loadState(branch, baseBranch)
      .then((state) => {
        if (!cancelled && state) {
          return loadTree(state.branchExists ? branch : baseBranch, "");
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason.message : "Could not refresh IDE state."
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [baseBranch, branch, loadState, loadTree, loading, resourceBase]);

  useEffect(() => {
    if (!resourceBase || !selectedPath || !activeCommit) {
      setOwners([]);
      return;
    }

    let cancelled = false;
    void fetchJson<{ owners: string[] }>(
      resourceBase +
        "/code-intelligence/owners?path=" +
        encodeURIComponent(selectedPath) +
        "&commit=" +
        encodeURIComponent(activeCommit)
    )
      .then((payload) => {
        if (!cancelled) setOwners(payload.owners);
      })
      .catch(() => {
        if (!cancelled) setOwners([]);
      });

    return () => {
      cancelled = true;
    };
  }, [activeCommit, fetchJson, resourceBase, selectedPath]);

  async function openEntry(entry: TreeEntry) {
    setError("");
    setSuccess("");

    if (entry.type === "tree") {
      await loadTree(activeRef, entry.path);
      return;
    }
    if (entry.type !== "blob" || !resourceBase || !activeRef) return;

    try {
      const staged = [...operations]
        .reverse()
        .find(
          (operation) =>
            operation.type === "write" && operation.path === entry.path
        );
      if (staged?.type === "write") {
        setSelectedPath(entry.path);
        setSelectedExists(true);
        setEditorContent(staged.content);
        setLoadedContent(staged.content);
        setRenamePath(entry.path);
        return;
      }

      const payload = await fetchJson<BlobPreview>(
        resourceBase +
          "/blob?ref=" +
          encodeURIComponent(activeRef) +
          "&path=" +
          encodeURIComponent(entry.path)
      );
      if (payload.encoding !== "utf8" || payload.preview === null) {
        throw new Error("This file cannot be edited as UTF-8 text.");
      }
      setSelectedPath(entry.path);
      setSelectedExists(true);
      setEditorContent(payload.preview);
      setLoadedContent(payload.preview);
      setRenamePath(entry.path);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not open this file."
      );
    }
  }

  function stageWrite() {
    if (!selectedPath) return;
    setOperations((current) => [
      ...current.filter(
        (operation) =>
          !(
            operation.type === "write" &&
            operation.path === selectedPath
          )
      ),
      { type: "write", path: selectedPath, content: editorContent }
    ]);
    setLoadedContent(editorContent);
    setDiffPreview(null);
    setSuccess("File staged.");
  }

  function createFile() {
    const value = newPath.trim().replace(/^\/+/, "");
    if (!value) return;
    setSelectedPath(value);
    setSelectedExists(false);
    setEditorContent("");
    setLoadedContent("");
    setRenamePath(value);
    setNewPath("");
    setOwners([]);
    setSuccess("New file opened. Add content, then stage it.");
  }

  function stageDelete() {
    if (!selectedPath) return;
    setOperations((current) => [
      ...current.filter(
        (operation) =>
          !(
            operation.type === "write" &&
            operation.path === selectedPath
          )
      ),
      { type: "delete", path: selectedPath }
    ]);
    setDiffPreview(null);
    setSuccess("Delete staged.");
  }

  function stageRename() {
    const target = renamePath.trim().replace(/^\/+/, "");
    if (!selectedPath || !target || target === selectedPath) return;
    const source = selectedPath;
    setOperations((current) => {
      const sourceWrite = current.find(
        (operation) =>
          operation.type === "write" && operation.path === source
      );
      const unrelated = current.filter(
        (operation) =>
          !(
            (operation.type === "write" && operation.path === source) ||
            (operation.type === "rename" && operation.path === source)
          )
      );
      const next: PendingOperation[] = [
        ...unrelated,
        { type: "rename", path: source, toPath: target }
      ];
      if (sourceWrite?.type === "write") {
        next.push({ ...sourceWrite, path: target });
      }
      return next;
    });
    setSelectedPath(target);
    setRenamePath(target);
    setDiffPreview(null);
    setSuccess("Rename staged.");
  }

  function removeOperation(index: number) {
    setOperations((current) =>
      current.filter((_, currentIndex) => currentIndex !== index)
    );
    setDiffPreview(null);
  }

  async function previewChanges() {
    if (
      !resourceBase ||
      !ideState?.editable ||
      !ideState.expectedHeadSha ||
      !operations.length
    ) {
      return;
    }
    setActionLoading(true);
    setError("");
    setSuccess("");
    try {
      const payload = await mutateJson<DiffPreview>(
        resourceBase + "/ide/preview",
        {
          branch,
          baseBranch,
          expectedHeadSha: ideState.expectedHeadSha,
          operations
        }
      );
      setDiffPreview(payload);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not preview changes."
      );
    } finally {
      setActionLoading(false);
    }
  }

  async function commitChanges() {
    if (
      !resourceBase ||
      !ideState?.editable ||
      !ideState.expectedHeadSha ||
      !operations.length ||
      !commitMessage.trim()
    ) {
      return;
    }

    setActionLoading(true);
    setError("");
    setSuccess("");

    try {
      const payload = await mutateJson<CommitResult>(
        resourceBase + "/ide/commit",
        {
          branch,
          baseBranch,
          expectedHeadSha: ideState.expectedHeadSha,
          message: commitMessage.trim(),
          operations
        }
      );

      setOperations([]);
      setDiffPreview(null);
      setCommitMessage("");
      setSelectedPath("");
      setSelectedExists(false);
      setEditorContent("");
      setLoadedContent("");
      setSuccess(
        "Committed " +
          payload.commitSha.slice(0, 12) +
          " to " +
          payload.branch +
          "."
      );
      setLoadedContent(editorContent);

      const state = await loadState(branch, baseBranch);
      if (state) {
        await loadTree(state.branchExists ? branch : baseBranch, "");
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Commit failed."
      );
    } finally {
      setActionLoading(false);
    }
  }

  if (loading && !overview) {
    return (
      <main className={styles.loading}>
        <strong>Kosh IDE</strong>
        <span>Opening repository workspace…</span>
      </main>
    );
  }

  if (!overview) {
    return (
      <main className={styles.loading}>
        <strong>Kosh IDE unavailable</strong>
        <span>{error || "Repository could not be loaded."}</span>
        <Link href="/apps/kosh">Back to Kosh</Link>
      </main>
    );
  }

  const repository = overview.repository;
  const breadcrumbs = path ? path.split("/") : [];
  const editorDirty = editorContent !== loadedContent;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link className={styles.back} href="/apps/kosh">
            ← Kosh
          </Link>
          <div className={styles.titleRow}>
            <strong>Kosh IDE</strong>
            <span>
              {repository.namespace}/{repository.slug}
            </span>
          </div>
          <p>
            Branch-safe browser editing with Kosh-native review, Automation,
            Security and Code Intelligence handoff.
          </p>
        </div>
        <div className={styles.headerLinks}>
          <Link
            href={
              "/apps/kosh/repository?namespace=" +
              encodeURIComponent(namespace) +
              "&slug=" +
              encodeURIComponent(slug)
            }
          >
            Repository
          </Link>
          <Link
            href={
              "/apps/kosh/code-intelligence?namespace=" +
              encodeURIComponent(namespace) +
              "&slug=" +
              encodeURIComponent(slug)
            }
          >
            Intelligence
          </Link>
          <Link
            href={
              "/apps/kosh/review?namespace=" +
              encodeURIComponent(namespace) +
              "&slug=" +
              encodeURIComponent(slug)
            }
          >
            Reviews
          </Link>
        </div>
      </header>

      <section className={styles.branchBar}>
        <label>
          <span>Edit branch</span>
          <input
            value={branch}
            onChange={(event) => {
              setBranch(event.target.value);
              setOperations([]);
              setDiffPreview(null);
              setSelectedPath("");
            }}
            list="kosh-ide-branches"
            placeholder="work/my-change"
          />
          <datalist id="kosh-ide-branches">
            {branches
              .filter((item) => item.name !== repository.defaultBranch)
              .map((item) => (
                <option key={item.name} value={item.name} />
              ))}
          </datalist>
        </label>
        <label>
          <span>Base branch</span>
          <select
            value={baseBranch}
            onChange={(event) => {
              setBaseBranch(event.target.value);
              setOperations([]);
              setDiffPreview(null);
              setSelectedPath("");
            }}
          >
            {branches.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.branchState}>
          <span>
            {ideState?.branchExists ? "Existing branch" : "New branch"}
          </span>
          <code>
            {(ideState?.expectedHeadSha || "no-head").slice(0, 12)}
          </code>
        </div>
        {!ideState?.editable && (
          <div className={styles.warning}>
            Use a valid non-default edit branch.
          </div>
        )}
      </section>

      {error && <div className={styles.error}>{error}</div>}
      {success && <div className={styles.success}>{success}</div>}

      <section className={styles.workspace}>
        <aside className={styles.sidebar}>
          <div className={styles.sideHeader}>
            <strong>Files</strong>
            <span>{activeRef || "—"}</span>
          </div>

          <div className={styles.breadcrumbs}>
            <button
              onClick={() => void loadTree(activeRef, "")}
              disabled={!path}
            >
              root
            </button>
            {breadcrumbs.map((part, index) => {
              const target = breadcrumbs.slice(0, index + 1).join("/");
              return (
                <button
                  key={target}
                  onClick={() => void loadTree(activeRef, target)}
                >
                  / {part}
                </button>
              );
            })}
          </div>

          {path && (
            <button
              className={styles.parentButton}
              onClick={() => void loadTree(activeRef, parentPath(path))}
            >
              ↑ Parent
            </button>
          )}

          <div className={styles.fileList}>
            {treeLoading ? (
              <span className={styles.muted}>Loading files…</span>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.path}
                  className={
                    selectedPath === entry.path ? styles.selectedFile : ""
                  }
                  onClick={() => void openEntry(entry)}
                >
                  <span>
                    {entry.type === "tree" ? "▸" : "·"} {entry.name}
                  </span>
                  <small>{sizeLabel(entry.size)}</small>
                </button>
              ))
            )}
          </div>

          <div className={styles.newFile}>
            <input
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
              placeholder="src/new-file.ts"
            />
            <button onClick={createFile} disabled={!newPath.trim()}>
              New file
            </button>
          </div>
        </aside>

        <section className={styles.editorPane}>
          <div className={styles.editorHeader}>
            <div>
              <strong>{selectedPath || "Select a text file"}</strong>
              {owners.length > 0 && (
                <span className={styles.owners}>
                  Owners: {owners.join(", ")}
                </span>
              )}
            </div>
            {selectedPath && (
              <div className={styles.editorActions}>
                <button
                  onClick={stageWrite}
                  disabled={!editorDirty && selectedExists}
                >
                  Stage file
                </button>
                <button onClick={stageDelete} disabled={!selectedExists}>
                  Stage delete
                </button>
              </div>
            )}
          </div>

          {selectedPath ? (
            <>
              <textarea
                className={styles.editor}
                value={editorContent}
                onChange={(event) => setEditorContent(event.target.value)}
                spellCheck={false}
              />
              <div className={styles.renameBar}>
                <input
                  value={renamePath}
                  onChange={(event) => setRenamePath(event.target.value)}
                  placeholder="Move / rename path"
                />
                <button
                  onClick={stageRename}
                  disabled={
                    !selectedExists ||
                    !renamePath.trim() ||
                    renamePath.trim() === selectedPath
                  }
                >
                  Stage rename
                </button>
              </div>
            </>
          ) : (
            <div className={styles.editorEmpty}>
              <strong>Choose a file from the repository tree.</strong>
              <p>
                The IDE only commits to non-default branches. Open a Change
                Review when the branch is ready.
              </p>
            </div>
          )}
        </section>

        <aside className={styles.changesPane}>
          <div className={styles.sideHeader}>
            <strong>Change set</strong>
            <span>{operations.length} staged</span>
          </div>

          <div className={styles.operationList}>
            {operations.length === 0 ? (
              <p className={styles.muted}>No staged edits yet.</p>
            ) : (
              operations.map((operation, index) => (
                <div
                  className={styles.operation}
                  key={
                    operation.type +
                    ":" +
                    operation.path +
                    ":" +
                    index
                  }
                >
                  <div>
                    <b>{operationLabel(operation)}</b>
                    <code>{operation.path}</code>
                    {operation.type === "rename" && (
                      <code>→ {operation.toPath}</code>
                    )}
                  </div>
                  <button onClick={() => removeOperation(index)}>×</button>
                </div>
              ))
            )}
          </div>

          <button
            className={styles.previewButton}
            onClick={() => void previewChanges()}
            disabled={
              actionLoading ||
              !operations.length ||
              !ideState?.editable ||
              !ideState.expectedHeadSha
            }
          >
            {actionLoading ? "Working…" : "Preview diff"}
          </button>

          <label className={styles.commitBox}>
            <span>Commit message</span>
            <textarea
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder="Describe this Kosh change"
            />
          </label>

          <button
            className={styles.commitButton}
            onClick={() => void commitChanges()}
            disabled={
              actionLoading ||
              !operations.length ||
              !commitMessage.trim() ||
              !ideState?.editable ||
              !ideState.expectedHeadSha
            }
          >
            Commit to {branch || "branch"}
          </button>

          <p className={styles.safetyNote}>
            Commit uses an expected-head lease. If the branch moves after you
            open it, Kosh rejects the write instead of overwriting newer work.
          </p>
        </aside>
      </section>

      {diffPreview && (
        <section className={styles.diffPanel}>
          <div className={styles.diffHeader}>
            <div>
              <strong>Diff preview</strong>
              <span>{diffPreview.stats || "Changes staged"}</span>
            </div>
            <button onClick={() => setDiffPreview(null)}>Close</button>
          </div>
          <div className={styles.changedFiles}>
            {diffPreview.changedFiles.map((item) => (
              <span key={item.status + item.path + item.toPath}>
                <b>{item.status}</b> {item.path}
                {item.toPath ? " → " + item.toPath : ""}
              </span>
            ))}
          </div>
          <pre>{diffPreview.diff || "No textual diff."}</pre>
          {diffPreview.truncated && (
            <p className={styles.warning}>
              Diff preview was truncated at the configured Kosh IDE limit.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
