-- Kosh Phase 5: Automation / CI-CD.

CREATE TABLE IF NOT EXISTS kosh_workflows (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  definition JSONB NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, path)
);

CREATE TABLE IF NOT EXISTS kosh_workflow_runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  actor_user_id TEXT,
  actor_name TEXT,
  change_request_number INTEGER,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (trigger_type IN ('manual','change_request','push')),
  CHECK (status IN ('queued','running','success','failure','cancelled'))
);

CREATE INDEX IF NOT EXISTS kosh_workflow_runs_repository_idx
ON kosh_workflow_runs(repository_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kosh_workflow_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  runner_id TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  timeout_minutes INTEGER NOT NULL DEFAULT 30,
  definition JSONB NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('queued','running','success','failure','cancelled'))
);

CREATE INDEX IF NOT EXISTS kosh_workflow_jobs_queue_idx
ON kosh_workflow_jobs(status, created_at ASC);

CREATE TABLE IF NOT EXISTS kosh_workflow_logs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  stream TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, sequence),
  CHECK (stream IN ('stdout','stderr','system'))
);

CREATE TABLE IF NOT EXISTS kosh_workflow_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kosh_environments (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  required_approvals INTEGER NOT NULL DEFAULT 0,
  protected_branches JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, name)
);

CREATE TABLE IF NOT EXISTS kosh_deployments (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  environment_name TEXT NOT NULL,
  run_id TEXT,
  ref_name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  url TEXT,
  actor_user_id TEXT,
  actor_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('queued','running','success','failure','cancelled'))
);

CREATE TABLE IF NOT EXISTS kosh_checks (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, commit_sha, name),
  CHECK (status IN ('queued','running','success','failure','cancelled'))
);
