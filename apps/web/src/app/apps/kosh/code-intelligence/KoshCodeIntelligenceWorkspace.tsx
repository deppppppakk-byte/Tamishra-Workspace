"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./code-intelligence.module.css";

type CodeIndex = {
  id: string;
  refName: string;
  commitSha: string;
  mode: "full" | "delta";
  state: string;
  fileCount: number;
  symbolCount: number;
  referenceCount: number;
  languages: string[];
  createdAt: string;
  updatedAt: string;
  errorText: string;
};

type SymbolRecord = {
  id: string;
  path: string;
  language: string;
  name: string;
  qualifiedName: string;
  kind: string;
  line: number;
  column: number;
  signature: string;
  owners: string[];
};

type ReferenceRecord = {
  id: string;
  path: string;
  language: string;
  symbolName: string;
  line: number;
  column: number;
  context: string;
};

type Summary = {
  latest: CodeIndex | null;
  indexes: CodeIndex[];
  persistence: string;
  supportedLanguages: string[];
  pushIndexing: boolean;
};

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100";
  return configured.replace(/\/$/, "");
}

function age(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

export function KoshCodeIntelligenceWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [symbols, setSymbols] = useState<SymbolRecord[]>([]);
  const [references, setReferences] = useState<ReferenceRecord[]>([]);
  const [selected, setSelected] = useState<SymbolRecord | null>(null);
  const [definition, setDefinition] = useState<SymbolRecord | null>(null);
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState("");
  const [indexRef, setIndexRef] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

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
      encodeURIComponent(slug) +
      "/code-intelligence"
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

  const loadSymbols = useCallback(
    async (nextQuery = query, nextLanguage = language) => {
      if (!resourceBase) return;
      const params = new URLSearchParams();
      if (nextQuery.trim()) params.set("q", nextQuery.trim());
      if (nextLanguage) params.set("language", nextLanguage);
      params.set("limit", "500");

      try {
        const payload = await fetchJson<{ symbols: SymbolRecord[] }>(
          resourceBase + "/symbols?" + params.toString()
        );
        setSymbols(payload.symbols);
      } catch (reason) {
        if (
          reason instanceof Error &&
          reason.message === "code_index_required"
        ) {
          setSymbols([]);
          return;
        }
        throw reason;
      }
    },
    [fetchJson, language, query, resourceBase]
  );

  const refresh = useCallback(async () => {
    if (!resourceBase) return;
    setLoading(true);
    setError("");
    try {
      const payload = await fetchJson<Summary>(resourceBase);
      setSummary(payload);
      setIndexRef(payload.latest?.refName ?? "main");
      if (payload.latest) await loadSymbols();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not load Code Intelligence."
      );
    } finally {
      setLoading(false);
    }
  }, [fetchJson, loadSymbols, resourceBase]);

  useEffect(() => {
    if (resourceBase) void refresh();
  }, [refresh, resourceBase]);

  async function runIndex() {
    if (!resourceBase) return;
    setMutating(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(resourceBase + "/index", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: indexRef.trim() || undefined })
      });
      const payload = (await response.json()) as CodeIndex & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Indexing failed.");
      }
      setNotice(
        "Indexed " +
          payload.fileCount +
          " files at " +
          payload.commitSha.slice(0, 8) +
          " using " +
          payload.mode +
          " mode."
      );
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Indexing failed.");
    } finally {
      setMutating(false);
    }
  }

  async function search() {
    setError("");
    try {
      await loadSymbols(query, language);
      setSelected(null);
      setDefinition(null);
      setReferences([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Search failed.");
    }
  }

  async function inspectSymbol(symbol: SymbolRecord) {
    if (!resourceBase) return;
    setSelected(symbol);
    setDefinition(null);
    setReferences([]);
    setError("");

    try {
      const params = new URLSearchParams({
        name: symbol.name,
        path: symbol.path
      });
      const [definitionPayload, referencePayload] = await Promise.all([
        fetchJson<{ definition: SymbolRecord | null }>(
          resourceBase + "/definition?" + params.toString()
        ),
        fetchJson<{ references: ReferenceRecord[] }>(
          resourceBase +
            "/references?name=" +
            encodeURIComponent(symbol.name) +
            "&limit=1000"
        )
      ]);
      setDefinition(definitionPayload.definition);
      setReferences(referencePayload.references);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Navigation failed."
      );
    }
  }

  if (!namespace || !slug) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Code Intelligence</strong>
        <span>Repository namespace and slug are required.</span>
        <Link href="/apps/kosh">Back to Kosh</Link>
      </main>
    );
  }

  if (loading) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Code Intelligence</strong>
        <span>Reading repository intelligence…</span>
      </main>
    );
  }

  const latest = summary?.latest ?? null;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link
            href={
              "/apps/kosh/repository?namespace=" +
              encodeURIComponent(namespace) +
              "&slug=" +
              encodeURIComponent(slug)
            }
          >
            ← Repository
          </Link>
          <p>KOSH · NATIVE CODE INTELLIGENCE</p>
          <h1>{namespace}/{slug}</h1>
          <span>
            Commit-aware definitions, references, ownership and language navigation.
          </span>
        </div>

        <div className={styles.stats}>
          <div>
            <strong>{latest?.fileCount ?? 0}</strong>
            <span>indexed files</span>
          </div>
          <div>
            <strong>{latest?.symbolCount ?? 0}</strong>
            <span>symbols</span>
          </div>
          <div>
            <strong>{latest?.referenceCount ?? 0}</strong>
            <span>references</span>
          </div>
          <div>
            <strong>{latest?.mode ?? "—"}</strong>
            <span>latest mode</span>
          </div>
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}
        {notice && <div className={styles.notice}>{notice}</div>}

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <strong>Index control</strong>
              <span>
                Push indexing {summary?.pushIndexing ? "enabled" : "disabled"} · {summary?.persistence}
              </span>
            </div>
            {latest && (
              <code>
                {latest.refName} · {latest.commitSha.slice(0, 12)} · {age(latest.updatedAt)}
              </code>
            )}
          </div>

          <div className={styles.indexBar}>
            <input
              value={indexRef}
              onChange={(event) => setIndexRef(event.target.value)}
              placeholder="branch, tag or commit"
            />
            <button disabled={mutating} onClick={() => void runIndex()}>
              {mutating
                ? "Indexing…"
                : latest
                  ? "Refresh index"
                  : "Build first index"}
            </button>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.searchBar}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void search();
              }}
              placeholder="Search symbol or qualified name"
            />
            <select
              value={language}
              onChange={(event) => {
                const next = event.target.value;
                setLanguage(next);
                void loadSymbols(query, next);
              }}
            >
              <option value="">All languages</option>
              {(summary?.supportedLanguages ?? []).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <button onClick={() => void search()}>Search</button>
          </div>
        </section>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Definitions</strong>
                <span>{symbols.length} visible symbols</span>
              </div>
            </div>

            <div className={styles.symbolList}>
              {symbols.map((symbol) => (
                <button
                  key={symbol.id}
                  className={
                    selected?.id === symbol.id ? styles.selected : ""
                  }
                  onClick={() => void inspectSymbol(symbol)}
                >
                  <span className={styles.kind}>{symbol.kind}</span>
                  <strong>{symbol.qualifiedName}</strong>
                  <small>{symbol.language}</small>
                  <em>{symbol.path}:{symbol.line}</em>
                  {symbol.owners.length > 0 && (
                    <span className={styles.owners}>
                      {symbol.owners.join(" ")}
                    </span>
                  )}
                </button>
              ))}

              {!symbols.length && (
                <div className={styles.empty}>
                  {latest
                    ? "No symbols match this query."
                    : "Build an index to start navigation."}
                </div>
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Navigation</strong>
                <span>Definition and reference graph</span>
              </div>
            </div>

            {selected ? (
              <div className={styles.detail}>
                <article>
                  <span className={styles.kind}>{selected.kind}</span>
                  <h2>{selected.qualifiedName}</h2>
                  <code>{selected.signature || selected.name}</code>
                  <p>
                    {selected.path}:{selected.line}:{selected.column}
                  </p>
                  {selected.owners.length > 0 && (
                    <p>
                      Owners: <strong>{selected.owners.join(" ")}</strong>
                    </p>
                  )}
                </article>

                <div className={styles.definition}>
                  <strong>Go to definition</strong>
                  {definition ? (
                    <button onClick={() => void inspectSymbol(definition)}>
                      {definition.path}:{definition.line} · {definition.qualifiedName}
                    </button>
                  ) : (
                    <span>No indexed definition resolved.</span>
                  )}
                </div>

                <div className={styles.referenceHeader}>
                  <strong>References</strong>
                  <span>{references.length}</span>
                </div>

                <div className={styles.references}>
                  {references.map((reference) => (
                    <article key={reference.id}>
                      <strong>
                        {reference.path}:{reference.line}:{reference.column}
                      </strong>
                      <code>{reference.context}</code>
                    </article>
                  ))}

                  {!references.length && (
                    <div className={styles.empty}>No references found.</div>
                  )}
                </div>
              </div>
            ) : (
              <div className={styles.empty}>
                Choose a symbol to inspect its navigation graph.
              </div>
            )}
          </section>
        </div>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <strong>Index history</strong>
              <span>Commit-addressed snapshots with delta chains</span>
            </div>
          </div>

          <div className={styles.history}>
            {(summary?.indexes ?? []).map((item) => (
              <article key={item.id}>
                <span className={styles[item.state] ?? styles.state}>
                  {item.state}
                </span>
                <strong>{item.refName}</strong>
                <code>{item.commitSha.slice(0, 12)}</code>
                <span>{item.mode}</span>
                <small>
                  {item.fileCount} files · {item.symbolCount} symbols · {age(item.updatedAt)}
                </small>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
