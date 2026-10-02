-- Kosh foundation metadata. Git objects remain on Git-native persistent storage.
CREATE TABLE IF NOT EXISTS kosh_repositories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'private',
  default_branch TEXT NOT NULL DEFAULT 'main',
  state TEXT NOT NULL DEFAULT 'ready',
  clone_http_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(namespace, slug),
  CHECK (visibility IN ('private', 'internal', 'public')),
  CHECK (state IN ('ready', 'provisioning', 'error'))
);

CREATE INDEX IF NOT EXISTS kosh_repositories_updated_idx
ON kosh_repositories(updated_at DESC);
