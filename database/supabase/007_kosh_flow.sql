-- Kosh Flow: native lifecycle relationship graph.

CREATE TABLE IF NOT EXISTS kosh_flow_links (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  relation TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(
    repository_id,
    source_type,
    source_ref,
    target_type,
    target_ref,
    relation
  )
);

CREATE INDEX IF NOT EXISTS kosh_flow_links_repository_idx
ON kosh_flow_links(repository_id, created_at DESC);
