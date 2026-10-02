import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshSecuritySeverity = "low" | "medium" | "high" | "critical";
export type KoshSecurityFindingState =
  | "open"
  | "acknowledged"
  | "resolved"
  | "ignored";

export type StoredKoshSecurityFinding = {
  id: string;
  repositoryId: string;
  fingerprint: string;
  scanner: string;
  ruleId: string;
  title: string;
  severity: KoshSecuritySeverity;
  state: KoshSecurityFindingState;
  path: string;
  line: number | null;
  message: string;
  evidenceHash: string;
  metadata: Record<string, unknown>;
  note: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  updatedAt: string;
};

export type StoredKoshSecurityScan = {
  id: string;
  repositoryId: string;
  commitSha: string;
  scanners: string[];
  counts: Record<string, number>;
  createdByUserId: string;
  createdByName: string;
  startedAt: string;
  completedAt: string;
};

export type StoredKoshSbom = {
  repositoryId: string;
  commitSha: string;
  format: "kosh-sbom-v1";
  document: Record<string, unknown>;
  generatedAt: string;
};

export type KoshDetectedFinding = {
  fingerprint: string;
  scanner: string;
  ruleId: string;
  title: string;
  severity: KoshSecuritySeverity;
  path: string;
  line: number | null;
  message: string;
  evidenceHash: string;
  metadata: Record<string, unknown>;
};

export interface KoshSecurityStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  listFindings(
    repositoryId: string,
    state?: KoshSecurityFindingState
  ): Promise<StoredKoshSecurityFinding[]>;
  getFinding(
    repositoryId: string,
    id: string
  ): Promise<StoredKoshSecurityFinding | null>;
  reconcileScan(input: {
    repositoryId: string;
    commitSha: string;
    scanners: string[];
    findings: KoshDetectedFinding[];
    createdByUserId: string;
    createdByName: string;
    startedAt: string;
  }): Promise<StoredKoshSecurityScan>;
  updateFindingState(
    repositoryId: string,
    id: string,
    state: KoshSecurityFindingState,
    note: string
  ): Promise<StoredKoshSecurityFinding | null>;
  listScans(repositoryId: string): Promise<StoredKoshSecurityScan[]>;
  putSbom(input: StoredKoshSbom): Promise<StoredKoshSbom>;
  getSbom(repositoryId: string): Promise<StoredKoshSbom | null>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function countsFor(findings: StoredKoshSecurityFinding[]) {
  const counts: Record<string, number> = {
    total: findings.length,
    open: 0,
    acknowledged: 0,
    resolved: 0,
    ignored: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0
  };
  for (const finding of findings) {
    counts[finding.state] = (counts[finding.state] ?? 0) + 1;
    counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  }
  return counts;
}

class MemoryKoshSecurityStore implements KoshSecurityStore {
  readonly kind = "ephemeral-memory" as const;
  private findings = new Map<string, StoredKoshSecurityFinding>();
  private scans = new Map<string, StoredKoshSecurityScan>();
  private sboms = new Map<string, StoredKoshSbom>();

  async ready() {}

