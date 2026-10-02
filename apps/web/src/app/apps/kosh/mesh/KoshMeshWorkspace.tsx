"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./mesh.module.css";

type MeshHealth = "good" | "attention" | "blocked" | "failed" | "neutral";

type MeshNode = {
  ref: string;
  kind: "repository" | "component";
  type: string;
  namespace: string;
  key: string;
  name: string;
  description: string;
  state: string;
  health: MeshHealth;
  href: string;
  url: string | null;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

type MeshLink = {
  id: string;
  sourceRef: string;
  targetRef: string;
  relation: string;
  note: string;
  origin: "manual" | "derived";
};

type MeshPayload = {
  state: "stable" | "moving" | "blocked" | "failed";
  counts: {
    repositories: number;
    components: number;
    links: number;
    good: number;
    attention: number;
    blocked: number;
    failed: number;
  };
  nodes: MeshNode[];
  links: MeshLink[];
};

type ImpactPayload = {
  focus: MeshNode;
  upstream: Array<{
    ref: string;
    depth: number;
    relation: string;
    via: string;
    node: MeshNode;
  }>;
  downstream: Array<{
    ref: string;
    depth: number;
    relation: string;
    via: string;
    node: MeshNode;
  }>;
};

const nodeTypes = [
  "service",
  "app",
  "api",
  "package",
  "data",
  "cad",
  "bim",
  "document",
  "environment",
  "deployment",
  "workspace",
  "component"
];

const relations = [
  "depends_on",
  "provides",
  "consumes",
  "publishes",
  "deploys_to",
  "uses",
  "syncs_with",
  "contains",
  "relates_to",
  "replaces",
  "extends"
];

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100";
  return configured.replace(/\/$/, "");
}

function age(value: string) {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";
  return Math.floor(hours / 24) + "d";
}

function label(value: string) {
  return value.replace(/_/g, " ");
}

