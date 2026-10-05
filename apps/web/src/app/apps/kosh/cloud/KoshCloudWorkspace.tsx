"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./cloud.module.css";

type CloudNode = {
  id: string;
  name: string;
  region: string;
  architecture: string;
  state: "online" | "draining" | "offline";
  totalSlots: number;
  usedSlots: number;
  capabilities: string[];
  lastSeenAt: string;
};

type CloudDeployment = {
  id: string;
  slug: string;
  name: string;
  image: string;
  containerPort: number;
  state: string;
  nodeId: string | null;
  assignmentGeneration: number;
  routeUrl: string | null;
  message: string | null;
  updatedAt: string;
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
  if (!Number.isFinite(time)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export function KoshCloudWorkspace() {
  const router = useRouter();
  const base = useMemo(apiBase, []);
  const [nodes, setNodes] = useState<CloudNode[]>([]);
  const [deployments, setDeployments] = useState<CloudDeployment[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [image, setImage] = useState("");
  const [port, setPort] = useState("3000");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [nodesResponse, deploymentsResponse] = await Promise.all([
        fetch(base + "/v1/kosh/cloud/nodes", { credentials: "include", cache: "no-store" }),
        fetch(base + "/v1/kosh/cloud/deployments", { credentials: "include", cache: "no-store" })
      ]);
      if (nodesResponse.status === 401 || deploymentsResponse.status === 401) {
        router.replace("/sign-in");
        return;
      }
      if (!nodesResponse.ok || !deploymentsResponse.ok) {
        const failed = !nodesResponse.ok ? nodesResponse : deploymentsResponse;
        const payload = (await failed.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `Kosh Cloud request failed (${failed.status}).`);
      }
      const nodesPayload = (await nodesResponse.json()) as { nodes?: CloudNode[] };
      const deploymentsPayload = (await deploymentsResponse.json()) as {
        deployments?: CloudDeployment[];
      };
      setNodes(nodesPayload.nodes ?? []);
      setDeployments(deploymentsPayload.deployments ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Cloud.");
    } finally {
      setLoading(false);
    }
  }, [base, router]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function createDeployment(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError("");
    try {
      const response = await fetch(base + "/v1/kosh/cloud/deployments", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), image: image.trim(), containerPort: Number(port) })
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.status === 401) {
        router.replace("/sign-in");
        return;
      }
      if (!response.ok) throw new Error(payload.error || "Deployment creation failed.");
      setName("");
      setImage("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Deployment creation failed.");
    } finally {
      setCreating(false);
    }
  }

  async function schedule(deploymentId: string) {
    setError("");
    try {
      const response = await fetch(
        base + `/v1/kosh/cloud/deployments/${encodeURIComponent(deploymentId)}/schedule`,
        { method: "POST", credentials: "include" }
      );
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not schedule deployment.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not schedule deployment.");
    }
  }

  const online = nodes.filter((node) => node.state === "online").length;
  const totalSlots = nodes.reduce((sum, node) => sum + node.totalSlots, 0);
  const usedSlots = nodes.reduce((sum, node) => sum + node.usedSlots, 0);
  const running = deployments.filter((deployment) => deployment.state === "running").length;

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Kosh by Tamishra</div>
          <h1>Kosh Cloud</h1>
          <p>Our own controller, scheduler and compute nodes.</p>
        </div>
        <div className={styles.headerActions}>
          <button type="button" onClick={() => void load()} disabled={loading}>
            Refresh
          </button>
          <Link href="/apps/kosh">Repositories</Link>
        </div>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.metrics} aria-label="Kosh Cloud summary">
        <article><span>Nodes online</span><strong>{online}/{nodes.length}</strong></article>
        <article><span>Compute slots</span><strong>{usedSlots}/{totalSlots}</strong></article>
        <article><span>Deployments</span><strong>{deployments.length}</strong></article>
        <article><span>Running</span><strong>{running}</strong></article>
      </section>

      <div className={styles.grid}>
        <section className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><h2>Compute nodes</h2><p>Heartbeat-based capacity managed by Kosh.</p></div>
          </div>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>Node</th><th>Region</th><th>Status</th><th>Capacity</th><th>Last heartbeat</th></tr></thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.id}>
                    <td><strong>{node.name}</strong><small>{node.architecture}</small></td>
                    <td>{node.region}</td>
                    <td><span className={`${styles.badge} ${styles[node.state]}`}>{node.state}</span></td>
                    <td>{node.usedSlots} / {node.totalSlots}</td>
                    <td>{relativeTime(node.lastSeenAt)}</td>
                  </tr>
                ))}
                {!nodes.length ? <tr><td colSpan={5} className={styles.empty}>No Kosh Nodes enrolled yet.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><h2>Deploy a service</h2><p>Kosh schedules the image onto an available node.</p></div>
          </div>
          <form className={styles.form} onSubmit={createDeployment}>
            <label>Service name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="kosh-gateway" required /></label>
            <label>Container image<input value={image} onChange={(event) => setImage(event.target.value)} placeholder="registry.example.com/kosh:latest" required /></label>
            <label>Container port<input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" required /></label>
            <button type="submit" disabled={creating}>{creating ? "Scheduling…" : "Deploy"}</button>
          </form>
        </section>
      </div>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><h2>Deployments</h2><p>Every assignment is fenced with a generation number.</p></div>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead><tr><th>Service</th><th>Image</th><th>Status</th><th>Node</th><th>Generation</th><th>Route</th><th /></tr></thead>
            <tbody>
              {deployments.map((deployment) => (
                <tr key={deployment.id}>
                  <td><strong>{deployment.name}</strong><small>{deployment.slug}</small></td>
                  <td className={styles.mono}>{deployment.image}</td>
                  <td><span className={styles.badge}>{deployment.state}</span></td>
                  <td>{deployment.nodeId ? deployment.nodeId.slice(0, 8) : "—"}</td>
                  <td>{deployment.assignmentGeneration}</td>
                  <td>{deployment.routeUrl ? <a href={deployment.routeUrl} target="_blank" rel="noreferrer">Open</a> : "—"}</td>
                  <td>{deployment.state === "pending" ? <button type="button" onClick={() => void schedule(deployment.id)}>Schedule</button> : null}</td>
                </tr>
              ))}
              {!deployments.length ? <tr><td colSpan={7} className={styles.empty}>No services deployed yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
