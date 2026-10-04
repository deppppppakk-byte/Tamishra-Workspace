"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { workspaceApps } from "@tamishra/workspace-core";
import { AccountButton } from "./account-button";
import styles from "./workspace-app-shell.module.css";

type WorkspaceAppShellProps = {
  currentApp: string;
  title: string;
  subtitle?: string;
  sidebar?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  mode?: "standard" | "editor";
};

export function WorkspaceAppShell({
  currentApp,
  title,
  subtitle,
  sidebar,
  toolbar,
  children,
  mode = "standard"
}: WorkspaceAppShellProps) {
  const current = workspaceApps.find((app) => app.id === currentApp);

  return (
    <main className={`${styles.shell} ${mode === "editor" ? styles.editorShell : ""}`}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand}>
          <span className={styles.brandMark}>T</span>
          <span className={styles.brandText}>
            <strong>Tamishra</strong>
            <small>Workspace</small>
          </span>
        </Link>

        <nav className={styles.primaryNav} aria-label="Workspace navigation">
          <Link href="/"><span>⌂</span>Home</Link>
          <Link href="/apps/files?view=recent"><span>◷</span>Recent</Link>
          <Link className={currentApp === "files" ? styles.active : ""} href="/apps/files"><span>▤</span>Files</Link>
          <Link href="/apps/files?view=favorites"><span>☆</span>Favorites</Link>
        </nav>

        {sidebar ? <div className={styles.sidebarSlot}>{sidebar}</div> : null}

        <div className={styles.divider} />
        <div className={styles.sectionLabel}>APPS</div>
        <nav className={styles.appNav} aria-label="Workspace apps">
          {workspaceApps.map((app) => (
            <Link
              href={app.href}
              key={app.id}
              className={app.id === currentApp ? styles.activeApp : ""}
              title={app.name}
            >
              <span>{app.shortName}</span>
              <b>{app.name.replace("Tamishra ", "")}</b>
            </Link>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <span className={styles.currentMark}>{current?.shortName ?? currentApp.slice(0, 2).toUpperCase()}</span>
          <span>
            <strong>{current?.name.replace("Tamishra ", "") ?? title}</strong>
            <small>{current?.nativeExtension || "Workspace app"}</small>
          </span>
        </div>
      </aside>

      <section className={styles.stage}>
        <header className={styles.topbar}>
          <div className={styles.identity}>
            <span className={styles.appMark}>{current?.shortName ?? currentApp.slice(0, 2).toUpperCase()}</span>
            <div>
              <h1>{title}</h1>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
          </div>
          <div className={styles.toolbar}>
            {toolbar}
            <AccountButton />
          </div>
        </header>

        <div className={`${styles.body} ${mode === "editor" ? styles.editorBody : ""}`}>
          {children}
        </div>
      </section>
    </main>
  );
}
