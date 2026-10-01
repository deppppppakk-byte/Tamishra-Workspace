"use client";

import Link from "next/link";
import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  deleteBlock,
  parseTamishraBlock,
  searchBlocks,
  serializeTamishraBlock,
  tamishraBlockFilename,
  TMBLOCK_MIME_TYPE,
  type TamishraBlock,
  type TamishraBlockKind,
  type TamishraBlockShelf
} from "@tamishra/blocks-core";
import {
  loadWorkspaceBlockShelf,
  mutateWorkspaceBlockShelf,
  queueBlockHandoff,
  subscribeWorkspaceBlocks
} from "../../../lib/workspace-blocks";
import styles from "./blocks.module.css";

const kindLabels: Record<TamishraBlockKind, string> = {
  "rich-text": "Rich text",
  visual: "Visual",
  table: "Table",
  chart: "Chart",
  form: "Form",
  reference: "Reference",
  custom: "Custom"
};

const targetApps = {
  "rich-text": [
    { id: "notes", label: "Notes" },
    { id: "docs", label: "Docs" }
  ],
  visual: [{ id: "slides", label: "Slides" }],
  table: [
    { id: "sheets", label: "Sheets" },
    { id: "slides", label: "Slides" },
    { id: "docs", label: "Docs" }
  ],
  chart: [
    { id: "slides", label: "Slides" },
    { id: "docs", label: "Docs" }
  ],
  form: [] as Array<{ id: string; label: string }>,
  reference: [] as Array<{ id: string; label: string }>,
  custom: [] as Array<{ id: string; label: string }>
} satisfies Record<TamishraBlockKind, Array<{ id: string; label: string }>>;

function downloadBlock(block: TamishraBlock) {
  const bytes = serializeTamishraBlock(block);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: TMBLOCK_MIME_TYPE });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = tamishraBlockFilename(block.title);
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function BlocksWorkspace() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [shelf, setShelf] = useState<TamishraBlockShelf>(() =>
    loadWorkspaceBlockShelf()
  );
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<TamishraBlockKind | "all">("all");
  const [status, setStatus] = useState("Workspace Block Shelf");

  const visible = useMemo(
    () =>
      searchBlocks(
        shelf,
        query,
        kind === "all" ? undefined : [kind]
      ),
    [shelf, query, kind]
  );

  const refresh = () => setShelf(loadWorkspaceBlockShelf());

  useEffect(() => {
    refresh();
    return subscribeWorkspaceBlocks(refresh);
  }, []);

  const remove = (id: string) => {
    const next = mutateWorkspaceBlockShelf((current) =>
      deleteBlock(current, id)
    );
    setShelf(next);
    setStatus("Block removed");
  };

  const sendTo = (block: TamishraBlock, appId: string) => {
    queueBlockHandoff(block.id, appId);
    location.href = `/apps/${appId}`;
  };

  const importBlock = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    void file
      .arrayBuffer()
      .then((bytes) => {
        const block = parseTamishraBlock(bytes);
        const next = mutateWorkspaceBlockShelf((current) => ({
          ...current,
          blocks: [
            { ...block, updatedAt: new Date().toISOString() },
            ...current.blocks.filter((item) => item.id !== block.id)
          ]
        }));
        setShelf(next);
        setStatus(block.title + " imported");
      })
      .catch((error) =>
        setStatus(
          error instanceof Error ? error.message : "Could not import block"
        )
      );
  };

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <Link href="/" className={styles.back}>← Tamishra Workspace</Link>
          <h1>Tamishra Blocks</h1>
          <p>Reusable workspace objects shared across Tamishra apps.</p>
        </div>
        <div className={styles.headerActions}>
          <button onClick={() => inputRef.current?.click()}>Import .tmblk</button>
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".tmblk,application/x-tamishra-block"
            onChange={importBlock}
          />
        </div>
      </header>

      <section className={styles.controls}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search blocks, apps or tags"
        />
        <select
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as TamishraBlockKind | "all")
          }
        >
          <option value="all">All block types</option>
          {Object.entries(kindLabels).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
        <span>{visible.length} blocks</span>
      </section>

      <section className={styles.grid}>
        {visible.map((block) => (
          <article className={styles.card} key={block.id}>
            <div className={styles.cardTop}>
              <span className={styles.kind}>{kindLabels[block.kind]}</span>
              <span>
                {block.binding?.mode === "live" ? "LIVE · " : ""}
                {block.sourceApp}
              </span>
            </div>
            <h2>{block.title}</h2>
            <p className={styles.meta}>
              Updated {new Date(block.updatedAt).toLocaleString()} · Block v{block.version}
            </p>
            {block.binding?.mode === "live" && (
              <div className={styles.liveSource}>
                <strong>Linked source</strong>
                <span>
                  {block.binding.source.app}
                  {block.binding.source.locator
                    ? " · " + block.binding.source.locator
                    : ""}
                  {block.binding.source.revision !== undefined
                    ? " · rev " + block.binding.source.revision
                    : ""}
                </span>
              </div>
            )}
            {block.tags.length > 0 && (
              <div className={styles.tags}>
                {block.tags.map((tag) => <span key={tag}>{tag}</span>)}
              </div>
            )}
            <div className={styles.sendRow}>
              {targetApps[block.kind].map((app) => (
                <button
                  key={app.id}
                  onClick={() => sendTo(block, app.id)}
                >
                  → {app.label}
                </button>
              ))}
            </div>
            {!targetApps[block.kind].length && (
              <p className={styles.meta}>No compatible app consumer is enabled yet.</p>
            )}
            <div className={styles.cardActions}>
              <button onClick={() => downloadBlock(block)}>Export</button>
              <button className={styles.danger} onClick={() => remove(block.id)}>
                Remove
              </button>
            </div>
          </article>
        ))}
        {!visible.length && (
          <div className={styles.empty}>
            <strong>No blocks yet.</strong>
            <p>Publish reusable content from Slides or Notes to build your Block Shelf.</p>
          </div>
        )}
      </section>

      <footer className={styles.footer}>{status}</footer>
    </main>
  );
}
