"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./webhooks.module.css";

type Endpoint = {
  id: string;
  name: string;
  state: string;
  active: boolean;
  url: string;
  events: string[];
  hasSigningSecret: boolean;
  lastDeliveryAt: string | null;
  lastStatus: string | null;
  consecutiveFailures: number;
  createdAt: string;
  updatedAt: string;
};

type Delivery = {
  id: string;
  webhookId: string;
  deliveryId: string;
  event: string;
  state: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  attemptCount: number;
  completedAt: string;
};

type Overview = {
  endpoints: Endpoint[];
  recentDeliveries: Delivery[];
  events: string[];
  deliveryRetention: number;
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function stamp(value: string | null) {
  if (!value) return "Never";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export default function KoshWebhooksPage() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace") ?? "");
    setSlug(params.get("slug") ?? "");
  }, []);

  const endpointRoot = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug) +
      "/webhooks"
    );
  }, [base, namespace, slug]);

  const selected = overview?.endpoints.find((item) => item.id === selectedId) ?? null;

  const load = useCallback(async () => {
    if (!endpointRoot) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(endpointRoot, {
        credentials: "include",
        cache: "no-store"
      });
      const payload = (await response.json()) as Overview & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load webhooks.");
      setOverview(payload);
      const nextId = selectedId && payload.endpoints.some((item) => item.id === selectedId)
        ? selectedId
        : payload.endpoints[0]?.id ?? "";
      setSelectedId(nextId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load webhooks.");
    } finally {
      setLoading(false);
    }
  }, [endpointRoot, selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadDeliveries = useCallback(async () => {
    if (!endpointRoot || !selectedId) {
      setDeliveries([]);
      return;
    }
    try {
      const response = await fetch(endpointRoot + "/" + selectedId + "/deliveries", {
        credentials: "include",
        cache: "no-store"
      });
      const payload = (await response.json()) as { deliveries?: Delivery[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load deliveries.");
      setDeliveries(payload.deliveries ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load deliveries.");
    }
  }, [endpointRoot, selectedId]);

  useEffect(() => {
    void loadDeliveries();
  }, [loadDeliveries]);

  useEffect(() => {
    if (!overview?.events.length || events.length) return;
    setEvents([overview.events[0]]);
  }, [overview, events.length]);

  async function createEndpoint(event: FormEvent) {
    event.preventDefault();
    if (!endpointRoot) return;
    setBusy(true);
    setError("");
    setSecret("");
    try {
      const response = await fetch(endpointRoot, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), events })
      });
      const payload = (await response.json()) as {
        endpoint?: Endpoint;
        signingSecret?: string;
        error?: string;
      };
      if (!response.ok || !payload.endpoint) {
        throw new Error(payload.error || "Webhook creation failed.");
      }
      setSecret(payload.signingSecret ?? "");
      setName("");
      setUrl("");
      setSelectedId(payload.endpoint.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Webhook creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function action(path: string, method = "POST", body?: Record<string, unknown>) {
    if (!endpointRoot || !selectedId) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpointRoot + "/" + selectedId + path, {
        method,
        credentials: "include",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = (await response.json()) as { signingSecret?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "Webhook action failed.");
      if (payload.signingSecret) setSecret(payload.signingSecret);
      await load();
      await loadDeliveries();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Webhook action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function removeEndpoint() {
    if (!endpointRoot || !selectedId) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpointRoot + "/" + selectedId, {
        method: "DELETE",
        credentials: "include"
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Webhook deletion failed.");
      setSelectedId("");
      setSecret("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Webhook deletion failed.");
    } finally {
      setBusy(false);
    }
  }

  function toggleEvent(value: string) {
    setEvents((current) =>
      current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value]
    );
  }

  if (!namespace || !slug) {
    return (
      <main className={styles.center}>
        <strong>Select a repository first.</strong>
        <Link href="/apps/kosh">Back to Kosh</Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={"/apps/kosh/repository?namespace=" + encodeURIComponent(namespace) + "&slug=" + encodeURIComponent(slug)}>
            ← {namespace}/{slug}
          </Link>
          <p>KOSH INTEGRATIONS</p>
          <h1>Webhooks & Integrations</h1>
          <span>Signed outbound repository events with durable delivery evidence.</span>
        </div>
        <button onClick={() => void load()} disabled={loading}>Refresh</button>
      </header>

      {error && <div className={styles.error}>{error}</div>}
      {secret && (
        <section className={styles.secret}>
          <strong>Signing secret — shown now</strong>
          <code>{secret}</code>
          <p>Store this in the receiving service. Kosh keeps its copy encrypted and will not show the same value again.</p>
          <button onClick={() => setSecret("")}>Hide</button>
        </section>
      )}

      <section className={styles.grid}>
        <aside className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><span>Endpoints</span><strong>{overview?.endpoints.length ?? 0}</strong></div>
          </div>
          <div className={styles.endpointList}>
            {overview?.endpoints.map((endpoint) => (
              <button
                key={endpoint.id}
                className={selectedId === endpoint.id ? styles.selected : ""}
                onClick={() => setSelectedId(endpoint.id)}
              >
                <strong>{endpoint.name}</strong>
                <span>{endpoint.active ? "Active" : "Disabled"} · {endpoint.events.length} events</span>
                <small>{endpoint.lastStatus || "No deliveries"}</small>
              </button>
            ))}
            {!loading && !overview?.endpoints.length && <p>No endpoints yet.</p>}
          </div>

          <form className={styles.create} onSubmit={createEndpoint}>
            <h2>Add endpoint</h2>
            <label>Name<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
            <label>HTTPS URL<input value={url} onChange={(event) => setUrl(event.target.value)} required maxLength={2048} placeholder="https://service.example/kosh" /></label>
            <fieldset>
              <legend>Events</legend>
              <div className={styles.eventGrid}>
                {overview?.events.map((item) => (
                  <label key={item}>
                    <input type="checkbox" checked={events.includes(item)} onChange={() => toggleEvent(item)} />
                    <span>{item}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="submit" disabled={busy || !events.length}>Create endpoint</button>
          </form>
        </aside>

        <section className={styles.mainPanel}>
          {selected ? (
            <>
              <section className={styles.endpointHero}>
                <div>
                  <span>{selected.active ? "ACTIVE" : "DISABLED"}</span>
                  <h2>{selected.name}</h2>
                  <code>{selected.url}</code>
                  <p>{selected.events.join(" · ")}</p>
                </div>
                <div className={styles.actions}>
                  <button disabled={busy} onClick={() => void action("/test")}>Send test</button>
                  <button disabled={busy} onClick={() => void action("", "PATCH", { active: !selected.active })}>
                    {selected.active ? "Disable" : "Enable"}
                  </button>
                  <button disabled={busy} onClick={() => void action("/rotate-secret")}>Rotate secret</button>
                  <button disabled={busy} className={styles.danger} onClick={() => void removeEndpoint()}>Delete</button>
                </div>
              </section>

              <section className={styles.metrics}>
                <div><span>Last delivery</span><strong>{stamp(selected.lastDeliveryAt)}</strong></div>
                <div><span>Status</span><strong>{selected.lastStatus || "—"}</strong></div>
                <div><span>Consecutive failures</span><strong>{selected.consecutiveFailures}</strong></div>
                <div><span>Signing</span><strong>{selected.hasSigningSecret ? "HMAC-SHA256" : "None"}</strong></div>
              </section>

              <section className={styles.history}>
                <div className={styles.panelTitle}>
                  <div><span>Delivery history</span><strong>{deliveries.length}</strong></div>
                  <small>Retention: {overview?.deliveryRetention ?? 0} repository deliveries</small>
                </div>
                <div className={styles.tableWrap}>
                  <table>
                    <thead><tr><th>Event</th><th>Result</th><th>HTTP</th><th>Attempts</th><th>Completed</th><th /></tr></thead>
                    <tbody>
                      {deliveries.map((delivery) => (
                        <tr key={delivery.id}>
                          <td><code>{delivery.event}</code></td>
                          <td>{delivery.ok ? "Succeeded" : delivery.error || "Failed"}</td>
                          <td>{delivery.status ?? "—"}</td>
                          <td>{delivery.attemptCount}</td>
                          <td>{stamp(delivery.completedAt)}</td>
                          <td>
                            <button
                              disabled={busy}
                              onClick={() => void action("/deliveries/" + delivery.id + "/redeliver")}
                            >
                              Redeliver
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!deliveries.length && <p className={styles.empty}>No delivery attempts for this endpoint yet.</p>}
                </div>
              </section>
            </>
          ) : (
            <div className={styles.empty}>Create an integration endpoint to begin delivering Kosh events.</div>
          )}
        </section>
      </section>
    </main>
  );
}
