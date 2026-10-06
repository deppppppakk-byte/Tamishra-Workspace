"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./deploy.module.css";

type Revision = {
  id: string;
  revision: number;
  refName: string;
  commitSha: string;
  cloudDeploymentId: string | null;
  cloudDeploymentSlug: string | null;
  state: "pending" | "active" | "superseded" | "failed" | "stopped";
  rollbackOfRevision: number | null;
  createdAt: string;
};

type Service = {
  id: string;
  slug: string;
  name: string;
  namespace: string;
  repositorySlug: string;
  containerPort: number;
  dockerfilePath: string;
  contextPath: string;
  healthPath: string;
  exposure: "private" | "public";
  activeRevisionId: string | null;
  pendingRevisionId: string | null;
  activeRevision: Revision | null;
  pendingRevision: Revision | null;
  revisions: Revision[];
  updatedAt: string;
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function shortSha(value: string) {
  return value ? value.slice(0, 12) : "—";
}

function time(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function KoshDeployWorkspace() {
  const router = useRouter();
  const base = useMemo(apiBase, []);
  const [services, setServices] = useState<Service[]>([]);
  const [namespace, setNamespace] = useState("tamishra");
  const [repositorySlug, setRepositorySlug] = useState("kavyn-2d");
  const [refName, setRefName] = useState("main");
  const [name, setName] = useState("");
  const [serviceSlug, setServiceSlug] = useState("");
  const [containerPort, setContainerPort] = useState("3000");
  const [dockerfilePath, setDockerfilePath] = useState("Dockerfile");
  const [contextPath, setContextPath] = useState(".");
  const [healthPath, setHealthPath] = useState("/");
  const [exposure, setExposure] = useState<"private" | "public">("private");
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ns = params.get("namespace")?.trim();
    const slug = params.get("slug")?.trim();
    if (ns) setNamespace(ns);
    if (slug) {
      setRepositorySlug(slug);
      setServiceSlug(slug);
      setName(slug);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(base + "/v1/kosh/deploy/services", {
        credentials: "include",
        cache: "no-store"
      });
      if (response.status === 401) {
        router.replace("/sign-in");
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { services?: Service[]; error?: string };
      if (!response.ok) throw new Error(payload.error || `Kosh Deploy request failed (${response.status}).`);
      setServices(payload.services ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Deploy.");
    } finally {
      setLoading(false);
    }
  }, [base, router]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function deployService(event: FormEvent) {
    event.preventDefault();
    setDeploying(true);
    setError("");
    try {
      const response = await fetch(base + "/v1/kosh/deploy/services", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          namespace: namespace.trim(),
          repositorySlug: repositorySlug.trim(),
          refName: refName.trim(),
          name: name.trim() || repositorySlug.trim(),
          serviceSlug: serviceSlug.trim() || repositorySlug.trim(),
          containerPort: Number(containerPort),
          dockerfilePath: dockerfilePath.trim(),
          contextPath: contextPath.trim(),
          healthPath: healthPath.trim(),
          exposure
        })
      });
      if (response.status === 401) {
        router.replace("/sign-in");
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `Deploy failed (${response.status}).`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Deploy failed.");
    } finally {
      setDeploying(false);
    }
  }

  async function rollback(service: Service, revision: number) {
    const key = `${service.slug}:${revision}`;
    setBusy(key);
    setError("");
    try {
      const response = await fetch(base + `/v1/kosh/deploy/services/${encodeURIComponent(service.slug)}/rollback`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision })
      });
      if (response.status === 401) {
        router.replace("/sign-in");
        return;
      }
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || `Rollback failed (${response.status}).`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Rollback failed.");
    } finally {
      setBusy("");
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={`/apps/kosh/repository?namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(repositorySlug)}`}>← Repository</Link>
          <p>KOSH DEPLOY</p>
          <h1>Deploy Center</h1>
          <span>Deploy directly from a Kosh Git revision. Kosh builds the Docker image on its own node, health-checks it, switches traffic only after it is healthy, and keeps rollback history.</span>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>Refresh</button>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>New deployment</strong><span>No Vercel or external container registry required for Kosh source deploys.</span></div>
        </div>
        <form className={styles.form} onSubmit={deployService}>
          <label>Namespace<input value={namespace} onChange={(event) => setNamespace(event.target.value)} required /></label>
          <label>Repository<input value={repositorySlug} onChange={(event) => setRepositorySlug(event.target.value)} required /></label>
          <label>Git ref<input value={refName} onChange={(event) => setRefName(event.target.value)} required /></label>
          <label>Service name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Tamishra Workspace" /></label>
          <label>Stable service slug<input value={serviceSlug} onChange={(event) => setServiceSlug(event.target.value)} placeholder={repositorySlug} /></label>
          <label>Container port<input value={containerPort} onChange={(event) => setContainerPort(event.target.value)} inputMode="numeric" required /></label>
          <label>Dockerfile<input value={dockerfilePath} onChange={(event) => setDockerfilePath(event.target.value)} required /></label>
          <label>Build context<input value={contextPath} onChange={(event) => setContextPath(event.target.value)} required /></label>
          <label>Health path<input value={healthPath} onChange={(event) => setHealthPath(event.target.value)} required /></label>
          <label>Exposure<select value={exposure} onChange={(event) => setExposure(event.target.value as "private" | "public")}><option value="private">Private</option><option value="public">Public</option></select></label>
          <button className={styles.primary} type="submit" disabled={deploying}>{deploying ? "Deploying…" : "Deploy from Kosh"}</button>
        </form>
      </section>

      <section className={styles.services}>
        {services.map((service) => {
          const url = `${base}/v1/kosh/deploy/apps/${encodeURIComponent(service.slug)}/`;
          return (
            <article className={styles.service} key={service.id}>
              <div className={styles.serviceHead}>
                <div>
                  <strong>{service.name}</strong>
                  <span>{service.namespace}/{service.repositorySlug}</span>
                </div>
                <span className={styles.badge}>{service.pendingRevision ? "deploying" : service.activeRevision ? "live" : "waiting"}</span>
              </div>
              <div className={styles.meta}>
                <span>Active: {service.activeRevision ? `r${service.activeRevision.revision} · ${shortSha(service.activeRevision.commitSha)}` : "—"}</span>
                <span>Pending: {service.pendingRevision ? `r${service.pendingRevision.revision} · ${shortSha(service.pendingRevision.commitSha)}` : "—"}</span>
                <span>Health: {service.healthPath}</span>
                <span>Port: {service.containerPort}</span>
              </div>
              <div className={styles.actions}>
                {service.activeRevision ? <a className={styles.primary} href={url} target="_blank" rel="noreferrer">Open stable URL</a> : null}
                <button type="button" onClick={() => {
                  setNamespace(service.namespace);
                  setRepositorySlug(service.repositorySlug);
                  setName(service.name);
                  setServiceSlug(service.slug);
                  setContainerPort(String(service.containerPort));
                  setDockerfilePath(service.dockerfilePath);
                  setContextPath(service.contextPath);
                  setHealthPath(service.healthPath);
                  setExposure(service.exposure);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}>Redeploy</button>
              </div>
              <div className={styles.history}>
                <div className={styles.historyTitle}>Revision history</div>
                {service.revisions.map((revision) => (
                  <div className={styles.revision} key={revision.id}>
                    <div>
                      <strong>r{revision.revision}</strong>
                      <span>{shortSha(revision.commitSha)} · {revision.refName} · {revision.state}{revision.rollbackOfRevision ? ` · rollback of r${revision.rollbackOfRevision}` : ""}</span>
                      <small>{time(revision.createdAt)}</small>
                    </div>
                    {revision.state !== "pending" && revision.id !== service.activeRevisionId ? (
                      <button type="button" disabled={busy === `${service.slug}:${revision.revision}` || Boolean(service.pendingRevision)} onClick={() => void rollback(service, revision.revision)}>Rollback to r{revision.revision}</button>
                    ) : null}
                  </div>
                ))}
              </div>
            </article>
          );
        })}
        {!services.length && !loading ? <div className={styles.empty}>No Kosh Deploy services yet.</div> : null}
      </section>
    </main>
  );
}
