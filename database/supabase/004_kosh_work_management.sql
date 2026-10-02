-- Kosh Phase 4: work management, discussions, project boards and notifications.

CREATE TABLE IF NOT EXISTS kosh_issue_counters (
  repository_id TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL CHECK (next_number > 0)
);

CREATE TABLE IF NOT EXISTS kosh_issues (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  milestone_id TEXT,
  assignee_user_id TEXT,
  assignee_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  closed_by_user_id TEXT,
  closed_by_name TEXT,
  UNIQUE(repository_id, number),
  CHECK (state IN ('open','closed'))
);

CREATE INDEX IF NOT EXISTS kosh_issues_repository_idx
ON kosh_issues(repository_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS kosh_labels (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, name)
);

CREATE TABLE IF NOT EXISTS kosh_issue_labels (
  issue_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY(issue_id, label_id)
);

CREATE TABLE IF NOT EXISTS kosh_milestones (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  due_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (state IN ('open','closed'))
);

CREATE TABLE IF NOT EXISTS kosh_issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kosh_issue_comments_issue_idx
ON kosh_issue_comments(issue_id, created_at ASC);

CREATE TABLE IF NOT EXISTS kosh_issue_dependencies (
  issue_id TEXT NOT NULL,
  depends_on_issue_id TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(issue_id, depends_on_issue_id),
  CHECK (issue_id <> depends_on_issue_id)
);

CREATE TABLE IF NOT EXISTS kosh_issue_links (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  link_type TEXT NOT NULL,
  ref_value TEXT NOT NULL,
  title TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(issue_id, link_type, ref_value),
  CHECK (link_type IN ('change_request','commit'))
);

CREATE TABLE IF NOT EXISTS kosh_discussion_counters (
  repository_id TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL CHECK (next_number > 0)
);

CREATE TABLE IF NOT EXISTS kosh_discussions (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repository_id, number),
  CHECK (state IN ('open','locked'))
);

CREATE TABLE IF NOT EXISTS kosh_discussion_replies (
  id TEXT PRIMARY KEY,
  discussion_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kosh_project_boards (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kosh_project_cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  column_key TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(board_id, issue_id),
  CHECK (column_key IN ('backlog','ready','in_progress','in_review','done'))
);

CREATE TABLE IF NOT EXISTS kosh_issue_templates (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title_template TEXT NOT NULL DEFAULT '',
  body_template TEXT NOT NULL DEFAULT '',
  label_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kosh_activity_events (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_number INTEGER,
  event_type TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kosh_activity_repository_idx
ON kosh_activity_events(repository_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kosh_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  href TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kosh_notifications_user_idx
ON kosh_notifications(user_id, created_at DESC);