  async listFindings(
    repositoryId: string,
    state?: KoshSecurityFindingState
  ) {
    return [...this.findings.values()]
      .filter(
        (item) =>
          item.repositoryId === repositoryId &&
          (!state || item.state === state)
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  async getFinding(repositoryId: string, id: string) {
    const item = this.findings.get(id);
    return item && item.repositoryId === repositoryId ? clone(item) : null;
  }

  async reconcileScan(input: {
    repositoryId: string;
    commitSha: string;
    scanners: string[];
    findings: KoshDetectedFinding[];
    createdByUserId: string;
    createdByName: string;
    startedAt: string;
  }) {
    const timestamp = now();
    const seen = new Set(input.findings.map((item) => item.fingerprint));

    for (const detected of input.findings) {
      const current = [...this.findings.values()].find(
        (item) =>
          item.repositoryId === input.repositoryId &&
          item.fingerprint === detected.fingerprint
      );
      if (current) {
        Object.assign(current, detected);
        current.lastSeenAt = timestamp;
        current.updatedAt = timestamp;
        if (current.state === "resolved") {
          current.state = "open";
          current.resolvedAt = null;
        }
      } else {
        const item: StoredKoshSecurityFinding = {
          ...detected,
          id: randomUUID(),
          repositoryId: input.repositoryId,
          state: "open",
          note: "",
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          resolvedAt: null,
          updatedAt: timestamp
        };
        this.findings.set(item.id, item);
      }
    }

    const scannerSet = new Set(input.scanners);
    for (const finding of this.findings.values()) {
      if (
        finding.repositoryId === input.repositoryId &&
        scannerSet.has(finding.scanner) &&
        !seen.has(finding.fingerprint) &&
        (finding.state === "open" || finding.state === "acknowledged")
      ) {
        finding.state = "resolved";
        finding.resolvedAt = timestamp;
        finding.updatedAt = timestamp;
      }
    }

    const current = await this.listFindings(input.repositoryId);
    const scan: StoredKoshSecurityScan = {
      id: randomUUID(),
      repositoryId: input.repositoryId,
      commitSha: input.commitSha,
      scanners: [...input.scanners],
      counts: countsFor(current),
      createdByUserId: input.createdByUserId,
      createdByName: input.createdByName,
      startedAt: input.startedAt,
      completedAt: timestamp
    };
    this.scans.set(scan.id, scan);
    return clone(scan);
  }

  async updateFindingState(
    repositoryId: string,
    id: string,
    state: KoshSecurityFindingState,
    note: string
  ) {
    const item = this.findings.get(id);
    if (!item || item.repositoryId !== repositoryId) return null;
    item.state = state;
    item.note = note;
    item.updatedAt = now();
    item.resolvedAt = state === "resolved" ? item.updatedAt : null;
    return clone(item);
  }

  async listScans(repositoryId: string) {
    return [...this.scans.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt))
      .slice(0, 100)
      .map(clone);
  }

  async putSbom(input: StoredKoshSbom) {
    this.sboms.set(input.repositoryId, clone(input));
    return clone(input);
  }

  async getSbom(repositoryId: string) {
    const item = this.sboms.get(repositoryId);
    return item ? clone(item) : null;
  }
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function findingFromRow(
  row: Record<string, unknown>
): StoredKoshSecurityFinding {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    fingerprint: String(row.fingerprint),
    scanner: String(row.scanner),
    ruleId: String(row.rule_id),
    title: String(row.title),
    severity: String(row.severity) as KoshSecuritySeverity,
    state: String(row.state) as KoshSecurityFindingState,
    path: String(row.path),
    line: row.line_number == null ? null : Number(row.line_number),
    message: String(row.message ?? ""),
    evidenceHash: String(row.evidence_hash),
    metadata:
      row.metadata && typeof row.metadata === "object"
        ? row.metadata as Record<string, unknown>
        : {},
    note: String(row.note ?? ""),
    firstSeenAt: iso(row.first_seen_at) ?? now(),
    lastSeenAt: iso(row.last_seen_at) ?? now(),
    resolvedAt: iso(row.resolved_at),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function scanFromRow(row: Record<string, unknown>): StoredKoshSecurityScan {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    commitSha: String(row.commit_sha),
    scanners: Array.isArray(row.scanners) ? row.scanners.map(String) : [],
    counts:
      row.counts && typeof row.counts === "object"
        ? row.counts as Record<string, number>
        : {},
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    startedAt: iso(row.started_at) ?? now(),
    completedAt: iso(row.completed_at) ?? now()
  };
}

class PostgresKoshSecurityStore implements KoshSecurityStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_security_findings (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      scanner TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      title TEXT NOT NULL,
      severity TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'open',
      path TEXT NOT NULL,
      line_number INTEGER,
      message TEXT NOT NULL DEFAULT '',
      evidence_hash TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      note TEXT NOT NULL DEFAULT '',
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, fingerprint),
      CHECK(severity IN ('low','medium','high','critical')),
      CHECK(state IN ('open','acknowledged','resolved','ignored'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_security_findings_repo_idx
      ON kosh_security_findings(repository_id, state, severity, updated_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_security_scans (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      scanners JSONB NOT NULL DEFAULT '[]'::jsonb,
      counts JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_security_scans_repo_idx
      ON kosh_security_scans(repository_id, completed_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_security_sbom (
      repository_id TEXT PRIMARY KEY,
      commit_sha TEXT NOT NULL,
      format TEXT NOT NULL,
      document JSONB NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    this.initialized = true;
  }

  async listFindings(
    repositoryId: string,
    state?: KoshSecurityFindingState
  ) {
    await this.ready();
    const rows = state
      ? await this.sql`
          SELECT * FROM kosh_security_findings
          WHERE repository_id = ${repositoryId} AND state = ${state}
          ORDER BY updated_at DESC
          LIMIT 5000
        `
      : await this.sql`
          SELECT * FROM kosh_security_findings
          WHERE repository_id = ${repositoryId}
          ORDER BY updated_at DESC
          LIMIT 5000
        `;
    return rows.map((row) =>
      findingFromRow(row as Record<string, unknown>)
    );
  }

  async getFinding(repositoryId: string, id: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_security_findings
      WHERE repository_id = ${repositoryId} AND id = ${id}
      LIMIT 1
    `;
    return rows[0]
      ? findingFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async reconcileScan(input: {
    repositoryId: string;
    commitSha: string;
    scanners: string[];
    findings: KoshDetectedFinding[];
    createdByUserId: string;
    createdByName: string;
    startedAt: string;
  }) {
    await this.ready();
    const timestamp = now();
    const fingerprints = input.findings.map((item) => item.fingerprint);

    for (const finding of input.findings) {
      await this.sql`
        INSERT INTO kosh_security_findings(
          id, repository_id, fingerprint, scanner, rule_id, title,
          severity, state, path, line_number, message, evidence_hash,
          metadata, note, first_seen_at, last_seen_at, resolved_at, updated_at
        )
        VALUES(
          ${randomUUID()}, ${input.repositoryId}, ${finding.fingerprint},
          ${finding.scanner}, ${finding.ruleId}, ${finding.title},
          ${finding.severity}, 'open', ${finding.path}, ${finding.line},
          ${finding.message}, ${finding.evidenceHash},
          ${JSON.stringify(finding.metadata)}::jsonb, '', NOW(), NOW(), NULL, NOW()
        )
        ON CONFLICT(repository_id, fingerprint)
        DO UPDATE SET
          scanner = EXCLUDED.scanner,
          rule_id = EXCLUDED.rule_id,
          title = EXCLUDED.title,
          severity = EXCLUDED.severity,
          path = EXCLUDED.path,
          line_number = EXCLUDED.line_number,
          message = EXCLUDED.message,
          evidence_hash = EXCLUDED.evidence_hash,
          metadata = EXCLUDED.metadata,
          state = CASE
            WHEN kosh_security_findings.state = 'resolved' THEN 'open'
            ELSE kosh_security_findings.state
          END,
          resolved_at = CASE
            WHEN kosh_security_findings.state = 'resolved' THEN NULL
            ELSE kosh_security_findings.resolved_at
          END,
          last_seen_at = NOW(),
          updated_at = NOW()
      `;
    }

    if (input.scanners.length) {
      const currentBeforeResolve = await this.listFindings(input.repositoryId);
      const scannerSet = new Set(input.scanners);
      const fingerprintSet = new Set(fingerprints);

      for (const finding of currentBeforeResolve) {
        if (
          scannerSet.has(finding.scanner) &&
          !fingerprintSet.has(finding.fingerprint) &&
          (finding.state === "open" || finding.state === "acknowledged")
        ) {
          await this.sql`
            UPDATE kosh_security_findings
            SET state = 'resolved',
                resolved_at = NOW(),
                updated_at = NOW()
            WHERE repository_id = ${input.repositoryId}
              AND id = ${finding.id}
          `;
        }
      }
    }

    const current = await this.listFindings(input.repositoryId);
    const counts = countsFor(current);
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO kosh_security_scans(
        id, repository_id, commit_sha, scanners, counts,
        created_by_user_id, created_by_name, started_at, completed_at
      )
      VALUES(
        ${id}, ${input.repositoryId}, ${input.commitSha},
        ${JSON.stringify(input.scanners)}::jsonb,
        ${JSON.stringify(counts)}::jsonb,
        ${input.createdByUserId}, ${input.createdByName},
        ${input.startedAt}, NOW()
      )
      RETURNING *
    `;
    return scanFromRow(rows[0] as Record<string, unknown>);
  }

  async updateFindingState(
    repositoryId: string,
    id: string,
    state: KoshSecurityFindingState,
    note: string
  ) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_security_findings
      SET state = ${state},
          note = ${note},
          resolved_at = CASE WHEN ${state} = 'resolved' THEN NOW() ELSE NULL END,
          updated_at = NOW()
      WHERE repository_id = ${repositoryId} AND id = ${id}
      RETURNING *
    `;
    return rows[0]
      ? findingFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async listScans(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_security_scans
      WHERE repository_id = ${repositoryId}
      ORDER BY completed_at DESC
      LIMIT 100
    `;
    return rows.map((row) => scanFromRow(row as Record<string, unknown>));
  }

  async putSbom(input: StoredKoshSbom) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_security_sbom(
        repository_id, commit_sha, format, document, generated_at
      )
      VALUES(
        ${input.repositoryId}, ${input.commitSha}, ${input.format},
        ${JSON.stringify(input.document)}::jsonb, ${input.generatedAt}
      )
      ON CONFLICT(repository_id)
      DO UPDATE SET
        commit_sha = EXCLUDED.commit_sha,
        format = EXCLUDED.format,
        document = EXCLUDED.document,
        generated_at = EXCLUDED.generated_at
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      repositoryId: String(row.repository_id),
      commitSha: String(row.commit_sha),
      format: "kosh-sbom-v1",
      document:
        row.document && typeof row.document === "object"
          ? row.document as Record<string, unknown>
          : {},
      generatedAt: iso(row.generated_at) ?? now()
    };
  }

  async getSbom(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_security_sbom
      WHERE repository_id = ${repositoryId}
      LIMIT 1
    `;
    if (!rows[0]) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      repositoryId: String(row.repository_id),
      commitSha: String(row.commit_sha),
      format: "kosh-sbom-v1",
      document:
        row.document && typeof row.document === "object"
          ? row.document as Record<string, unknown>
          : {},
      generatedAt: iso(row.generated_at) ?? now()
    };
  }
}

let singleton: KoshSecurityStore | null = null;

export function getKoshSecurityStore(): KoshSecurityStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshSecurityStore(
        postgres(databaseUrl, { max: 5, prepare: false })
      )
    : new MemoryKoshSecurityStore();
  return singleton;
}
