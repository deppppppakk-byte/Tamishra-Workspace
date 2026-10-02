"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import styles from "./environments.module.css";

type Environment = {
  id: string;
  name: string;
  refName: string;
  commitSha: string;
  image: string;
  network: "none" | "egress";
  cpu: number;
  memoryMb: number;
  ttlMinutes: number;
  state: string;
  runnerId: string | null;
  containerId: string | null;
  expiresAt: string;
  createdAt: string;
  failureReason: string | null;
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

export default function EnvironmentsPage() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [items, setItems] = useState<Environment[]>([]);
  const [name, setName] = useState("Development environment");
  const [refName, setRefName] = useState("main");
  const [image, setImage] = useState("node:22-bookworm-slim");
  const [command, setCommand] = useState("while true; do sleep 3600; done");
  const [cpu, setCpu] = useState("1");
  const [memoryMb, setMemoryMb] = useState("1024");
  const [ttlMinutes, setTtlMinutes] = useState("120");
  const [network, setNetwork] = useState<"none" | "egress">("none");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() || "");
    setSlug(params.get("slug")?.trim() || "");
  }, []);

  const endpoint = useMemo(() => {
    if (!namespace || !slug) return "";
    return base + "/v1/kosh/repos/" + encodeURIComponent(namespace) + "/" + encodeURIComponent(slug) + "/environments";
  }, [base, namespace, slug]);

  async function refresh() {
    if (!endpoint) return;
    try {
      const response = await fetch(endpoint, { credentials: "include", cache: "no-store" });
      const payload = await response.json() as { environments?: Environment[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load environments.");
      setItems(payload.environments || []);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load environments.");
    }
  }

  useEffect(() => {
    if (!endpoint) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, [endpoint]);

  async function createEnvironment() {
    if (!endpoint) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name, refName, image, command, network,
          cpu: Number(cpu),
          memoryMb: Number(memoryMb),
          ttlMinutes: Number(ttlMinutes)
        })
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Environment creation failed.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Environment creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function stopEnvironment(id: string) {
    if (!endpoint) return;
    setBusy(true);
    try {
      const response = await fetch(endpoint + "/" + encodeURIComponent(id) + "/stop", {
        method: "POST",
        credentials: "include"
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Stop request failed.");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Stop request failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={namespace && slug ? "/apps/kosh/repository?namespace=" + encodeURIComponent(namespace) + "&slug=" + encodeURIComponent(slug) : "/apps/kosh"}>← Repository</Link>
          <p className={styles.eyebrow}>Kosh Development Environments</p>
          <h1>Disposable, exact-commit workspaces</h1>
          <p>Launch an isolated environment on a Kosh runner without giving the runtime permanent repository credentials.</p>
        </div>
        <div className={styles.repo}>{namespace && slug ? namespace + "/" + slug : "Repository required"}</div>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><span>Create</span><h2>New environment</h2></div>
          <strong>Container isolated</strong>
        </div>
        <div className={styles.grid}>
          <label>Name<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Branch<input value={refName} onChange={(event) => setRefName(event.target.value)} /></label>
          <label>Image<input value={image} onChange={(event) => setImage(event.target.value)} /></label>
          <label>CPU<input value={cpu} onChange={(event) => setCpu(event.target.value)} inputMode="decimal" /></label>
          <label>Memory MB<input value={memoryMb} onChange={(event) => setMemoryMb(event.target.value)} inputMode="numeric" /></label>
          <label>TTL minutes<input value={ttlMinutes} onChange={(event) => setTtlMinutes(event.target.value)} inputMode="numeric" /></label>
          <label>Network<select value={network} onChange={(event) => setNetwork(event.target.value as "none" | "egress")}><option value="none">No network</option><option value="egress">Egress</option></select></label>
          <label className={styles.command}>Startup command<textarea value={command} onChange={(event) => setCommand(event.target.value)} rows={3} /></label>
        </div>
        <button className={styles.primary} disabled={busy || !endpoint} onClick={() => void createEnvironment()}>{busy ? "Working…" : "Launch environment"}</button>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><span>Runtime</span><h2>Environments</h2></div>
          <strong>{items.length} total</strong>
        </div>
        <div className={styles.list}>
          {items.length === 0 && <div className={styles.empty}>No development environments yet.</div>}
          {items.map((item) => (
            <article className={styles.card} key={item.id}>
              <div className={styles.cardHead}>
                <div><h3>{item.name}</h3><code>{item.refName} · {item.commitSha.slice(0, 12)}</code></div>
                <span className={styles.state}>{item.state}</span>
              </div>
              <div className={styles.meta}>
                <span>{item.image}</span><span>{item.cpu} CPU</span><span>{item.memoryMb} MB</span><span>{item.network}</span><span>TTL {item.ttlMinutes}m</span>
              </div>
              {item.runnerId && <p>Runner: <code>{item.runnerId}</code></p>}
              {item.failureReason && <p className={styles.failure}>{item.failureReason}</p>}
              {!["stopped","failed","expired"].includes(item.state) && (
                <button className={styles.secondary} disabled={busy} onClick={() => void stopEnvironment(item.id)}>Stop</button>
              )}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
