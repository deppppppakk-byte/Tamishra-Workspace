"use client";

import Link from "next/link";
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
  watchWorkspaceFileIndex
} from "../lib/workspace-files";
import styles from "./workspace-home.module.css";

const emptyIndex: WorkspaceFileIndex = { version: 1, records: [] };

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
  const [index, setIndex] = useState<WorkspaceFileIndex>(emptyIndex);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [openError, setOpenError] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIndex(loadWorkspaceFileIndex());
    return watchWorkspaceFileIndex(setIndex);
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setCreateOpen(false);
      }
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

  const recentFiles = activeFiles.slice(0, 6);
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

  const create = (kind: "docs" | "sheets" | "slides") => {
    sessionStorage.setItem("tamishra.workspace.create", kind);
    location.assign(`/apps/${kind}`);
  };

  const openFile = async (file: File) => {
    setOpenError("");
    const target = targetAppForNativeFile(file.name);
    if (!target) {
      setOpenError("Unsupported file. Use .tmdoc, .tmsh, .tmsl, .docx, .csv.");
      return;
    }

    try {
      await createNativeFileHandoff(file);
      location.assign(target);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not hand off this file.");
    }
  };

  return (
    <main className={styles.workspace}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand}>
          <div className={styles.brandMark}>T</div>
          <div><strong>Tamishra</strong><span>Workspace</span></div>
        </Link>

        <div className={styles.createWrap}>
          <button className={styles.newButton} onClick={() => setCreateOpen((value) => !value)}>
            + New
          </button>
          {createOpen && (
            <div className={styles.createMenu}>
              <button onClick={() => create("docs")}><b>D</b><span>Document<small>.tmdoc</small></span></button>
              <button onClick={() => create("sheets")}><b>S</b><span>Spreadsheet<small>.tmsh</small></span></button>
              <button onClick={() => create("slides")}><b>P</b><span>Presentation<small>.tmsl</small></span></button>
            </div>
          )}
        </div>

        <nav className={styles.nav}>
          <Link className={styles.active} href="/">Home</Link>
          <Link href="/apps/files?view=recent">Recent</Link>
          <a href="#apps">Apps</a>
          <Link href="/apps/files?view=favorites">Favorites</Link>
          <Link href="/apps/files?view=trash">Trash</Link>
        </nav>

        <div className={styles.storage}>
          <span>Indexed local files</span>
          <strong>{activeFiles.length}</strong>
          <small>{indexedBytes ? `${(indexedBytes / 1024 / 1024).toFixed(1)} MB indexed` : "Metadata + native local storage"}</small>
        </div>
      </aside>

      <section className={styles.content}>
        <header className={styles.topbar}>
          <div className={styles.searchWrap}>
            <span>⌕</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search workspace"
              placeholder="Search files and apps"
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
                    <span>{app.description}</span>
                  </Link>
                ))}
                {!matchingFiles.length && !matchingApps.length && <p>No matching files or apps.</p>}
              </div>
            )}
          </div>
          <div className={styles.topActions}>
            <Link href="/apps/files" title="Files">▤</Link>
            <AccountButton />
          </div>
        </header>

        <section className={styles.hero}>
          <div>
            <p className={styles.eyebrow}>TAMISHRA WORKSPACE</p>
            <h1>Create, calculate, present and communicate from one workspace.</h1>
            <p>Native Tamishra files, local-first recovery, cloud-connected services and one desktop/mobile shell.</p>
          </div>
          <div className={styles.heroActions}>
            <button onClick={() => setCreateOpen(true)}>Create something</button>
            <button className={styles.secondary} onClick={() => fileInputRef.current?.click()}>Open a file</button>
            <input
              ref={fileInputRef}
              hidden
              type="file"
              accept=".tmdoc,.tmsh,.tmsl,.docx,.csv,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void openFile(file);
              }}
            />
          </div>
          {openError && <div className={styles.error}>{openError}</div>}
        </section>

        <section id="apps" className={styles.section}>
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}>APPS</p><h2>Workspace tools</h2></div>
            <Link href="/apps/files">Open Files</Link>
          </div>
          <div className={styles.appGrid}>
            {workspaceApps.map((app) => (
              <Link className={styles.appCard} href={app.href} key={app.id}>
                <div className={styles.appIcon}>{app.shortName}</div>
                <div>
                  <strong>{app.name}</strong>
                  <p>{app.description}</p>
                  <span className={`${styles.status} ${styles[app.status]}`}>{app.status}</span>
                  {app.nativeExtension && <small>{app.nativeExtension}</small>}
                </div>
                <span className={styles.arrow}>↗</span>
              </Link>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeading}>
            <div><p className={styles.eyebrow}>RECENT</p><h2>Continue working</h2></div>
            <Link href="/apps/files?view=recent">View all</Link>
          </div>

          {recentFiles.length ? (
            <div className={styles.recentGrid}>
              {recentFiles.map((file) => (
                <Link className={styles.recentCard} href={file.appHref} key={file.id}>
                  <div className={styles.filePreview}>{fileLabel(file).slice(0, 1)}</div>
                  <div><strong>{file.title}</strong><span>{fileLabel(file)} · {ageLabel(file.lastOpenedAt)}</span></div>
                </Link>
              ))}
            </div>
          ) : (
            <div className={styles.emptyState}>
              <strong>No fake recents.</strong>
              <p>Your real Docs, Sheets and Slides files will appear here after you create or open them.</p>
              <button onClick={() => setCreateOpen(true)}>Create first file</button>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
