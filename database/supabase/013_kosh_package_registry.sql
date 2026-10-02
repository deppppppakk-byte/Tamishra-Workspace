-- Kosh Package Registry: immutable package versions and mutable channels.

CREATE TABLE IF NOT EXISTS kosh_package_versions (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  package_key TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  filename TEXT NOT NULL,
  format TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'published',
  commit_sha TEXT,
  run_id TEXT,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, package_key, version),
  CHECK(state IN ('published','yanked'))
);

CREATE INDEX IF NOT EXISTS kosh_package_versions_repo_idx
ON kosh_package_versions(repository_id, package_key, created_at DESC);

CREATE TABLE IF NOT EXISTS kosh_package_channels (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  package_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  version_id TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  updated_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, package_key, channel)
);

CREATE INDEX IF NOT EXISTS kosh_package_channels_repo_idx
ON kosh_package_channels(repository_id, package_key, channel);
