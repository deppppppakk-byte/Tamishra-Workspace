"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./wiki.module.css";

type WikiPageSummary = {
  id: string;
  path: string;
  title: string;
  state: string;
  revision: number;
  excerpt: string;
  tags: string[];
  links: string[];
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  updatedByName: string;
};

type WikiPage = WikiPageSummary & {
  content: string;
  format: "markdown";
};

type Revision = {
  id: string;
  revision: number;
  title: string;
  note: string;
  editorName: string;
  createdAt: string;
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function relativeTime(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d ago";
  return new Date(value).toLocaleDateString();
}

function markdownBlocks(content: string) {
  const lines = content.split("\n");
  const blocks: Array<{ kind: string; text: string; level?: number }> = [];
  let code = false;
  let codeBuffer: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (code) {
        blocks.push({ kind: "code", text: codeBuffer.join("\n") });
        codeBuffer = [];
      }
      code = !code;
      continue;
    }
    if (code) {
      codeBuffer.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (/^[-*+]\s+/.test(line)) {
      blocks.push({ kind: "bullet", text: line.replace(/^[-*+]\s+/, "") });
      continue;
    }
    if (/^>\s?/.test(line)) {
      blocks.push({ kind: "quote", text: line.replace(/^>\s?/, "") });
      continue;
    }
    blocks.push({ kind: line.trim() ? "paragraph" : "space", text: line });
  }
  if (codeBuffer.length) blocks.push({ kind: "code", text: codeBuffer.join("\n") });
  return blocks;
}

