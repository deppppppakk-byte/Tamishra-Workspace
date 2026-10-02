import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshPulseSeverity = "low" | "medium" | "high" | "critical";
export type KoshPulseIncidentStatus =
  | "open"
  | "investigating"
  | "mitigating"
  | "resolved";

export type StoredKoshPulseIncident = {
  id: string;
  title: string;
  targetRef: string;
  severity: KoshPulseSeverity;
  status: KoshPulseIncidentStatus;
  summary: string;
  ownerUserId: string | null;
  ownerName: string | null;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type StoredKoshPulseAcknowledgement = {
  id: string;
  signalKey: string;
  note: string;
  acknowledgedByUserId: string;
  acknowledgedByName: string;
  createdAt: string;
  expiresAt: string | null;
};

export interface KoshPulseStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  listIncidents(): Promise<StoredKoshPulseIncident[]>;
  createIncident(
    input: Omit<
      StoredKoshPulseIncident,
      "id" | "createdAt" | "updatedAt" | "resolvedAt"
    >
  ): Promise<StoredKoshPulseIncident>;
  updateIncident(
    id: string,
    input: Partial<
      Pick<
        StoredKoshPulseIncident,
        "title" | "severity" | "status" | "summary" | "ownerUserId" | "ownerName"
      >
    >
  ): Promise<StoredKoshPulseIncident | null>;
  listAcknowledgements(): Promise<StoredKoshPulseAcknowledgement[]>;
  acknowledge(input: {
    signalKey: string;
    note: string;
    acknowledgedByUserId: string;
    acknowledgedByName: string;
    expiresAt: string | null;
  }): Promise<StoredKoshPulseAcknowledgement>;
  deleteAcknowledgement(id: string): Promise<boolean>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryKoshPulseStore implements KoshPulseStore {
  readonly kind = "ephemeral-memory" as const;
  private incidents = new Map<string, StoredKoshPulseIncident>();
  private acknowledgements = new Map<
    string,
    StoredKoshPulseAcknowledgement
  >();

  async ready() {}

  async listIncidents() {
    return [...this.incidents.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  async createIncident(
    input: Omit<
      StoredKoshPulseIncident,
      "id" | "createdAt" | "updatedAt" | "resolvedAt"
    >
  ) {
    const timestamp = now();
    const incident: StoredKoshPulseIncident = {
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp,
      resolvedAt: input.status === "resolved" ? timestamp : null
    };
    this.incidents.set(incident.id, incident);
    return clone(incident);
  }

  async updateIncident(
    id: string,
    input: Partial<
      Pick<
        StoredKoshPulseIncident,
        "title" | "severity" | "status" | "summary" | "ownerUserId" | "ownerName"
      >
    >
  ) {
    const incident = this.incidents.get(id);
    if (!incident) return null;
    const previousStatus = incident.status;
    Object.assign(incident, input);
    incident.updatedAt = now();
    if (input.status === "resolved" && previousStatus !== "resolved") {
      incident.resolvedAt = incident.updatedAt;
    } else if (input.status && input.status !== "resolved") {
      incident.resolvedAt = null;
    }
    return clone(incident);
  }

  async listAcknowledgements() {
    const current = Date.now();
    for (const [id, acknowledgement] of this.acknowledgements) {
      if (
        acknowledgement.expiresAt &&
        new Date(acknowledgement.expiresAt).getTime() <= current
      ) {
        this.acknowledgements.delete(id);
      }
    }
    return [...this.acknowledgements.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  async acknowledge(input: {
    signalKey: string;
    note: string;
    acknowledgedByUserId: string;
    acknowledgedByName: string;
    expiresAt: string | null;
  }) {
    for (const [id, item] of this.acknowledgements) {
      if (item.signalKey === input.signalKey) {
        this.acknowledgements.delete(id);
      }
    }
    const acknowledgement: StoredKoshPulseAcknowledgement = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.acknowledgements.set(acknowledgement.id, acknowledgement);
    return clone(acknowledgement);
  }

  async deleteAcknowledgement(id: string) {
    return this.acknowledgements.delete(id);
  }
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function incidentFromRow(
  row: Record<string, unknown>
): StoredKoshPulseIncident {
  return {
    id: String(row.id),
    title: String(row.title),
    targetRef: String(row.target_ref),
    severity: String(row.severity) as KoshPulseSeverity,
    status: String(row.status) as KoshPulseIncidentStatus,
    summary: String(row.summary ?? ""),
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    ownerName: row.owner_name ? String(row.owner_name) : null,
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now(),
    resolvedAt: iso(row.resolved_at)
  };
}

function acknowledgementFromRow(
  row: Record<string, unknown>
): StoredKoshPulseAcknowledgement {
  return {
    id: String(row.id),
    signalKey: String(row.signal_key),
    note: String(row.note ?? ""),
    acknowledgedByUserId: String(row.acknowledged_by_user_id),
    acknowledgedByName: String(row.acknowledged_by_name),
    createdAt: iso(row.created_at) ?? now(),
    expiresAt: iso(row.expires_at)
  };
}

class PostgresKoshPulseStore implements KoshPulseStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_pulse_incidents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      owner_user_id TEXT,
      owner_name TEXT,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      CHECK(severity IN ('low','medium','high','critical')),
      CHECK(status IN ('open','investigating','mitigating','resolved'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_pulse_incidents_status_idx
      ON kosh_pulse_incidents(status, updated_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_pulse_acknowledgements (
      id TEXT PRIMARY KEY,
      signal_key TEXT NOT NULL UNIQUE,
      note TEXT NOT NULL DEFAULT '',
      acknowledged_by_user_id TEXT NOT NULL,
      acknowledged_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_pulse_ack_expiry_idx
      ON kosh_pulse_acknowledgements(expires_at)`;

    this.initialized = true;
  }

  async listIncidents() {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_pulse_incidents
      ORDER BY updated_at DESC
      LIMIT 2000
    `;
    return rows.map((row) =>
      incidentFromRow(row as Record<string, unknown>)
    );
  }

  async createIncident(
    input: Omit<
      StoredKoshPulseIncident,
      "id" | "createdAt" | "updatedAt" | "resolvedAt"
    >
  ) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_pulse_incidents(
        id, title, target_ref, severity, status, summary,
        owner_user_id, owner_name, created_by_user_id, created_by_name,
        resolved_at
      )
      VALUES(
        ${randomUUID()}, ${input.title}, ${input.targetRef},
        ${input.severity}, ${input.status}, ${input.summary},
        ${input.ownerUserId}, ${input.ownerName}, ${input.createdByUserId},
        ${input.createdByName},
        ${input.status === "resolved" ? new Date() : null}
      )
      RETURNING *
    `;
    return incidentFromRow(rows[0] as Record<string, unknown>);
  }

  async updateIncident(
    id: string,
    input: Partial<
      Pick<
        StoredKoshPulseIncident,
        "title" | "severity" | "status" | "summary" | "ownerUserId" | "ownerName"
      >
    >
  ) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_pulse_incidents WHERE id = ${id} LIMIT 1
    `;
    if (!rows[0]) return null;
    const current = incidentFromRow(rows[0] as Record<string, unknown>);
    const nextStatus = input.status ?? current.status;
    const resolvedAt =
      nextStatus === "resolved"
        ? current.resolvedAt ?? now()
        : null;

    const updated = await this.sql`
      UPDATE kosh_pulse_incidents
      SET title = ${input.title ?? current.title},
          severity = ${input.severity ?? current.severity},
          status = ${nextStatus},
          summary = ${input.summary ?? current.summary},
          owner_user_id = ${input.ownerUserId === undefined
            ? current.ownerUserId
            : input.ownerUserId},
          owner_name = ${input.ownerName === undefined
            ? current.ownerName
            : input.ownerName},
          resolved_at = ${resolvedAt},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return incidentFromRow(updated[0] as Record<string, unknown>);
  }

  async listAcknowledgements() {
    await this.ready();
    await this.sql`
      DELETE FROM kosh_pulse_acknowledgements
      WHERE expires_at IS NOT NULL AND expires_at <= NOW()
    `;
    const rows = await this.sql`
      SELECT * FROM kosh_pulse_acknowledgements
      ORDER BY created_at DESC
      LIMIT 2000
    `;
    return rows.map((row) =>
      acknowledgementFromRow(row as Record<string, unknown>)
    );
  }

  async acknowledge(input: {
    signalKey: string;
    note: string;
    acknowledgedByUserId: string;
    acknowledgedByName: string;
    expiresAt: string | null;
  }) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_pulse_acknowledgements(
        id, signal_key, note, acknowledged_by_user_id,
        acknowledged_by_name, expires_at
      )
      VALUES(
        ${randomUUID()}, ${input.signalKey}, ${input.note},
        ${input.acknowledgedByUserId}, ${input.acknowledgedByName},
        ${input.expiresAt}
      )
      ON CONFLICT(signal_key)
      DO UPDATE SET
        note = EXCLUDED.note,
        acknowledged_by_user_id = EXCLUDED.acknowledged_by_user_id,
        acknowledged_by_name = EXCLUDED.acknowledged_by_name,
        expires_at = EXCLUDED.expires_at,
        created_at = NOW()
      RETURNING *
    `;
    return acknowledgementFromRow(rows[0] as Record<string, unknown>);
  }

  async deleteAcknowledgement(id: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_pulse_acknowledgements WHERE id = ${id} RETURNING id
    `;
    return rows.length > 0;
  }
}

let singleton: KoshPulseStore | null = null;

export function getKoshPulseStore(): KoshPulseStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshPulseStore(
        postgres(databaseUrl, { max: 5, prepare: false })
      )
    : new MemoryKoshPulseStore();
  return singleton;
}
