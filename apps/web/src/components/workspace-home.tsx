"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceFileIndex, WorkspaceFileRecord } from "@tamishra/file-core";
import { workspaceApps } from "@tamishra/workspace-core";
import { AccountButton } from "./account-button";
import {
  createNativeFileHandoff,
  targetAppForNativeFile
} from "../lib/native-file-handoff";
import {
  loadWorkspaceFileIndex,
  syncWorkspaceFileIndexFromCloud,
  watchWorkspaceFileIndex
} from "../lib/workspace-files";
import styles from "./workspace-home.module.css";

const emptyIndex: WorkspaceFileIndex = { version: 1, records: [] };

const createOptions = [
  { kind: "docs", label: "Document", extension: ".tmdoc", mark: "D" },
  { kind: "sheets", label: "Spreadsheet", extension: ".tmsh", mark: "S" },
  { kind: "slides", label: "Presentation", extension: ".tmsl", mark: "P" },
  { kind: "notes", label: "Note", extension: ".tmnt", mark: "N" },
  { kind: "forms", label: "Form", extension: ".tmfm", mark: "F" }
] as const;

type CreateKind = (typeof createOptions)[number]["kind"];

function ageLabel(value: string) {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff) || diff < 0) return "Recently";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}

function fileLabel(file: WorkspaceFileRecord) {
  const app = workspaceApps.find((item) => item.id === file.kind);
  return app?.name.replace("Tamishra ", "") ?? file.kind;
}

