-- Kosh expansion 1-22: shared platform control-plane foundations.

CREATE TABLE IF NOT EXISTS kosh_platform_resources (
  id TEXT PRIMARY KEY,
  repository_id TEXT,
  namespace TEXT NOT NULL,
  type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, type, resource_key)
);

CREATE INDEX IF NOT EXISTS kosh_platform_resources_type_idx
ON kosh_platform_resources(type, updated_at DESC);

CREATE TABLE IF NOT EXISTS kosh_secrets (
  id TEXT PRIMARY KEY,
  repository_id TEXT,
  environment_name TEXT,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS kosh_secrets_scope_idx
ON kosh_secrets(COALESCE(repository_id, ''), COALESCE(environment_name, ''), name);

CREATE TABLE IF NOT EXISTS kosh_ssh_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS kosh_api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kosh_audit_events (
  id TEXT PRIMARY KEY,
  repository_id TEXT,
  actor_user_id TEXT,
  actor_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kosh_audit_repository_idx
ON kosh_audit_events(repository_id, created_at DESC);
