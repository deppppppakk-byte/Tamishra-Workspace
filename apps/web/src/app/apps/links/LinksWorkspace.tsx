"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  removeWorkspaceLink,
  type WorkspaceLinkEdge,
  type WorkspaceLinkIndex
} from "@tamishra/link-core";
import type {
  TamishraBlock,
  TamishraBlockShelf
} from "@tamishra/blocks-core";
import {
  loadWorkspaceBlockShelf,
  subscribeWorkspaceBlocks
} from "../../../lib/workspace-blocks";
import {
  loadWorkspaceLinkIndex,
  mutateWorkspaceLinkIndex,
  subscribeWorkspaceLinks
} from "../../../lib/workspace-links";
import styles from "./links.module.css";

type Health = "current" | "stale" | "broken";
type View = "all" | Health | "orphaned";

type LinkRow = {
  edge: WorkspaceLinkEdge;
  block: TamishraBlock | null;
  health: Health;
};

const emptyLinks: WorkspaceLinkIndex = {
  version: 1,
  edges: [],
  deleted: {}
};

const emptyBlocks: TamishraBlockShelf = {
  version: 1,
  blocks: [],
  deleted: {}
};

function sourceHref(edge: WorkspaceLinkEdge) {
  if (edge.sourceApp === "forms") {
    return `/apps/forms?form=${encodeURIComponent(edge.sourceResourceId)}`;
  }
  if (edge.sourceApp === "docs") return "/apps/docs";
  if (edge.sourceApp === "sheets") return "/apps/sheets";
  if (edge.sourceApp === "slides") return "/apps/slides";
  if (edge.sourceApp === "notes") return "/apps/notes";
  return "/apps/blocks";
}