export function WorkspaceHomeClient() {
  const router = useRouter();
  const [index, setIndex] = useState<WorkspaceFileIndex>(emptyIndex);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [openError, setOpenError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIndex(loadWorkspaceFileIndex());
    void syncWorkspaceFileIndexFromCloud().then(setIndex);
    return watchWorkspaceFileIndex(setIndex);
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") setCreateOpen(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const activeFiles = useMemo(
    () =>
      index.records
        .filter((item) => !item.trashedAt)
        .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
    [index]
  );

  const recentFiles = activeFiles.slice(0, 8);
  const normalizedQuery = query.trim().toLowerCase();
  const matchingApps = normalizedQuery
    ? workspaceApps.filter((app) =>
        [app.name, app.description, app.nativeExtension ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery)
      )
    : [];
  const matchingFiles = normalizedQuery
    ? activeFiles
        .filter((file) =>
          [file.title, file.kind, file.nativeExtension ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery)
        )
        .slice(0, 8)
    : [];

  const indexedBytes = activeFiles.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);

  const create = (kind: CreateKind) => {
    sessionStorage.setItem("tamishra.workspace.create", kind);
    setCreateOpen(false);
    router.push(`/apps/${kind}`);
  };

  const openFile = async (file: File) => {
    setOpenError("");
    const target = targetAppForNativeFile(file.name);
    if (!target) {
      setOpenError("This file type is not supported yet.");
      return;
    }

    try {
      await createNativeFileHandoff(file);
      router.push(target);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not open this file.");
    }
  };

  return (
    <main className={styles.workspace}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandMark}>T</span>
          <span className={styles.brandText}><strong>Tamishra</strong><small>Workspace</small></span>
        </Link>

        <div className={styles.createWrap}>
          <button className={styles.newButton} onClick={() => setCreateOpen((value) => !value)}>
            <span>＋</span> New
          </button>
          {createOpen && (
            <div className={styles.createMenu}>
              {createOptions.map((item) => (
                <button key={item.kind} onClick={() => create(item.kind)}>
                  <b>{item.mark}</b>
                  <span>{item.label}<small>{item.extension}</small></span>
                </button>
              ))}
            </div>
          )}
        </div>

        <nav className={styles.nav} aria-label="Workspace navigation">
          <Link className={styles.active} href="/"><span>⌂</span>Home</Link>
          <Link href="/apps/files?view=recent"><span>◷</span>Recent</Link>
          <Link href="/apps/files"><span>▤</span>Files</Link>
          <Link href="/apps/files?view=favorites"><span>☆</span>Favorites</Link>
          <Link href="/apps/files?view=trash"><span>⌫</span>Trash</Link>
        </nav>

        <div className={styles.sidebarDivider} />
        <div className={styles.sidebarLabel}>WORKSPACE</div>
        <nav className={styles.appNav} aria-label="Workspace apps">
          {workspaceApps.slice(0, 7).map((app) => (
            <Link href={app.href} key={app.id}>
              <span>{app.shortName}</span>{app.name.replace("Tamishra ", "")}
            </Link>
          ))}
        </nav>

        <div className={styles.storage}>
          <div><span>Local index</span><strong>{activeFiles.length} files</strong></div>
          <small>{indexedBytes ? `${(indexedBytes / 1024 / 1024).toFixed(1)} MB indexed` : "Ready"}</small>
        </div>
      </aside>

      <section className={styles.content}>
        <header className={styles.topbar}>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>⌕</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search workspace"
              placeholder="Search Workspace"
            />
            <kbd>Ctrl K</kbd>
            {normalizedQuery && (
              <div className={styles.searchResults}>
                {matchingFiles.map((file) => (
                  <Link href={file.appHref} key={file.id}>
                    <b>{file.title}</b>
                    <span>{fileLabel(file)} · {ageLabel(file.lastOpenedAt)}</span>
                  </Link>
                ))}
                {matchingApps.map((app) => (
                  <Link href={app.href} key={app.id}>
                    <b>{app.name}</b>
                    <span>{app.nativeExtension || "Workspace app"}</span>
                  </Link>
                ))}
                {!matchingFiles.length && !matchingApps.length && <p>No results</p>}
              </div>
            )}
          </div>
          <div className={styles.topActions}>
            <button title="Open file" onClick={() => fileInputRef.current?.click()}>Open</button>
            <AccountButton />
          </div>
        </header>

        <input
          ref={fileInputRef}
          hidden
          type="file"
          accept=".tmdoc,.tmsh,.tmsl,.tmnt,.tmfm,.docx,.csv,.json,.pdf"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void openFile(file);
          }}
        />

        <div className={styles.pageTitle}>
          <div>
            <h1>Workspace</h1>
            <p>Files, tools and communication in one place.</p>
          </div>
          {openError && <span className={styles.error}>{openError}</span>}
        </div>

        <section className={styles.quickCreate} aria-labelledby="quick-create-title">
          <div className={styles.sectionTitle}>
            <h2 id="quick-create-title">Create</h2>
          </div>
          <div className={styles.createGrid}>
            {createOptions.map((item) => (
              <button key={item.kind} onClick={() => create(item.kind)}>
                <span className={styles.createIcon}>{item.mark}</span>
                <span><strong>{item.label}</strong><small>{item.extension}</small></span>
              </button>
            ))}
            <button onClick={() => fileInputRef.current?.click()}>
              <span className={styles.createIcon}>↥</span>
              <span><strong>Open file</strong><small>From this device</small></span>
            </button>
          </div>
        </section>

        <div className={styles.workbench}>
          <section className={styles.recentPanel}>
            <div className={styles.sectionTitle}>
              <h2>Recent files</h2>
              <Link href="/apps/files?view=recent">View all</Link>
            </div>

            <div className={styles.fileTable}>
              <div className={styles.fileTableHead}>
                <span>Name</span><span>Type</span><span>Modified</span>
              </div>
              {recentFiles.length ? recentFiles.map((file) => (
                <Link className={styles.fileRow} href={file.appHref} key={file.id}>
                  <span className={styles.fileName}><b>{fileLabel(file).slice(0, 1)}</b><strong>{file.title}</strong></span>
                  <span>{fileLabel(file)}</span>
                  <span>{ageLabel(file.lastOpenedAt)}</span>
                </Link>
              )) : (
                <div className={styles.emptyRow}>
                  <span>No recent files</span>
                  <button onClick={() => create("docs")}>Create a document</button>
                </div>
              )}
            </div>
          </section>

          <aside className={styles.appsPanel} id="apps">
            <div className={styles.sectionTitle}>
              <h2>Apps</h2>
              <Link href="/apps/files">Files</Link>
            </div>
            <div className={styles.appList}>
              {workspaceApps.map((app) => (
                <Link href={app.href} key={app.id}>
                  <span className={styles.appIcon}>{app.shortName}</span>
                  <span className={styles.appName}><strong>{app.name.replace("Tamishra ", "")}</strong><small>{app.nativeExtension || app.description}</small></span>
                  <span className={styles.chevron}>›</span>
                </Link>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
