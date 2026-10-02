"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./pulse.module.css";

type Severity = "low" | "medium" | "high" | "critical";
type IncidentStatus = "open" | "investigating" | "mitigating" | "resolved";

type Signal = {
  key: string;
  nodeRef: string;
  title: string;
  type: string;
  health: string;
  severity: Severity;
  score: number;
  reason: string;
  downstreamCount: number;
  upstreamCount: number;
  downstreamFailed: number;
  downstreamBlocked: number;
  href: string;
  acknowledged: boolean;
  acknowledgementId: string | null;
  acknowledgementExpiresAt: string | null;
  incidentIds: string[];
};

type Incident = {
  id: string;
  title: string;
  targetRef: string;
  severity: Severity;
  status: IncidentStatus;
  summary: string;
  ownerUserId: string | null;
  ownerName: string | null;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

type Acknowledgement = {
  id: string;
  signalKey: string;
  note: string;
  acknowledgedByName: string;
  createdAt: string;
  expiresAt: string | null;
};

type PulsePayload = {
  state: "clear" | "watch" | "degraded" | "critical";
  generatedAt: string;
  mesh: {
    state: string;
    counts: Record<string, number>;
  };
  counts: {
    signals: number;
    activeSignals: number;
    acknowledgedSignals: number;
    critical: number;
    high: number;
    medium: number;
    incidents: number;
    openIncidents: number;
  };
  signals: Signal[];
  incidents: Incident[];
  acknowledgements: Acknowledgement[];
};

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100";
  return configured.replace(/\/$/, "");
}

function age(value: string | null) {
  if (!value) return "—";
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

function until(value: string | null) {
  if (!value) return "no expiry";
  const diff = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diff) || diff <= 0) return "expired";
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return minutes + "m";
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return hours + "h";
  return Math.ceil(hours / 24) + "d";
}

