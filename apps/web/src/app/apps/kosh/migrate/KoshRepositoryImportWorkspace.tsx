"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import styles from "../build/build.module.css";

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

export function KoshRepositoryImportWorkspace() {
  const gateway = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("tamishra");
  const [slug, setSlug] = useState("kavyn-2d");
  const [sourceUrl, setSourceUrl] = useState("");
  const [secretName, setSecretName] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() || "tamishra");
    setSlug(params.get("slug")?.trim() || "kavyn-2d");
  }, []);

  const query = `namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(slug)}`;
  const repositoryHref = `/apps/kosh/repository?${query}`;

  async function startImport() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const response = await fetch(
        `${gateway}/v1/kosh/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/import/git`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceUrl: sourceUrl.trim(),
            ...(secretName.trim() ? { secretName: secretName.trim() } : {}),
            replaceExisting
          })
        }
      );
      const payload = await response.json() as Record<string, unknown> & { error?: string };
      if (!response.ok) throw new Error(payload.error || `Import failed (${response.status}).`);
      setResult(payload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Repository import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH MIGRATION</p>
          <h1>Import repository</h1>
          <span>Move an existing Git repository into Kosh from the browser. Private source credentials stay in Kosh Secrets.</span>
        </div>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Destination</strong><span>{namespace}/{slug}</span></div>
        </div>
        <div className={styles.buildSummary}>
          <div><span>Namespace</span><strong>{namespace}</strong></div>
          <div><span>Repository</span><strong>{slug}</strong></div>
        </div>

        <label className={styles.hint}>
          Source HTTPS Git URL
          <input
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://github.com/owner/repository.git"
          />
        </label>

        <label className={styles.hint}>
          Kosh Secret name for private source access (optional)
          <input
            value={secretName}
            onChange={(event) => setSecretName(event.target.value)}
            placeholder="SOURCE_GIT_TOKEN"
          />
        </label>

        <label className={styles.hint}>
          <input
            type="checkbox"
            checked={replaceExisting}
            onChange={(event) => setReplaceExisting(event.target.checked)}
          />{" "}
          Replace existing destination refs
        </label>

        <button
          className={styles.primary}
          type="button"
          disabled={busy || !sourceUrl.trim()}
          onClick={() => void startImport()}
        >
          {busy ? "Importing…" : "Import into Kosh"}
        </button>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Import result</strong><span>Kosh verifies Git connectivity and durable persistence before success.</span></div>
        </div>
        <pre className={styles.logs}>{result ? JSON.stringify(result, null, 2) : "No import run yet."}</pre>
      </section>
    </main>
  );
}
