CREATE TABLE IF NOT EXISTS workspace_chat_conversations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'group', 'direct')),
  name TEXT NOT NULL DEFAULT '',
  topic TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_chat_conversations_org_idx
  ON workspace_chat_conversations (organization_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_chat_members (
  conversation_id TEXT NOT NULL REFERENCES workspace_chat_conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  last_read_message_id TEXT,
  last_read_at TIMESTAMPTZ,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_chat_members_user_idx
  ON workspace_chat_members (user_id, conversation_id);

CREATE TABLE IF NOT EXISTS workspace_chat_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES workspace_chat_conversations(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  parent_message_id TEXT REFERENCES workspace_chat_messages(id) ON DELETE SET NULL,
  mentions JSONB NOT NULL DEFAULT '[]'::jsonb,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS workspace_chat_messages_conversation_idx
  ON workspace_chat_messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS workspace_chat_messages_thread_idx
  ON workspace_chat_messages (parent_message_id, created_at ASC);

CREATE INDEX IF NOT EXISTS workspace_chat_messages_search_idx
  ON workspace_chat_messages
  USING GIN (to_tsvector('simple', coalesce(body, '')));

CREATE TABLE IF NOT EXISTS workspace_chat_reactions (
  message_id TEXT NOT NULL REFERENCES workspace_chat_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS workspace_chat_reactions_message_idx
  ON workspace_chat_reactions (message_id);
