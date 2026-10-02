-- Kosh P0 Runner Isolation: job leases, runner health and ephemeral checkout credentials.

ALTER TABLE kosh_workflow_jobs
ADD COLUMN IF NOT EXISTS lease_hash TEXT;

ALTER TABLE kosh_workflow_jobs
ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

ALTER TABLE kosh_workflow_jobs
ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS kosh_workflow_jobs_lease_idx
ON kosh_workflow_jobs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS kosh_runner_nodes (
  id TEXT PRIMARY KEY,
  executor TEXT NOT NULL,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  capacity INTEGER NOT NULL DEFAULT 1,
  active_jobs INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  arch TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'online',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(executor IN ('container','host')),
  CHECK(status IN ('online','draining','offline'))
);

CREATE INDEX IF NOT EXISTS kosh_runner_nodes_seen_idx
ON kosh_runner_nodes(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS kosh_runner_credentials (
  token_hash TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(scope IN ('repository.read'))
);

CREATE INDEX IF NOT EXISTS kosh_runner_credentials_job_idx
ON kosh_runner_credentials(job_id, expires_at);
