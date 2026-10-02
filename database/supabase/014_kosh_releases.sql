-- Kosh native Releases: Git-anchored release lifecycle, assets, package links and channels.

CREATE TABLE IF NOT EXISTS kosh_releases (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  name TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  commit_sha TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  prerelease BOOLEAN NOT NULL DEFAULT FALSE,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, tag),
  CHECK(state IN ('draft','published','archived'))
);

CREATE INDEX IF NOT EXISTS kosh_releases_repo_idx
ON kosh_releases(repository_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kosh_release_assets (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(release_id, filename)
);

CREATE INDEX IF NOT EXISTS kosh_release_assets_release_idx
ON kosh_release_assets(release_id, filename);

CREATE TABLE IF NOT EXISTS kosh_release_packages (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  package_version_id TEXT NOT NULL,
  package_key TEXT NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(release_id, package_version_id)
);

CREATE INDEX IF NOT EXISTS kosh_release_packages_release_idx
ON kosh_release_packages(release_id, created_at ASC);

CREATE TABLE IF NOT EXISTS kosh_release_channels (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  release_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  updated_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, channel)
);

CREATE INDEX IF NOT EXISTS kosh_release_channels_repo_idx
ON kosh_release_channels(repository_id, channel);
