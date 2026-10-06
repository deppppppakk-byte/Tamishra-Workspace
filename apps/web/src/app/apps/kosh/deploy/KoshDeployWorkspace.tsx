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

type RuntimeConfig = {
  environmentName: string;
  variables: Record<string, string>;
  secretBindings: Record<string, string>;
};

type DomainStatus = {
  baseDomain: string;
  wildcardHostname: string;
  edgeReady: boolean;
  tlsManaged: boolean;
  dnsReady: boolean;
  httpsReady: boolean;
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
  hostname: string | null;
  publicUrl: string | null;
  runtimeConfig: RuntimeConfig;
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

function parsePairs(text: string, label: string) {
  const output: Record<string, string> = {};
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const index = line.indexOf("=");
    if (index < 1) throw new Error(`${label} must use KEY=value, one per line.`);
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    output[key] = value;
  }
  return output;
}

function pairsText(value: Record<string, string> | undefined) {
  return Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join("\n");
}

export function KoshDeployWorkspace() {
  const router = useRouter();
  const base = useMemo(apiBase, []);
  const [services, setServices] = useState<Service[]>([]);
  const [domain, setDomain] = useState<DomainStatus | null>(null);
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
  const [environmentName, setEnvironmentName] = useState("production");
  const [variablesText, setVariablesText] = useState("");
  const [secretBindingsText, setSecretBindingsText] = useState("");
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
      const payload = (await response.json().catch(() => ({}))) as {
        services?: Service[];
        domain?: DomainStatus;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || `Kosh Deploy request failed (${response.status}).`);
      setServices(payload.services ?? []);
      setDomain(payload.domain ?? null);
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
      const variables = parsePairs(variablesText, "Environment variables");
      const secretBindings = parsePairs(secretBindingsText, "Secret bindings");
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
          exposure,
          environmentName: environmentName.trim() || "production",
          variables,
          secretBindings
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
          <span>Deploy directly from a Kosh Git revision. Kosh builds the image, injects runtime configuration, health-checks it, switches traffic only after it is healthy, and keeps rollback history.</span>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>Refresh</button>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div>
            <strong>Tamishra app domain</strong>
            <span>{domain?.wildcardHostname ?? "*.apps.tamishra.in"}</span>
          </div>
          <span className={styles.badge}>{domain?.httpsReady ? "HTTPS ready" : domain?.dnsReady ? "TLS pending" : "DNS/TLS pending"}</span>
        </div>
        <p>Every DNS-safe service slug automatically receives a stable host such as <strong>workspace.apps.tamishra.in</strong>. Kosh only marks HTTPS ready after the wildcard edge and certificate are actually active.</p>
      </section>

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
          <label>Environment<input value={environmentName} onChange={(event) => setEnvironmentName(event.target.value)} placeholder="production" /></label>
          <label className={styles.wide}>Environment variables<textarea value={variablesText} onChange={(event) => setVariablesText(event.target.value)} placeholder={"NODE_ENV=production\nPUBLIC_API_URL=https://api.example.com"} rows={4} /><small>Non-secret values only. One KEY=value per line.</small></label>
          <label className={styles.wide}>Kosh Secret bindings<textarea value={secretBindingsText} onChange={(event) => setSecretBindingsText(event.target.value)} placeholder={"DATABASE_URL=DATABASE_URL_PROD\nAPI_KEY=SERVICE_API_KEY"} rows={4} /><small>Left side is the container variable; right side is the encrypted Kosh Secret name.</small></label>
          <div className={styles.secretActions}>
            <Link href={`/apps/kosh/platform?namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(repositorySlug)}`}>Manage Kosh Secrets</Link>
            <span>Secret plaintext is never stored in the deployment revision.</span>
          </div>
          <button className={styles.primary} type="submit" disabled={deploying}>{deploying ? "Deploying…" : "Deploy from Kosh"}</button>
        </form>
      </section>

      <section className={styles.services}>
        {services.map((service) => {
          const internalUrl = `${base}/v1/kosh/deploy/apps/${encodeURIComponent(service.slug)}/`;
          const url = domain?.httpsReady && service.publicUrl ? service.publicUrl : internalUrl;
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
                <span>Host: {service.hostname ?? "Slug is not DNS-safe"}</span>
                <span>Environment: {service.runtimeConfig?.environmentName ?? "production"}</span>
                <span>Secrets: {Object.keys(service.runtimeConfig?.secretBindings ?? {}).length}</span>
                <span>Health: {service.healthPath}</span>
                <span>Port: {service.containerPort}</span>
              </div>
              <div className={styles.actions}>
                {service.activeRevision ? <a className={styles.primary} href={url} target="_blank" rel="noreferrer">{domain?.httpsReady && service.publicUrl ? "Open Tamishra URL" : "Open internal URL"}</a> : null}
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
                  setEnvironmentName(service.runtimeConfig?.environmentName ?? "production");
                  setVariablesText(pairsText(service.runtimeConfig?.variables));
                  setSecretBindingsText(pairsText(service.runtimeConfig?.secretBindings));
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
