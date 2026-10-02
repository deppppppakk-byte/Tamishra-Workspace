"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./flow.module.css";

type FlowStage = "plan" | "change" | "validate" | "deliver" | "operate";
type FlowHealth = "neutral" | "good" | "attention" | "blocked" | "failed";
type FlowEntityType =
  | "issue"
  | "change_review"
  | "commit"
  | "workflow_run"
  | "package"
  | "release"
  | "deployment"
  | "milestone"
  | "discussion"
  | "backup"
  | "page_site";

type FlowRelation =
  | "depends_on"
  | "implements"
  | "references"
  | "validated_by"
  | "produces"
  | "promotes_to"
  | "delivers_to"
  | "blocks"
  | "relates_to"
  | "supersedes"
  | "contains";

type Node = {
  id: string;
  type: FlowEntityType;
  ref: string;
  title: string;
  subtitle: string;
  stage: FlowStage;
  state: string;
  health: FlowHealth;
  href: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

type Edge = {
  id: string;
  source: string;
  target: string;
  relation: FlowRelation;
  origin: "derived" | "manual";
  note: string;
};

type TimelineEvent = {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
  actor: string | null;
};

type FlowPayload = {
  repository: {
    id: string;
    namespace: string;
    slug: string;
    name: string;
  };
  state: "stable" | "moving" | "blocked" | "failed";
  summary: {
    nodes: number;
    edges: number;
    manualLinks: number;
    stageCounts: Record<FlowStage, number>;
    healthCounts: Record<FlowHealth, number>;
  };
  nodes: Node[];
  edges: Edge[];
  nextActions: Array<{
    id: string;
    title: string;
    stage: FlowStage;
    health: FlowHealth;
    href: string;
    reason: string;
  }>;
  timeline: TimelineEvent[];
};

const stages: Array<{ key: FlowStage; title: string; hint: string }> = [
  { key: "plan", title: "Shape", hint: "Work, milestones and decisions" },
  { key: "change", title: "Change", hint: "Reviews and commits" },
  { key: "validate", title: "Prove", hint: "Automation and checks" },
  { key: "deliver", title: "Deliver", hint: "Packages and releases" },
  { key: "operate", title: "Run", hint: "Deployments, sites and recovery" }
];

const relations: Array<{ value: FlowRelation; label: string }> = [
  { value: "depends_on", label: "Depends on" },
  { value: "implements", label: "Implements" },
  { value: "references", label: "References" },
  { value: "validated_by", label: "Validated by" },
  { value: "produces", label: "Produces" },
  { value: "promotes_to", label: "Promotes to" },
  { value: "delivers_to", label: "Delivers to" },
  { value: "blocks", label: "Blocks" },
  { value: "relates_to", label: "Relates to" },
  { value: "supersedes", label: "Supersedes" },
  { value: "contains", label: "Contains" }
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
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "d";
  return date.toLocaleDateString();
}

function relationLabel(value: string) {
  return value.replace(/_/g, " ");
}

function splitNodeId(value: string) {
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  return {
    type: value.slice(0, separator) as FlowEntityType,
    ref: value.slice(separator + 1)
  };
}

export function KoshFlowWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [flow, setFlow] = useState<FlowPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [relation, setRelation] = useState<FlowRelation>("relates_to");
  const [note, setNote] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() ?? "");
    setSlug(params.get("slug")?.trim() ?? "");
  }, []);

  const flowBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug) +
      "/flow"
    );
  }, [base, namespace, slug]);

  const repositoryHref = useMemo(() => {
    if (!namespace || !slug) return "/apps/kosh";
    return (
      "/apps/kosh/repository?namespace=" +
      encodeURIComponent(namespace) +
      "&slug=" +
      encodeURIComponent(slug)
    );
  }, [namespace, slug]);

  const fetchJson = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store"
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Kosh request failed.");
    return payload;
  }, []);

  const mutateJson = useCallback(
    async <T,>(
      url: string,
      method: "POST" | "DELETE",
      body?: unknown
    ): Promise<T> => {
      const response = await fetch(url, {
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
    []
  );

  const load = useCallback(async () => {
    if (!flowBase) return;
    setLoading(true);
    setError("");
    try {
      const payload = await fetchJson<FlowPayload>(flowBase);
      setFlow(payload);
      if (!sourceId && payload.nodes[0]) setSourceId(payload.nodes[0].id);
      if (!targetId && payload.nodes[1]) setTargetId(payload.nodes[1].id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Flow.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, flowBase, sourceId, targetId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createLink(event: FormEvent) {
    event.preventDefault();
    if (!flowBase) return;
    const source = splitNodeId(sourceId);
    const target = splitNodeId(targetId);
    if (!source || !target || sourceId === targetId) return;

    setMutating(true);
    setError("");
    try {
      await mutateJson(flowBase + "/links", "POST", {
        sourceType: source.type,
        sourceRef: source.ref,
        targetType: target.type,
        targetRef: target.ref,
        relation,
        note: note.trim()
      });
      setNote("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not link Flow entities.");
    } finally {
      setMutating(false);
    }
  }

  async function deleteLink(edge: Edge) {
    if (!flowBase || edge.origin !== "manual") return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        flowBase + "/links/" + encodeURIComponent(edge.id),
        "DELETE"
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove Flow link.");
    } finally {
      setMutating(false);
    }
  }

  const selectedNode =
    flow?.nodes.find((node) => node.id === selectedNodeId) ?? null;

  const relatedEdges = selectedNode
    ? flow?.edges.filter(
        (edge) =>
          edge.source === selectedNode.id || edge.target === selectedNode.id
      ) ?? []
    : [];

  if (loading && !flow) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Flow</strong>
        <span>Building the live project graph…</span>
      </main>
    );
  }

  if (!flow) {
    return (
      <main className={styles.loading}>
        <strong>Flow unavailable</strong>
        <span>{error || "Kosh could not build this Flow."}</span>
        <Link href={repositoryHref}>Back to repository</Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH FLOW</p>
          <h1>{flow.repository.name}</h1>
          <span>
            One live path from intent to running output. Flow reads existing Kosh
            systems instead of copying their state.
          </span>
        </div>

        <div className={styles.flowState}>
          <span>FLOW STATE</span>
          <strong className={styles["state_" + flow.state]}>{flow.state}</strong>
          <em>{flow.summary.nodes} live entities · {flow.summary.edges} relationships</em>
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        <section className={styles.healthStrip}>
          <div><span>Good</span><strong>{flow.summary.healthCounts.good}</strong></div>
          <div><span>Moving</span><strong>{flow.summary.healthCounts.attention}</strong></div>
          <div><span>Blocked</span><strong>{flow.summary.healthCounts.blocked}</strong></div>
          <div><span>Failed</span><strong>{flow.summary.healthCounts.failed}</strong></div>
          <div><span>Manual links</span><strong>{flow.summary.manualLinks}</strong></div>
        </section>

        <section className={styles.flowBoard}>
          {stages.map((stage) => {
            const nodes = flow.nodes.filter((node) => node.stage === stage.key);
            return (
              <div className={styles.lane} key={stage.key}>
                <div className={styles.laneHeader}>
                  <div>
                    <strong>{stage.title}</strong>
                    <span>{stage.hint}</span>
                  </div>
                  <em>{nodes.length}</em>
                </div>

                <div className={styles.nodeList}>
                  {nodes.slice(0, 60).map((node) => (
                    <button
                      key={node.id}
                      className={
                        selectedNodeId === node.id
                          ? styles.selectedNode
                          : styles.nodeCard
                      }
                      onClick={() => setSelectedNodeId(node.id)}
                    >
                      <span className={styles[node.health]}>{node.health}</span>
                      <strong>{node.title}</strong>
                      <small>{node.subtitle}</small>
                      <em>{node.state} · {age(node.updatedAt)}</em>
                    </button>
                  ))}
                  {!nodes.length && (
                    <div className={styles.laneEmpty}>No live entities.</div>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Next attention</strong>
                <span>Derived from live dependencies and execution state</span>
              </div>
            </div>
            <div className={styles.actionList}>
              {flow.nextActions.map((action) => (
                <Link key={action.id} href={action.href}>
                  <span className={styles[action.health]}>{action.health}</span>
                  <div>
                    <strong>{action.title}</strong>
                    <small>{action.reason}</small>
                  </div>
                  <em>{action.stage}</em>
                </Link>
              ))}
              {!flow.nextActions.length && (
                <div className={styles.empty}>No blocked or active items need attention.</div>
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Connect Flow</strong>
                <span>Add a Kosh relationship only when it cannot be inferred</span>
              </div>
            </div>
            <form className={styles.linkForm} onSubmit={createLink}>
              <label>
                <span>From</span>
                <select
                  value={sourceId}
                  onChange={(event) => setSourceId(event.target.value)}
                >
                  {flow.nodes.map((node) => (
                    <option key={node.id} value={node.id}>{node.title}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Relationship</span>
                <select
                  value={relation}
                  onChange={(event) => setRelation(event.target.value as FlowRelation)}
                >
                  {relations.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>To</span>
                <select
                  value={targetId}
                  onChange={(event) => setTargetId(event.target.value)}
                >
                  {flow.nodes.map((node) => (
                    <option key={node.id} value={node.id}>{node.title}</option>
                  ))}
                </select>
              </label>
              <label className={styles.wide}>
                <span>Note</span>
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Why are these connected?"
                />
              </label>
              <button
                className={styles.primary}
                disabled={mutating || !sourceId || !targetId || sourceId === targetId}
              >
                Link entities
              </button>
            </form>
          </section>
        </div>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Relationship graph</strong>
                <span>{flow.edges.length} derived and manual connections</span>
              </div>
            </div>
            <div className={styles.edgeList}>
              {flow.edges.slice(0, 200).map((edge) => {
                const source = flow.nodes.find((node) => node.id === edge.source);
                const target = flow.nodes.find((node) => node.id === edge.target);
                return (
                  <article key={edge.id}>
                    <div>
                      <strong>{source?.title || edge.source}</strong>
                      <span>{relationLabel(edge.relation)}</span>
                      <strong>{target?.title || edge.target}</strong>
                    </div>
                    <small>{edge.origin}{edge.note ? " · " + edge.note : ""}</small>
                    {edge.origin === "manual" && (
                      <button
                        disabled={mutating}
                        onClick={() => void deleteLink(edge)}
                      >
                        Remove
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Entity inspector</strong>
                <span>State plus connected Flow relationships</span>
              </div>
            </div>
            {selectedNode ? (
              <div className={styles.inspector}>
                <span className={styles[selectedNode.health]}>{selectedNode.health}</span>
                <h2>{selectedNode.title}</h2>
                <p>{selectedNode.subtitle}</p>
                <dl>
                  <div><dt>Type</dt><dd>{selectedNode.type}</dd></div>
                  <div><dt>Stage</dt><dd>{selectedNode.stage}</dd></div>
                  <div><dt>State</dt><dd>{selectedNode.state}</dd></div>
                  <div><dt>Updated</dt><dd>{age(selectedNode.updatedAt)}</dd></div>
                  <div><dt>Connections</dt><dd>{relatedEdges.length}</dd></div>
                </dl>
                <pre>{JSON.stringify(selectedNode.metadata, null, 2)}</pre>
                <Link className={styles.primaryLink} href={selectedNode.href}>
                  Open source system →
                </Link>
              </div>
            ) : (
              <div className={styles.empty}>Select a Flow entity to inspect it.</div>
            )}
          </section>
        </div>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <strong>Unified timeline</strong>
              <span>Work, reviews, automation, delivery and operations together</span>
            </div>
          </div>
          <div className={styles.timeline}>
            {flow.timeline.map((event) => (
              <Link href={event.href} key={event.id}>
                <span />
                <div>
                  <strong>{event.title}</strong>
                  <small>
                    {event.detail}
                    {event.actor ? " · " + event.actor : ""}
                  </small>
                </div>
                <em>{age(event.at)}</em>
              </Link>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}
