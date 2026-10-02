-- Kosh P0 access control: namespace ownership, teams and repository grants.

CREATE TABLE IF NOT EXISTS kosh_namespace_bindings (
  namespace TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS kosh_namespace_bindings_org_idx
ON kosh_namespace_bindings(organization_id, namespace);

CREATE TABLE IF NOT EXISTS kosh_access_teams (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(namespace, slug)
);

CREATE TABLE IF NOT EXISTS kosh_access_team_members (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES kosh_access_teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  added_by_user_id TEXT NOT NULL,
  added_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, user_id),
  CHECK(role IN ('maintainer', 'member'))
);

CREATE INDEX IF NOT EXISTS kosh_access_team_members_user_idx
ON kosh_access_team_members(user_id, team_id);

CREATE TABLE IF NOT EXISTS kosh_repository_grants (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, subject_type, subject_id),
  CHECK(subject_type IN ('user', 'team')),
  CHECK(role IN ('owner', 'maintainer', 'contributor', 'reviewer', 'reader'))
);

CREATE INDEX IF NOT EXISTS kosh_repository_grants_repo_idx
ON kosh_repository_grants(repository_id, updated_at DESC);
