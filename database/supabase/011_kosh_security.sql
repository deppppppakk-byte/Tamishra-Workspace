-- Kosh Security Engine: repository scans, durable findings and SBOM.

CREATE TABLE IF NOT EXISTS kosh_security_findings (
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
);

CREATE INDEX IF NOT EXISTS kosh_security_findings_repo_idx
ON kosh_security_findings(repository_id, state, severity, updated_at DESC);

CREATE TABLE IF NOT EXISTS kosh_security_scans (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  scanners JSONB NOT NULL DEFAULT '[]'::jsonb,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kosh_security_scans_repo_idx
ON kosh_security_scans(repository_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS kosh_security_sbom (
  repository_id TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  format TEXT NOT NULL,
  document JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
