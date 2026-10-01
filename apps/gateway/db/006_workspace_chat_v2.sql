ALTER TABLE workspace_chat_members
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS workspace_chat_files (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES workspace_chat_conversations(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size BIGINT NOT NULL,
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_chat_files_conversation_idx
  ON workspace_chat_files (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_chat_events (
  id BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  conversation_id TEXT REFERENCES workspace_chat_conversations(id) ON DELETE CASCADE,
  actor_id TEXT,
  target_user_id TEXT,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_chat_events_org_cursor_idx
  ON workspace_chat_events (organization_id, id);

CREATE INDEX IF NOT EXISTS workspace_chat_events_target_idx
  ON workspace_chat_events (target_user_id, id);

CREATE TABLE IF NOT EXISTS workspace_chat_notifications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES workspace_chat_conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES workspace_chat_messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('mention', 'direct', 'thread')),
  title TEXT NOT NULL,
  body_preview TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS workspace_chat_notifications_user_idx
  ON workspace_chat_notifications (organization_id, user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_chat_presence (
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_chat_presence_org_idx
  ON workspace_chat_presence (organization_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS workspace_chat_typing (
  conversation_id TEXT NOT NULL REFERENCES workspace_chat_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_chat_typing_expiry_idx
  ON workspace_chat_typing (conversation_id, expires_at);