export default function WikiPage() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [selected, setSelected] = useState<WikiPage | null>(null);
  const [backlinks, setBacklinks] = useState<WikiPageSummary[]>([]);
  const [history, setHistory] = useState<Revision[]>([]);
  const [query, setQuery] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tagText, setTagText] = useState("");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newPath, setNewPath] = useState("");
  const [newContent, setNewContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() || "");
    setSlug(params.get("slug")?.trim() || "");
  }, []);

  const endpoint = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug) +
      "/wiki"
    );
  }, [base, namespace, slug]);

  const request = useCallback(async <T,>(url: string, init?: RequestInit) => {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...init,
      headers:
        init?.body === undefined
          ? init?.headers
          : { "content-type": "application/json", ...(init?.headers || {}) }
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Kosh Wiki request failed.");
    return payload;
  }, []);

  const loadPage = useCallback(
    async (id: string) => {
      if (!endpoint) return;
      setError("");
      try {
        const [detail, historyPayload] = await Promise.all([
          request<{ page: WikiPage; backlinks: WikiPageSummary[] }>(
            endpoint + "/pages/" + encodeURIComponent(id)
          ),
          request<{ history: Revision[] }>(
            endpoint + "/pages/" + encodeURIComponent(id) + "/history"
          )
        ]);
        setSelected(detail.page);
        setBacklinks(detail.backlinks || []);
        setHistory(historyPayload.history || []);
        setTitle(detail.page.title);
        setContent(detail.page.content);
        setTagText((detail.page.tags || []).join(", "));
        setNote("");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not load this page.");
      }
    },
    [endpoint, request]
  );

  const loadPages = useCallback(
    async (search = query, preferredId?: string) => {
      if (!endpoint) return;
      setLoading(true);
      setError("");
      try {
        const suffix = search.trim() ? "?q=" + encodeURIComponent(search.trim()) : "";
        const payload = await request<{ pages: WikiPageSummary[] }>(endpoint + suffix);
        setPages(payload.pages || []);
        const nextId =
          preferredId ||
          (selected && payload.pages.some((page) => page.id === selected.id)
            ? selected.id
            : payload.pages[0]?.id);
        if (nextId) await loadPage(nextId);
        else {
          setSelected(null);
          setBacklinks([]);
          setHistory([]);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not load wiki pages.");
      } finally {
        setLoading(false);
      }
    },
    [endpoint, loadPage, query, request, selected]
  );

  useEffect(() => {
    if (!endpoint) return;
    void loadPages("");
  }, [endpoint]);

  async function createPage() {
    if (!endpoint || !newTitle.trim()) return;
    setBusy(true);
    setError("");
    try {
      const payload = await request<{ page: WikiPage }>(endpoint, {
        method: "POST",
        body: JSON.stringify({
          title: newTitle.trim(),
          path: newPath.trim(),
          content: newContent || "# " + newTitle.trim() + "\n"
        })
      });
      setNewOpen(false);
      setNewTitle("");
      setNewPath("");
      setNewContent("");
      await loadPages("", payload.page.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create page.");
    } finally {
      setBusy(false);
    }
  }

  async function savePage() {
    if (!endpoint || !selected) return;
    setBusy(true);
    setError("");
    try {
      const payload = await request<{ page: WikiPage }>(
        endpoint + "/pages/" + encodeURIComponent(selected.id),
        {
          method: "PATCH",
          body: JSON.stringify({
            expectedRevision: selected.revision,
            title: title.trim(),
            content,
            tags: tagText.split(",").map((value) => value.trim()).filter(Boolean),
            note: note.trim()
          })
        }
      );
      setSelected(payload.page);
      setTitle(payload.page.title);
      setTagText(payload.page.tags.join(", "));
      setNote("");
      await loadPages(query, payload.page.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save page.");
    } finally {
      setBusy(false);
    }
  }

  async function archivePage() {
    if (!endpoint || !selected) return;
    setBusy(true);
    setError("");
    try {
      await request(endpoint + "/pages/" + encodeURIComponent(selected.id), {
        method: "DELETE"
      });
      setSelected(null);
      await loadPages(query);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not archive page.");
    } finally {
      setBusy(false);
    }
  }

  async function restoreRevision(revisionId: string) {
    if (!endpoint || !selected) return;
    setBusy(true);
    setError("");
    try {
      const payload = await request<{ page: WikiPage }>(
        endpoint + "/pages/" + encodeURIComponent(selected.id) + "/restore",
        { method: "POST", body: JSON.stringify({ revisionId }) }
      );
      await loadPages(query, payload.page.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore revision.");
    } finally {
      setBusy(false);
    }
  }

  const dirty = Boolean(
    selected &&
      (title !== selected.title ||
        content !== selected.content ||
        tagText !== selected.tags.join(", "))
  );

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sideTop}>
          <Link
            className={styles.back}
            href={
              namespace && slug
                ? "/apps/kosh/repository?namespace=" +
                  encodeURIComponent(namespace) +
                  "&slug=" +
                  encodeURIComponent(slug)
                : "/apps/kosh"
            }
          >
            ← Repository
          </Link>
          <div className={styles.identity}>
            <span>K</span>
            <div><strong>Wiki</strong><small>{namespace && slug ? namespace + "/" + slug : "Kosh"}</small></div>
          </div>
        </div>

        <div className={styles.searchRow}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void loadPages(query);
            }}
            placeholder="Search documentation"
            aria-label="Search wiki"
          />
          <button onClick={() => void loadPages(query)} aria-label="Search">⌕</button>
        </div>

        <button className={styles.newButton} onClick={() => setNewOpen(true)}>+ New page</button>

        <div className={styles.pageList}>
          {loading && pages.length === 0 && <div className={styles.emptySide}>Loading pages…</div>}
          {!loading && pages.length === 0 && <div className={styles.emptySide}>No pages yet.</div>}
          {pages.map((page) => (
            <button
              key={page.id}
              className={selected?.id === page.id ? styles.pageActive : styles.pageItem}
              onClick={() => void loadPage(page.id)}
            >
              <span>{page.title}</span>
              <small>{page.path} · r{page.revision}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>KOSH KNOWLEDGE</p>
            <h1>{selected ? selected.title : "Repository documentation"}</h1>
          </div>
          {selected && (
            <div className={styles.actions}>
              <div className={styles.segmented}>
                <button className={mode === "edit" ? styles.segmentActive : ""} onClick={() => setMode("edit")}>Edit</button>
                <button className={mode === "preview" ? styles.segmentActive : ""} onClick={() => setMode("preview")}>Preview</button>
              </div>
              <button className={styles.secondary} disabled={busy} onClick={() => void archivePage()}>Archive</button>
              <button className={styles.primary} disabled={busy || !dirty || !title.trim()} onClick={() => void savePage()}>
                {busy ? "Saving…" : "Save revision"}
              </button>
            </div>
          )}
        </header>

        {error && <div className={styles.error}>{error}</div>}

        {newOpen && (
          <section className={styles.createPanel}>
            <div className={styles.createHeading}>
              <div><p className={styles.eyebrow}>NEW DOCUMENT</p><h2>Create wiki page</h2></div>
              <button onClick={() => setNewOpen(false)} aria-label="Close">×</button>
            </div>
            <div className={styles.createGrid}>
              <label>Title<input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Architecture" /></label>
              <label>Path <small>optional</small><input value={newPath} onChange={(event) => setNewPath(event.target.value)} placeholder="engineering/architecture" /></label>
              <label className={styles.full}>Starting content <small>Markdown</small><textarea rows={7} value={newContent} onChange={(event) => setNewContent(event.target.value)} placeholder="# Architecture\n\nDescribe the system…" /></label>
            </div>
            <div className={styles.createActions}>
              <button className={styles.secondary} onClick={() => setNewOpen(false)}>Cancel</button>
              <button className={styles.primary} disabled={busy || !newTitle.trim()} onClick={() => void createPage()}>{busy ? "Creating…" : "Create page"}</button>
            </div>
          </section>
        )}

        {!selected ? (
          <section className={styles.blank}>
            <div className={styles.blankMark}>W</div>
            <h2>Build the repository knowledge base.</h2>
            <p>Create architecture notes, runbooks, onboarding material, design decisions, API guidance, engineering procedures, or project documentation.</p>
            <button className={styles.primary} onClick={() => setNewOpen(true)}>Create first page</button>
          </section>
        ) : (
          <div className={styles.layout}>
            <section className={styles.editorPanel}>
              <div className={styles.documentMeta}>
                <label>
                  <span>Title</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
                </label>
                <label>
                  <span>Tags</span>
                  <input value={tagText} onChange={(event) => setTagText(event.target.value)} placeholder="architecture, api, operations" />
                </label>
                <div className={styles.pathBox}><span>Path</span><code>{selected.path}</code></div>
                <div className={styles.pathBox}><span>Revision</span><strong>r{selected.revision}</strong></div>
              </div>

              {mode === "edit" ? (
                <div className={styles.editor}>
                  <div className={styles.editorBar}><span>Markdown</span><small>{new Blob([content]).size.toLocaleString()} bytes</small></div>
                  <textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck rows={28} />
                  <label className={styles.note}>
                    <span>Revision note</span>
                    <input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="What changed in this revision?" />
                  </label>
                </div>
              ) : (
                <article className={styles.preview}>
                  {markdownBlocks(content).map((block, index) => {
                    if (block.kind === "heading") {
                      const level = Math.min(6, Math.max(1, block.level || 2));
                      if (level === 1) return <h1 key={index}>{block.text}</h1>;
                      if (level === 2) return <h2 key={index}>{block.text}</h2>;
                      if (level === 3) return <h3 key={index}>{block.text}</h3>;
                      return <h4 key={index}>{block.text}</h4>;
                    }
                    if (block.kind === "code") return <pre key={index}><code>{block.text}</code></pre>;
                    if (block.kind === "quote") return <blockquote key={index}>{block.text}</blockquote>;
                    if (block.kind === "bullet") return <div className={styles.bullet} key={index}><span>•</span><p>{block.text}</p></div>;
                    if (block.kind === "space") return <div className={styles.space} key={index} />;
                    return <p key={index}>{block.text}</p>;
                  })}
                </article>
              )}
            </section>

            <aside className={styles.contextPanel}>
              <section>
                <div className={styles.contextTitle}><span>History</span><strong>{history.length}</strong></div>
                <div className={styles.historyList}>
                  {history.slice(0, 12).map((revision) => (
                    <div className={styles.historyItem} key={revision.id}>
                      <div><strong>r{revision.revision}</strong><span>{revision.note || "Revision"}</span></div>
                      <small>{revision.editorName} · {relativeTime(revision.createdAt)}</small>
                      {revision.revision !== selected.revision && (
                        <button disabled={busy} onClick={() => void restoreRevision(revision.id)}>Restore</button>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className={styles.contextTitle}><span>Backlinks</span><strong>{backlinks.length}</strong></div>
                {backlinks.length === 0 ? (
                  <p className={styles.muted}>No other page links here yet.</p>
                ) : backlinks.map((page) => (
                  <button className={styles.backlink} key={page.id} onClick={() => void loadPage(page.id)}>
                    <strong>{page.title}</strong><small>{page.path}</small>
                  </button>
                ))}
              </section>

              <section>
                <div className={styles.contextTitle}><span>Page details</span></div>
                <dl className={styles.details}>
                  <div><dt>Updated</dt><dd>{relativeTime(selected.updatedAt)}</dd></div>
                  <div><dt>Editor</dt><dd>{selected.updatedByName}</dd></div>
                  <div><dt>Outgoing links</dt><dd>{selected.links.length}</dd></div>
                  <div><dt>Status</dt><dd>{selected.state}</dd></div>
                </dl>
              </section>
            </aside>
          </div>
        )}
      </section>
    </main>
  );
}