function appName(value: string) {
  return (
    {
      docs: "Docs",
      sheets: "Sheets",
      slides: "Slides",
      notes: "Notes",
      forms: "Forms",
      blocks: "Blocks",
      files: "Files",
      workspace: "Workspace"
    }[value] ?? value
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

export default function LinksWorkspace() {
  const [links, setLinks] = useState<WorkspaceLinkIndex>(emptyLinks);
  const [blocks, setBlocks] = useState<TamishraBlockShelf>(emptyBlocks);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");

  const refresh = () => {
    setLinks(loadWorkspaceLinkIndex());
    setBlocks(loadWorkspaceBlockShelf());
  };

  useEffect(() => {
    refresh();
    const offLinks = subscribeWorkspaceLinks(refresh);
    const offBlocks = subscribeWorkspaceBlocks(refresh);
    return () => {
      offLinks();
      offBlocks();
    };
  }, []);

  const rows = useMemo<LinkRow[]>(() => {
    const byId = new Map(blocks.blocks.map((block) => [block.id, block]));
    const normalized = query.trim().toLowerCase();

    return links.edges
      .map((edge) => {
        const block = byId.get(edge.blockId) ?? null;
        const health: Health = !block
          ? "broken"
          : edge.blockVersion < block.version
            ? "stale"
            : "current";
        return { edge, block, health };
      })
      .filter((row) => {
        if (view !== "all" && view !== "orphaned" && row.health !== view) {
          return false;
        }
        if (!normalized) return true;
        return [
          row.edge.sourceTitle ?? "",
          row.edge.sourceApp,
          row.edge.sourceResourceId,
          row.edge.sourceLocator ?? "",
          row.edge.targetTitle ?? "",
          row.edge.targetApp,
          row.edge.targetResourceId,
          row.edge.targetLocator ?? "",
          row.block?.title ?? ""
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      })
      .sort((left, right) =>
        right.edge.updatedAt.localeCompare(left.edge.updatedAt)
      );
  }, [links, blocks, query, view]);

  const linkedIds = useMemo(
    () => new Set(links.edges.map((edge) => edge.blockId)),
    [links]
  );

  const orphaned = useMemo(
    () =>
      blocks.blocks.filter(
        (block) => block.binding?.mode === "live" && !linkedIds.has(block.id)
      ),
    [blocks, linkedIds]
  );

  const counts = useMemo(() => {
    const values = { current: 0, stale: 0, broken: 0 };
    for (const row of links.edges.map((edge) => {
      const block = blocks.blocks.find((item) => item.id === edge.blockId);
      return !block
        ? "broken"
        : edge.blockVersion < block.version
          ? "stale"
          : "current";
    })) {
      values[row] += 1;
    }
    return values;
  }, [links, blocks]);

  const forget = (id: string) => {
    const next = mutateWorkspaceLinkIndex((current) =>
      removeWorkspaceLink(current, id)
    );
    setLinks(next);
  };

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand}>
          ← Tamishra Workspace
        </Link>
        <div className={styles.identity}>
          <span>WORKSPACE SYSTEM</span>
          <h1>Tamishra Links</h1>
          <p>Dependency graph for live Workspace objects.</p>
        </div>

        <nav className={styles.nav}>
          {([
            ["all", "All links", links.edges.length],
            ["current", "Current", counts.current],
            ["stale", "Stale", counts.stale],
            ["broken", "Broken", counts.broken],
            ["orphaned", "No consumers", orphaned.length]
          ] as Array<[View, string, number]>).map(([id, label, count]) => (
            <button
              key={id}
              className={view === id ? styles.active : ""}
              onClick={() => setView(id)}
            >
              <span>{label}</span>
              <b>{count}</b>
            </button>
          ))}
        </nav>

        <div className={styles.shortcut}>
          <Link href="/apps/blocks">Open Block Shelf</Link>
          <Link href="/apps/files">Open Files</Link>
        </div>
      </aside>

      <section className={styles.content}>
        <header className={styles.header}>
          <div>
            <p>LIVE DEPENDENCY GRAPH</p>
            <h2>
              {view === "all"
                ? "All live relationships"
                : view === "orphaned"
                  ? "Live sources without consumers"
                  : `${view[0].toUpperCase() + view.slice(1)} links`}
            </h2>
          </div>
          <div className={styles.controls}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search source, target, range or app"
              aria-label="Search Workspace links"
            />
            <button onClick={refresh}>Refresh</button>
          </div>
        </header>

        <div className={styles.summary}>
          <article>
            <span>Healthy</span>
            <strong>{counts.current}</strong>
          </article>
          <article>
            <span>Waiting refresh</span>
            <strong>{counts.stale}</strong>
          </article>
          <article>
            <span>Broken</span>
            <strong>{counts.broken}</strong>
          </article>
          <article>
            <span>No consumers</span>
            <strong>{orphaned.length}</strong>
          </article>
        </div>

        {view === "orphaned" ? (
          <div className={styles.graphList}>
            {orphaned.map((block) => (
              <article className={styles.orphanCard} key={block.id}>
                <div className={styles.healthDot} data-health="orphaned" />
                <div className={styles.nodeText}>
                  <span>LIVE SOURCE</span>
                  <strong>{block.title}</strong>
                  <small>
                    {appName(block.binding?.source.app ?? block.sourceApp)}
                    {block.binding?.source.locator
                      ? " · " + block.binding.source.locator
                      : ""}
                  </small>
                </div>
                <div className={styles.edgeMeta}>
                  <span>Block v{block.version}</span>
                  <small>
                    Synced {formatDate(block.binding?.lastSyncedAt ?? block.updatedAt)}
                  </small>
                </div>
                <Link href="/apps/blocks" className={styles.openButton}>
                  Add consumer
                </Link>
              </article>
            ))}
            {!orphaned.length && (
              <div className={styles.empty}>
                <strong>No orphaned live Blocks.</strong>
                <p>Every current live source has at least one registered consumer.</p>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.graphList}>
            {rows.map(({ edge, block, health }) => (
              <article className={styles.linkCard} key={edge.id}>
                <div className={styles.healthDot} data-health={health} />

                <div className={styles.node}>
                  <span>SOURCE · {appName(edge.sourceApp)}</span>
                  <strong>{edge.sourceTitle || block?.title || edge.sourceResourceId}</strong>
                  <small>
                    {edge.sourceResourceId}
                    {edge.sourceLocator ? " · " + edge.sourceLocator : ""}
                  </small>
                  <Link href={sourceHref(edge)}>Open source</Link>
                </div>

                <div className={styles.connection}>
                  <span className={styles.line} />
                  <b>{health === "current" ? "LIVE" : health.toUpperCase()}</b>
                  <small>
                    v{edge.blockVersion}
                    {block ? " → v" + block.version : " → missing"}
                  </small>
                  <small>{formatDate(edge.lastSyncedAt)}</small>
                </div>

                <div className={styles.node}>
                  <span>TARGET · {appName(edge.targetApp)}</span>
                  <strong>{edge.targetTitle || edge.targetResourceId}</strong>
                  <small>
                    {edge.targetResourceId}
                    {edge.targetLocator ? " · " + edge.targetLocator : ""}
                  </small>
                  <Link href={edge.targetHref}>Open target</Link>
                </div>

                <div className={styles.actions}>
                  {health === "stale" && (
                    <Link href={edge.targetHref}>Refresh in target</Link>
                  )}
                  {health === "broken" && (
                    <button onClick={() => forget(edge.id)}>
                      Forget broken link
                    </button>
                  )}
                </div>
              </article>
            ))}

            {!rows.length && (
              <div className={styles.empty}>
                <strong>No relationships in this view.</strong>
                <p>
                  Insert a Live Block into Sheets, Docs or Slides to register
                  a real dependency here.
                </p>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
