-- Kosh Phase 3: change reviews, inline comments and branch policy metadata.

CREATE TABLE IF NOT EXISTS kosh_change_request_counters (
  repository_id TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL CHECK (next_number > 0)
);

CREATE TABLE IF NOT EXISTS kosh_change_requests (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  slug TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  merged_at TIMESTAMPTZ,
  merged_by_user_id TEXT,
  merged_by_name TEXT,
  merge_commit_sha TEXT,
  UNIQUE(repository_id, number),
  CHECK (status IN ('open', 'merged', 'closed'))
);

CREATE INDEX IF NOT EXISTS kosh_change_requests_repository_idx
ON kosh_change_requests(repository_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS kosh_reviews (
  id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL,
  reviewer_user_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  state TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (state IN ('approve', 'request_changes', 'comment'))
);

CREATE INDEX IF NOT EXISTS kosh_reviews_request_idx
ON kosh_reviews(change_request_id, created_at ASC);

CREATE TABLE IF NOT EXISTS kosh_review_comments (
  id TEXT PRIMARY KEY,
  change_request_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  side TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (side IS NULL OR side IN ('base', 'head')),
  CHECK (line IS NULL OR line > 0)
);

CREATE INDEX IF NOT EXISTS kosh_review_comments_request_idx
ON kosh_review_comments(change_request_id, created_at ASC);

CREATE TABLE IF NOT EXISTS kosh_branch_policies (
  repository_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  required_approvals INTEGER NOT NULL DEFAULT 1,
  block_on_changes_requested BOOLEAN NOT NULL DEFAULT TRUE,
  allow_direct_push BOOLEAN NOT NULL DEFAULT FALSE,
  allow_delete BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(repository_id, branch),
  CHECK (required_approvals >= 0 AND required_approvals <= 20)
);
