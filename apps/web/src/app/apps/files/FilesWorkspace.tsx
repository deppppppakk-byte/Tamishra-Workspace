"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  permanentlyDeleteWorkspaceFile,
  restoreWorkspaceFile,
  toggleWorkspaceFileFavorite,
  trashWorkspaceFile,
  type WorkspaceFileIndex,
  type WorkspaceFileRecord
} from "@tamishra/file-core";
import { workspaceApps } from "@tamishra/workspace-core";
import { WorkspaceAppShell } from "../../../components/workspace-app-shell";
import {
  createNativeFileHandoff,
  targetAppForNativeFile
} from "../../../lib/native-file-handoff";
import { deleteWorkspaceBinaryAsset } from "../../../lib/workspace-binary-store";
import { deleteCloudBinaryAsset } from "../../../lib/workspace-binary-cloud";
import {
  loadWorkspaceFileIndex,
  mutateWorkspaceFileIndex,
  watchWorkspaceFileIndex
} from "../../../lib/workspace-files";
import styles from "./files.module.css";

type View = "all" | "recent" | "favorites" | "trash";

const emptyIndex: WorkspaceFileIndex = { version: 1, records: [] };
const views: View[] = ["all", "recent", "favorites", "trash"];

function kindName(file: WorkspaceFileRecord) {
  return workspaceApps.find((item) => item.id === file.kind)?.name ?? file.kind;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function viewLabel(view: View) {
  return view === "all" ? "All files" : view[0].toUpperCase() + view.slice(1);
}

export default function FilesWorkspace() {
  const [index, setIndex] = useState<WorkspaceFileIndex>(emptyIndex);
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"recent" | "name" | "type">("recent");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIndex(loadWorkspaceFileIndex());
    const requested = new URLSearchParams(location.search).get("view");
    if (views.includes(requested as View)) setView(requested as View);
    return watchWorkspaceFileIndex(setIndex);
  }, []);

  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    let records = index.records.filter((item) =>
      view === "trash" ? Boolean(item.trashedAt) : !item.trashedAt
    );

    if (view === "favorites") records = records.filter((item) => item.favorite);
    if (view === "recent") {
      records = records
        .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
        .slice(0, 30);
    }

    if (normalized) {
      records = records.filter((item) =>
        [item.title, item.kind, item.nativeExtension ?? "", kindName(item)]
          .join(" ")
          .toLowerCase()
          .includes(normalized)
      );
    }

    return [...records].sort((a, b) => {
      if (sort === "name") return a.title.localeCompare(b.title);
      if (sort === "type") return a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title);
      return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
    });
  }, [index, query, sort, view]);

  const update = (next: WorkspaceFileIndex) => {
    mutateWorkspaceFileIndex(() => next);
  };

  const openExternal = async (file: File) => {
    setError("");
    const target = targetAppForNativeFile(file.name);
    if (!target) {
      setError("Unsupported file. Open a Tamishra native file, DOCX, CSV or PDF.");
      return;
    }

    try {
      await createNativeFileHandoff(file);
      location.assign(target);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open this file.");
    }
  };

  const setViewAndUrl = (next: View) => {
    setView(next);
    const url = next === "all" ? "/apps/files" : `/apps/files?view=${next}`;
    history.replaceState(null, "", url);
  };

  const favorites = index.records.filter((item) => item.favorite && !item.trashedAt).length;
  const trashed = index.records.filter((item) => item.trashedAt).length;

  return (
    <WorkspaceAppShell
      currentApp="files"
      title={viewLabel(view)}
      subtitle="Browse, search and manage Workspace artifacts."
      sidebar={
        <nav className={styles.viewNav} aria-label="File views">
          {views.map((item) => (
            <button
              key={item}
              className={view === item ? styles.activeView : ""}
              onClick={() => setViewAndUrl(item)}
            >
              <span>{item === "all" ? "▤" : item === "recent" ? "◷" : item === "favorites" ? "☆" : "⌫"}</span>
              {viewLabel(item)}
            </button>
          ))}
        </nav>
      }
      toolbar={
        <div className={styles.controls}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files"
            aria-label="Search files"
          />
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="recent">Last opened</option>
            <option value="name">Name</option>
            <option value="type">Type</option>
          </select>
          <button onClick={() => fileInputRef.current?.click()}>Open file</button>
        </div>
      }
    >
      <input
        ref={fileInputRef}
        hidden
        type="file"
        accept=".tmdoc,.tmsh,.tmsl,.tmnt,.tmfm,.docx,.csv,.json,.pdf"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void openExternal(file);
        }}
      />

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.summary}>
        <span><strong>{rows.length}</strong> in view</span>
        <span><strong>{favorites}</strong> favorites</span>
        <span><strong>{trashed}</strong> trash</span>
      </div>

      <section className={styles.panel} aria-label="Workspace files">
        <div className={styles.panelHeader}>
          <div>
            <strong>{viewLabel(view)}</strong>
            <span>{rows.length} item{rows.length === 1 ? "" : "s"}</span>
          </div>
          <div className={styles.createLinks}>
            <Link href="/apps/docs">New document</Link>
            <Link href="/apps/sheets">New sheet</Link>
            <Link href="/apps/slides">New presentation</Link>
          </div>
        </div>

        {rows.length ? (
          <div className={styles.table}>
            <div className={styles.tableHeader}>
              <span>Name</span><span>Type</span><span>Modified</span><span>Storage</span><span>Actions</span>
            </div>
            {rows.map((file) => (
              <div className={styles.row} key={file.id}>
                <Link href={file.appHref} className={styles.fileName}>
                  <b>{kindName(file).replace("Tamishra ", "").slice(0, 1)}</b>
                  <span><strong>{file.title}</strong><small>{file.nativeExtension || "workspace item"}</small></span>
                </Link>
                <span>{kindName(file).replace("Tamishra ", "")}</span>
                <span>{formatDate(file.updatedAt)}</span>
                <span>{file.storage}</span>
                <div className={styles.actions}>
                  {file.trashedAt ? (
                    <>
                      <button onClick={() => update(restoreWorkspaceFile(index, file.id))}>Restore</button>
                      <button
                        className={styles.danger}
                        onClick={() => {
                          if (confirm("Permanently delete this file from Tamishra Workspace?")) {
                            if (file.kind === "pdf" && file.sourceId) {
                              void deleteWorkspaceBinaryAsset(file.sourceId).catch(() => undefined);
                              void deleteCloudBinaryAsset(file.sourceId);
                            }
                            update(permanentlyDeleteWorkspaceFile(index, file.id));
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className={file.favorite ? styles.favorite : ""}
                        title={file.favorite ? "Remove from favorites" : "Add to favorites"}
                        onClick={() => update(toggleWorkspaceFileFavorite(index, file.id))}
                      >
                        {file.favorite ? "★" : "☆"}
                      </button>
                      <button onClick={() => update(trashWorkspaceFile(index, file.id))}>Trash</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.empty}>
            <strong>{query ? "No matching files" : "No files in this view"}</strong>
            <p>Workspace only lists real indexed artifacts. It does not insert demo files.</p>
            <button onClick={() => fileInputRef.current?.click()}>Open a file</button>
          </div>
        )}
      </section>
    </WorkspaceAppShell>
  );
}