export function KoshPulseWorkspace() {
  const base = useMemo(apiBase, []);
  const [pulse, setPulse] = useState<PulsePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");
  const [selectedSignalKey, setSelectedSignalKey] = useState("");
  const [ackNote, setAckNote] = useState("");
  const [ackMinutes, setAckMinutes] = useState("240");

  const [incidentTitle, setIncidentTitle] = useState("");
  const [incidentSummary, setIncidentSummary] = useState("");
  const [incidentSeverity, setIncidentSeverity] = useState<Severity>("high");

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
      method: "POST" | "PATCH" | "DELETE",
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
      const payload = await fetchJson<PulsePayload>("/v1/kosh/pulse");
      setPulse(payload);
      const preferred =
        selectedSignalKey &&
        payload.signals.some((signal) => signal.key === selectedSignalKey)
          ? selectedSignalKey
          : payload.signals.find((signal) => !signal.acknowledged)?.key ||
            payload.signals[0]?.key ||
            "";
      setSelectedSignalKey(preferred);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Pulse.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, selectedSignalKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedSignal =
    pulse?.signals.find((signal) => signal.key === selectedSignalKey) ?? null;

  useEffect(() => {
    if (!selectedSignal) return;
    setIncidentTitle(selectedSignal.title + " incident");
    setIncidentSummary(selectedSignal.reason);
    setIncidentSeverity(
      selectedSignal.severity === "critical"
        ? "critical"
        : selectedSignal.severity === "low"
          ? "medium"
          : selectedSignal.severity
    );
  }, [selectedSignalKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function acknowledgeSignal() {
    if (!selectedSignal) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson("/v1/kosh/pulse/acknowledgements", "POST", {
        signalKey: selectedSignal.key,
        note: ackNote.trim(),
        ttlMinutes: Number(ackMinutes) || 240
      });
      setAckNote("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not acknowledge signal.");
    } finally {
      setMutating(false);
    }
  }

  async function removeAcknowledgement(id: string) {
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        "/v1/kosh/pulse/acknowledgements/" + encodeURIComponent(id),
        "DELETE"
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore signal.");
    } finally {
      setMutating(false);
    }
  }

  async function createIncident(event: FormEvent) {
    event.preventDefault();
    if (!selectedSignal || !incidentTitle.trim()) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson("/v1/kosh/pulse/incidents", "POST", {
        targetRef: selectedSignal.nodeRef,
        title: incidentTitle.trim(),
        severity: incidentSeverity,
        status: "open",
        summary: incidentSummary.trim()
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open incident.");
    } finally {
      setMutating(false);
    }
  }

  async function updateIncident(
    incident: Incident,
    status: IncidentStatus
  ) {
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        "/v1/kosh/pulse/incidents/" + encodeURIComponent(incident.id),
        "PATCH",
        { status }
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update incident.");
    } finally {
      setMutating(false);
    }
  }

  if (loading && !pulse) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Pulse</strong>
        <span>Reading Flow and Mesh signals…</span>
      </main>
    );
  }

  if (!pulse) {
    return (
      <main className={styles.loading}>
        <strong>Pulse unavailable</strong>
        <span>{error || "Kosh could not calculate workspace signals."}</span>
        <Link href="/apps/kosh">Back to Kosh</Link>
      </main>
    );
  }

  const openIncidents = pulse.incidents.filter(
    (incident) => incident.status !== "resolved"
  );

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href="/apps/kosh">← Kosh</Link>
          <p>KOSH PULSE</p>
          <h1>Command Layer</h1>
          <span>
            Pulse turns live Flow and Mesh state into signals, impact-aware
            urgency, acknowledgements and explicit incidents.
          </span>
        </div>

        <div className={styles.stateBox}>
          <span>PULSE STATE</span>
          <strong className={styles["state_" + pulse.state]}>{pulse.state}</strong>
          <em>{pulse.counts.activeSignals} active signals · {pulse.counts.openIncidents} open incidents</em>
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        <section className={styles.stats}>
          <div><span>Critical</span><strong>{pulse.counts.critical}</strong></div>
          <div><span>High</span><strong>{pulse.counts.high}</strong></div>
          <div><span>Medium</span><strong>{pulse.counts.medium}</strong></div>
          <div><span>Acknowledged</span><strong>{pulse.counts.acknowledgedSignals}</strong></div>
          <div><span>Open incidents</span><strong>{pulse.counts.openIncidents}</strong></div>
        </section>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Live signals</strong>
                <span>Ranked from health and downstream blast radius</span>
              </div>
              <Link href="/apps/kosh/mesh">Open Mesh →</Link>
            </div>

            <div className={styles.signalList}>
              {pulse.signals.map((signal) => (
                <button
                  key={signal.key}
                  className={
                    selectedSignalKey === signal.key
                      ? styles.selectedSignal
                      : styles.signal
                  }
                  onClick={() => setSelectedSignalKey(signal.key)}
                >
                  <span className={styles[signal.severity]}>{signal.severity}</span>
                  <div>
                    <strong>{signal.title}</strong>
                    <small>{signal.type} · {signal.health}</small>
                  </div>
                  <em>
                    score {signal.score}
                    {signal.acknowledged ? " · acknowledged" : ""}
                  </em>
                </button>
              ))}
              {!pulse.signals.length && (
                <div className={styles.empty}>No active health signals. Pulse is clear.</div>
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Signal inspector</strong>
                <span>Why it matters and how far it can propagate</span>
              </div>
            </div>

            {selectedSignal ? (
              <div className={styles.inspector}>
                <span className={styles[selectedSignal.severity]}>
                  {selectedSignal.severity}
                </span>
                <h2>{selectedSignal.title}</h2>
                <p>{selectedSignal.reason}</p>

                <dl>
                  <div><dt>Score</dt><dd>{selectedSignal.score}</dd></div>
                  <div><dt>Health</dt><dd>{selectedSignal.health}</dd></div>
                  <div><dt>Downstream</dt><dd>{selectedSignal.downstreamCount}</dd></div>
                  <div><dt>Upstream</dt><dd>{selectedSignal.upstreamCount}</dd></div>
                  <div><dt>Failed below</dt><dd>{selectedSignal.downstreamFailed}</dd></div>
                  <div><dt>Blocked below</dt><dd>{selectedSignal.downstreamBlocked}</dd></div>
                </dl>

                <div className={styles.inspectorActions}>
                  <Link href={selectedSignal.href}>Open source →</Link>
                  {selectedSignal.acknowledged &&
                  selectedSignal.acknowledgementId ? (
                    <button
                      disabled={mutating}
                      onClick={() =>
                        void removeAcknowledgement(
                          selectedSignal.acknowledgementId!
                        )
                      }
                    >
                      Restore signal
                    </button>
                  ) : (
                    <>
                      <input
                        value={ackNote}
                        onChange={(event) => setAckNote(event.target.value)}
                        placeholder="Acknowledgement note"
                      />
                      <select
                        value={ackMinutes}
                        onChange={(event) => setAckMinutes(event.target.value)}
                      >
                        <option value="60">1 hour</option>
                        <option value="240">4 hours</option>
                        <option value="1440">1 day</option>
                        <option value="10080">7 days</option>
                      </select>
                      <button
                        disabled={mutating}
                        onClick={() => void acknowledgeSignal()}
                      >
                        Acknowledge
                      </button>
                    </>
                  )}
                </div>

                {selectedSignal.acknowledged && (
                  <small className={styles.ackText}>
                    Acknowledged for {until(selectedSignal.acknowledgementExpiresAt)}.
                  </small>
                )}
              </div>
            ) : (
              <div className={styles.empty}>Select a signal to inspect it.</div>
            )}
          </section>
        </div>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Open incident</strong>
                <span>Incidents are human decisions, never auto-created by Pulse</span>
              </div>
            </div>

            {selectedSignal ? (
              <form className={styles.form} onSubmit={createIncident}>
                <label>
                  <span>Target</span>
                  <input value={selectedSignal.title} disabled />
                </label>
                <label>
                  <span>Severity</span>
                  <select
                    value={incidentSeverity}
                    onChange={(event) =>
                      setIncidentSeverity(event.target.value as Severity)
                    }
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </label>
                <label className={styles.wide}>
                  <span>Title</span>
                  <input
                    value={incidentTitle}
                    onChange={(event) => setIncidentTitle(event.target.value)}
                  />
                </label>
                <label className={styles.wide}>
                  <span>Summary</span>
                  <textarea
                    value={incidentSummary}
                    onChange={(event) => setIncidentSummary(event.target.value)}
                  />
                </label>
                <button
                  className={styles.primary}
                  disabled={mutating || !incidentTitle.trim()}
                >
                  Open incident
                </button>
              </form>
            ) : (
              <div className={styles.empty}>Select a signal before opening an incident.</div>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Open incidents</strong>
                <span>{openIncidents.length} requiring explicit resolution</span>
              </div>
            </div>

            <div className={styles.incidentList}>
              {openIncidents.map((incident) => (
                <article key={incident.id}>
                  <span className={styles[incident.severity]}>{incident.severity}</span>
                  <div>
                    <strong>{incident.title}</strong>
                    <small>
                      {incident.status} · {incident.ownerName || "unassigned"} ·{" "}
                      {age(incident.updatedAt)}
                    </small>
                    <p>{incident.summary || "No summary."}</p>
                  </div>
                  <select
                    value={incident.status}
                    disabled={mutating}
                    onChange={(event) =>
                      void updateIncident(
                        incident,
                        event.target.value as IncidentStatus
                      )
                    }
                  >
                    <option value="open">Open</option>
                    <option value="investigating">Investigating</option>
                    <option value="mitigating">Mitigating</option>
                    <option value="resolved">Resolved</option>
                  </select>
                </article>
              ))}
              {!openIncidents.length && (
                <div className={styles.empty}>No open incidents.</div>
              )}
            </div>
          </section>
        </div>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <strong>Acknowledgements</strong>
              <span>Temporary signal ownership, never permanent suppression</span>
            </div>
          </div>

          <div className={styles.ackList}>
            {pulse.acknowledgements.map((acknowledgement) => (
              <article key={acknowledgement.id}>
                <div>
                  <strong>{acknowledgement.signalKey}</strong>
                  <small>
                    {acknowledgement.acknowledgedByName} · expires in{" "}
                    {until(acknowledgement.expiresAt)}
                  </small>
                  {acknowledgement.note && <p>{acknowledgement.note}</p>}
                </div>
                <button
                  disabled={mutating}
                  onClick={() => void removeAcknowledgement(acknowledgement.id)}
                >
                  Restore
                </button>
              </article>
            ))}
            {!pulse.acknowledgements.length && (
              <div className={styles.empty}>No acknowledged signals.</div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
