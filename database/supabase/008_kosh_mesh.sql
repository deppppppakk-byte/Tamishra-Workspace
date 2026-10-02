-- Kosh Mesh: cross-repository and cross-asset system graph.

CREATE TABLE IF NOT EXISTS kosh_mesh_nodes (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  node_key TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'active',
  url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(namespace, node_key)
);

CREATE TABLE IF NOT EXISTS kosh_mesh_links (
  id TEXT PRIMARY KEY,
  source_ref TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  relation TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by_user_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_ref, target_ref, relation),
  CHECK(source_ref <> target_ref)
);

CREATE INDEX IF NOT EXISTS kosh_mesh_nodes_namespace_idx
ON kosh_mesh_nodes(namespace, updated_at DESC);