export function KoshMeshWorkspace() {
  const base = useMemo(apiBase, []);
  const [mesh, setMesh] = useState<MeshPayload | null>(null);
  const [impact, setImpact] = useState<ImpactPayload | null>(null);
  const [focusRef, setFocusRef] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");

  const [type, setType] = useState("service");
  const [namespace, setNamespace] = useState("tamishra");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [state, setState] = useState("active");
  const [url, setUrl] = useState("");
  const [repository, setRepository] = useState("");

  const [sourceRef, setSourceRef] = useState("");
  const [targetRef, setTargetRef] = useState("");
  const [relation, setRelation] = useState("depends_on");
  const [note, setNote] = useState("");

  const fetchJson = useCallback(async <T,>(path: string): Promise<T> => {
    const response = await fetch(base + path, {
      credentials: "include",
      cache: "no-store"
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Kosh request failed.");
    return payload;
  }, [base]);

  const mutateJson = useCallback(
    async <T,>(
      path: string,
      method: "POST" | "DELETE",
      body?: unknown
    ): Promise<T> => {
      const response = await fetch(base + path, {
        method,
        credentials: "include",
        headers:
          body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = (await response.json()) as T & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Kosh request failed.");
      return payload;
    },
    [base]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await fetchJson<MeshPayload>("/v1/kosh/mesh");
      setMesh(payload);
      const params = new URLSearchParams(window.location.search);
      const requestedFocus = params.get("focus")?.trim() || "";
      const nextFocus =
        requestedFocus && payload.nodes.some((node) => node.ref === requestedFocus)
          ? requestedFocus
          : focusRef && payload.nodes.some((node) => node.ref === focusRef)
            ? focusRef
            : payload.nodes[0]?.ref || "";
      setFocusRef(nextFocus);
      if (!sourceRef) setSourceRef(payload.nodes[0]?.ref || "");
      if (!targetRef) setTargetRef(payload.nodes[1]?.ref || "");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Mesh.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, focusRef, sourceRef, targetRef]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!focusRef) {
      setImpact(null);
      return;
    }
    void fetchJson<ImpactPayload>(
      "/v1/kosh/mesh/impact?ref=" + encodeURIComponent(focusRef)
    )
      .then(setImpact)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Impact analysis failed.")
      );
  }, [fetchJson, focusRef]);

  async function createNode(event: FormEvent) {
    event.preventDefault();
    if (!key.trim() || !name.trim()) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson("/v1/kosh/mesh/nodes", "POST", {
        type,
        namespace: namespace.trim(),
        key: key.trim(),
        name: name.trim(),
        description: description.trim(),
        state: state.trim() || "active",
        url: url.trim() || null,
        metadata: repository.trim()
          ? { repository: repository.trim() }
          : {}
      });
      setKey("");
      setName("");
      setDescription("");
      setUrl("");
      setRepository("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create Mesh component.");
    } finally {
      setMutating(false);
    }
  }

  async function createLink(event: FormEvent) {
    event.preventDefault();
    if (!sourceRef || !targetRef || sourceRef === targetRef) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson("/v1/kosh/mesh/links", "POST", {
        sourceRef,
        targetRef,
        relation,
        note: note.trim()
      });
      setNote("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create Mesh relationship.");
    } finally {
      setMutating(false);
    }
  }

  async function deleteNode(node: MeshNode) {
    if (node.kind !== "component") return;
    const id = node.ref.replace(/^node:/, "");
    setMutating(true);
    try {
      await mutateJson("/v1/kosh/mesh/nodes/" + encodeURIComponent(id), "DELETE");
      setFocusRef("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove component.");
    } finally {
      setMutating(false);
    }
  }

  async function deleteLink(link: MeshLink) {
    if (link.origin !== "manual") return;
    setMutating(true);
    try {
      await mutateJson("/v1/kosh/mesh/links/" + encodeURIComponent(link.id), "DELETE");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove relationship.");
    } finally {
      setMutating(false);
    }
  }

  if (loading && !mesh) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Mesh</strong>
        <span>Building the system map…</span>
      </main>
    );
  }

  if (!mesh) {
    return (
      <main className={styles.loading}>
        <strong>Mesh unavailable</strong>
        <span>{error || "Kosh could not build the system map."}</span>
        <Link href="/apps/kosh">Back to Kosh</Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href="/apps/kosh">← Kosh</Link>
          <p>KOSH MESH</p>
          <h1>System Map</h1>
          <span>
            See how repositories, services, apps, APIs, engineering assets and
            runtime environments depend on each other.
          </span>
        </div>
        <div className={styles.stateBox}>
          <span>MESH STATE</span>
          <strong className={styles["state_" + mesh.state]}>{mesh.state}</strong>
          <em>{mesh.counts.repositories} repositories · {mesh.counts.components} components · {mesh.counts.links} links</em>
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        <section className={styles.stats}>
          <div><span>Good</span><strong>{mesh.counts.good}</strong></div>
          <div><span>Moving</span><strong>{mesh.counts.attention}</strong></div>
          <div><span>Blocked</span><strong>{mesh.counts.blocked}</strong></div>
          <div><span>Failed</span><strong>{mesh.counts.failed}</strong></div>
          <div><span>Connections</span><strong>{mesh.counts.links}</strong></div>
        </section>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Mesh nodes</strong>
                <span>Repositories derive health from Flow; components keep their own operational state</span>
              </div>
            </div>
            <div className={styles.nodeGrid}>
              {mesh.nodes.map((node) => (
                <button
                  key={node.ref}
                  className={focusRef === node.ref ? styles.selectedNode : styles.node}
                  onClick={() => setFocusRef(node.ref)}
                >
                  <span className={styles[node.health]}>{node.health}</span>
                  <small>{node.namespace} · {node.type}</small>
                  <strong>{node.name}</strong>
                  <p>{node.description || "No description."}</p>
                  <em>{node.state} · {age(node.updatedAt)}</em>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Impact analysis</strong>
                <span>What this node depends on and what depends on it</span>
              </div>
            </div>
            {impact ? (
              <div className={styles.impact}>
                <span className={styles[impact.focus.health]}>{impact.focus.health}</span>
                <h2>{impact.focus.name}</h2>
                <p>{impact.focus.description || impact.focus.type}</p>
                <div className={styles.impactColumns}>
                  <div>
                    <strong>Upstream</strong>
                    {impact.upstream.map((item) => (
                      <button key={"up-" + item.ref} onClick={() => setFocusRef(item.ref)}>
                        <span>{item.node.name}</span>
                        <em>{label(item.relation)} · depth {item.depth}</em>
                      </button>
                    ))}
                    {!impact.upstream.length && <small>No upstream dependencies.</small>}
                  </div>
                  <div>
                    <strong>Downstream</strong>
                    {impact.downstream.map((item) => (
                      <button key={"down-" + item.ref} onClick={() => setFocusRef(item.ref)}>
                        <span>{item.node.name}</span>
                        <em>{label(item.relation)} · depth {item.depth}</em>
                      </button>
                    ))}
                    {!impact.downstream.length && <small>No downstream impact.</small>}
                  </div>
                </div>
                <div className={styles.impactActions}>
                  <Link href={impact.focus.href}>Open source →</Link>
                  {impact.focus.url && (
                    <a href={impact.focus.url} target="_blank" rel="noreferrer">Open endpoint →</a>
                  )}
                  {impact.focus.kind === "component" && (
                    <button disabled={mutating} onClick={() => void deleteNode(impact.focus)}>
                      Remove component
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className={styles.empty}>Select a node to calculate impact.</div>
            )}
          </section>
        </div>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Add Mesh component</strong>
                <span>Use for systems and engineering assets that are not themselves repositories</span>
              </div>
            </div>
            <form className={styles.form} onSubmit={createNode}>
              <label><span>Type</span><select value={type} onChange={(e) => setType(e.target.value)}>{nodeTypes.map((item) => <option key={item}>{item}</option>)}</select></label>
              <label><span>Namespace</span><input value={namespace} onChange={(e) => setNamespace(e.target.value)} /></label>
              <label><span>Key</span><input value={key} onChange={(e) => setKey(e.target.value)} placeholder="plantstress-api" /></label>
              <label><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="PlantStress API" /></label>
              <label className={styles.wide}><span>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
              <label><span>State</span><input value={state} onChange={(e) => setState(e.target.value)} placeholder="active" /></label>
              <label><span>URL</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." /></label>
              <label className={styles.wide}><span>Repository link</span><input value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="tamishra/repository-slug" /></label>
              <button className={styles.primary} disabled={mutating || !key.trim() || !name.trim()}>Add component</button>
            </form>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Connect systems</strong>
                <span>Define dependencies Kosh cannot safely infer</span>
              </div>
            </div>
            <form className={styles.form} onSubmit={createLink}>
              <label className={styles.wide}><span>From</span><select value={sourceRef} onChange={(e) => setSourceRef(e.target.value)}>{mesh.nodes.map((node) => <option key={node.ref} value={node.ref}>{node.name} ({node.type})</option>)}</select></label>
              <label><span>Relation</span><select value={relation} onChange={(e) => setRelation(e.target.value)}>{relations.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
              <label><span>To</span><select value={targetRef} onChange={(e) => setTargetRef(e.target.value)}>{mesh.nodes.map((node) => <option key={node.ref} value={node.ref}>{node.name}</option>)}</select></label>
              <label className={styles.wide}><span>Note</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why are these connected?" /></label>
              <button className={styles.primary} disabled={mutating || !sourceRef || !targetRef || sourceRef === targetRef}>Create relationship</button>
            </form>
          </section>
        </div>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <strong>System relationships</strong>
              <span>{mesh.links.length} current links</span>
            </div>
          </div>
          <div className={styles.linkList}>
            {mesh.links.map((link) => {
              const source = mesh.nodes.find((node) => node.ref === link.sourceRef);
              const target = mesh.nodes.find((node) => node.ref === link.targetRef);
              return (
                <article key={link.id}>
                  <button onClick={() => setFocusRef(link.sourceRef)}>{source?.name || link.sourceRef}</button>
                  <span>{label(link.relation)}</span>
                  <button onClick={() => setFocusRef(link.targetRef)}>{target?.name || link.targetRef}</button>
                  <small>{link.origin}{link.note ? " · " + link.note : ""}</small>
                  {link.origin === "manual" && <button className={styles.remove} onClick={() => void deleteLink(link)}>Remove</button>}
                </article>
              );
            })}
            {!mesh.links.length && <div className={styles.empty}>No cross-system relationships yet.</div>}
          </div>
        </section>
      </section>
    </main>
  );
}
