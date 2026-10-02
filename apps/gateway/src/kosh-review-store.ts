import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshChangeRequestStatus = "open" | "merged" | "closed";
export type KoshReviewState = "approve" | "request_changes" | "comment";

export type StoredKoshChangeRequest = {
  id: string;
  repositoryId: string;
  namespace: string;
  slug: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  authorUserId: string;
  authorName: string;
  status: KoshChangeRequestStatus;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergedByUserId: string | null;
  mergedByName: string | null;
  mergeCommitSha: string | null;
};

export type StoredKoshReview = {
  id: string;
  changeRequestId: string;
  reviewerUserId: string;
  reviewerName: string;
  state: KoshReviewState;
  body: string;
  createdAt: string;
};

export type StoredKoshReviewComment = {
  id: string;
  changeRequestId: string;
  authorUserId: string;
  authorName: string;
  path: string | null;
  line: number | null;
  side: "base" | "head" | null;
  body: string;
  createdAt: string;
};

export type StoredKoshBranchPolicy = {
  repositoryId: string;
  branch: string;
  requiredApprovals: number;
  blockOnChangesRequested: boolean;
  allowDirectPush: boolean;
  allowDelete: boolean;
  updatedAt: string;
};

type CreateChangeRequest = Omit<
  StoredKoshChangeRequest,
  "id" | "number" | "status" | "createdAt" | "updatedAt" | "mergedAt" |
  "mergedByUserId" | "mergedByName" | "mergeCommitSha"
>;

type CreateReview = Omit<StoredKoshReview, "id" | "createdAt">;
type CreateComment = Omit<StoredKoshReviewComment, "id" | "createdAt">;

export interface KoshReviewStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  listChangeRequests(repositoryId: string): Promise<StoredKoshChangeRequest[]>;
  getChangeRequest(repositoryId: string, number: number): Promise<StoredKoshChangeRequest | null>;
  createChangeRequest(input: CreateChangeRequest): Promise<StoredKoshChangeRequest>;
  closeChangeRequest(repositoryId: string, number: number): Promise<StoredKoshChangeRequest | null>;
  markMerged(
    repositoryId: string,
    number: number,
    mergedByUserId: string,
    mergedByName: string,
    mergeCommitSha: string
  ): Promise<StoredKoshChangeRequest | null>;
  createReview(input: CreateReview): Promise<StoredKoshReview>;
  listReviews(changeRequestId: string): Promise<StoredKoshReview[]>;
  createComment(input: CreateComment): Promise<StoredKoshReviewComment>;
  listComments(changeRequestId: string): Promise<StoredKoshReviewComment[]>;
  getBranchPolicy(repositoryId: string, branch: string): Promise<StoredKoshBranchPolicy>;
  upsertBranchPolicy(
    repositoryId: string,
    branch: string,
    policy: Omit<StoredKoshBranchPolicy, "repositoryId" | "branch" | "updatedAt">
  ): Promise<StoredKoshBranchPolicy>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function now() {
  return new Date().toISOString();
}

class MemoryKoshReviewStore implements KoshReviewStore {
  readonly kind = "ephemeral-memory" as const;
  private changeRequests = new Map<string, StoredKoshChangeRequest>();
  private reviews = new Map<string, StoredKoshReview>();
  private comments = new Map<string, StoredKoshReviewComment>();
  private policies = new Map<string, StoredKoshBranchPolicy>();

  async ready() {}

  async listChangeRequests(repositoryId: string) {
    return [...this.changeRequests.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => b.number - a.number)
      .map(clone);
  }

  async getChangeRequest(repositoryId: string, number: number) {
    const value = this.changeRequests.get(repositoryId + ":" + number);
    return value ? clone(value) : null;
  }

  async createChangeRequest(input: CreateChangeRequest) {
    const existing = await this.listChangeRequests(input.repositoryId);
    const created = now();
    const record: StoredKoshChangeRequest = {
      ...input,
      id: randomUUID(),
      number: Math.max(0, ...existing.map((item) => item.number)) + 1,
      status: "open",
      createdAt: created,
      updatedAt: created,
      mergedAt: null,
      mergedByUserId: null,
      mergedByName: null,
      mergeCommitSha: null
    };
    this.changeRequests.set(input.repositoryId + ":" + record.number, record);
    return clone(record);
  }

  async closeChangeRequest(repositoryId: string, number: number) {
    const key = repositoryId + ":" + number;
    const value = this.changeRequests.get(key);
    if (!value || value.status !== "open") return value ? clone(value) : null;
    value.status = "closed";
    value.updatedAt = now();
    return clone(value);
  }

  async markMerged(
    repositoryId: string,
    number: number,
    mergedByUserId: string,
    mergedByName: string,
    mergeCommitSha: string
  ) {
    const key = repositoryId + ":" + number;
    const value = this.changeRequests.get(key);
    if (!value) return null;
    value.status = "merged";
    value.updatedAt = now();
    value.mergedAt = value.updatedAt;
    value.mergedByUserId = mergedByUserId;
    value.mergedByName = mergedByName;
    value.mergeCommitSha = mergeCommitSha;
    return clone(value);
  }

  async createReview(input: CreateReview) {
    const record: StoredKoshReview = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.reviews.set(record.id, record);
    return clone(record);
  }

  async listReviews(changeRequestId: string) {
    return [...this.reviews.values()]
      .filter((item) => item.changeRequestId === changeRequestId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async createComment(input: CreateComment) {
    const record: StoredKoshReviewComment = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.comments.set(record.id, record);
    return clone(record);
  }

  async listComments(changeRequestId: string) {
    return [...this.comments.values()]
      .filter((item) => item.changeRequestId === changeRequestId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async getBranchPolicy(repositoryId: string, branch: string) {
    const key = repositoryId + ":" + branch;
    const stored = this.policies.get(key);
    if (stored) return clone(stored);
    return {
      repositoryId,
      branch,
      requiredApprovals: 1,
      blockOnChangesRequested: true,
      allowDirectPush: false,
      allowDelete: false,
      updatedAt: now()
    };
  }

  async upsertBranchPolicy(
    repositoryId: string,
    branch: string,
    policy: Omit<StoredKoshBranchPolicy, "repositoryId" | "branch" | "updatedAt">
  ) {
    const record: StoredKoshBranchPolicy = {
      repositoryId,
      branch,
      ...policy,
      updatedAt: now()
    };
    this.policies.set(repositoryId + ":" + branch, record);
    return clone(record);
  }
}

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? now() : date.toISOString();
}

function changeRequestFromRow(row: Record<string, unknown>): StoredKoshChangeRequest {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    namespace: String(row.namespace),
    slug: String(row.slug),
    number: Number(row.number),
    title: String(row.title),
    description: String(row.description ?? ""),
    baseBranch: String(row.base_branch),
    headBranch: String(row.head_branch),
    baseSha: String(row.base_sha),
    headSha: String(row.head_sha),
    authorUserId: String(row.author_user_id),
    authorName: String(row.author_name),
    status: String(row.status) as KoshChangeRequestStatus,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    mergedAt: row.merged_at ? iso(row.merged_at) : null,
    mergedByUserId: row.merged_by_user_id ? String(row.merged_by_user_id) : null,
    mergedByName: row.merged_by_name ? String(row.merged_by_name) : null,
    mergeCommitSha: row.merge_commit_sha ? String(row.merge_commit_sha) : null
  };
}

function reviewFromRow(row: Record<string, unknown>): StoredKoshReview {
  return {
    id: String(row.id),
    changeRequestId: String(row.change_request_id),
    reviewerUserId: String(row.reviewer_user_id),
    reviewerName: String(row.reviewer_name),
    state: String(row.state) as KoshReviewState,
    body: String(row.body ?? ""),
    createdAt: iso(row.created_at)
  };
}

function commentFromRow(row: Record<string, unknown>): StoredKoshReviewComment {
  return {
    id: String(row.id),
    changeRequestId: String(row.change_request_id),
    authorUserId: String(row.author_user_id),
    authorName: String(row.author_name),
    path: row.path ? String(row.path) : null,
    line: row.line === null || row.line === undefined ? null : Number(row.line),
    side: row.side ? String(row.side) as "base" | "head" : null,
    body: String(row.body),
    createdAt: iso(row.created_at)
  };
}

function policyFromRow(row: Record<string, unknown>): StoredKoshBranchPolicy {
  return {
    repositoryId: String(row.repository_id),
    branch: String(row.branch),
    requiredApprovals: Number(row.required_approvals),
    blockOnChangesRequested: Boolean(row.block_on_changes_requested),
    allowDirectPush: Boolean(row.allow_direct_push),
    allowDelete: Boolean(row.allow_delete),
    updatedAt: iso(row.updated_at)
  };
}

class PostgresKoshReviewStore implements KoshReviewStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`
      CREATE TABLE IF NOT EXISTS kosh_change_request_counters (
        repository_id TEXT PRIMARY KEY,
        next_number INTEGER NOT NULL CHECK (next_number > 0)
      )
    `;

    await this.sql`
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
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS kosh_change_requests_repository_idx
      ON kosh_change_requests(repository_id, updated_at DESC)
    `;

    await this.sql`
      CREATE TABLE IF NOT EXISTS kosh_reviews (
        id TEXT PRIMARY KEY,
        change_request_id TEXT NOT NULL,
        reviewer_user_id TEXT NOT NULL,
        reviewer_name TEXT NOT NULL,
        state TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (state IN ('approve', 'request_changes', 'comment'))
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS kosh_reviews_request_idx
      ON kosh_reviews(change_request_id, created_at ASC)
    `;

    await this.sql`
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
      )
    `;

    await this.sql`
      CREATE INDEX IF NOT EXISTS kosh_review_comments_request_idx
      ON kosh_review_comments(change_request_id, created_at ASC)
    `;

    await this.sql`
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
      )
    `;

    this.initialized = true;
  }

  async listChangeRequests(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT *
      FROM kosh_change_requests
      WHERE repository_id = ${repositoryId}
      ORDER BY number DESC
      LIMIT 500
    `;
    return rows.map((row) => changeRequestFromRow(row as Record<string, unknown>));
  }

  async getChangeRequest(repositoryId: string, number: number) {
    await this.ready();
    const rows = await this.sql`
      SELECT *
      FROM kosh_change_requests
      WHERE repository_id = ${repositoryId} AND number = ${number}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? changeRequestFromRow(row) : null;
  }

  async createChangeRequest(input: CreateChangeRequest) {
    await this.ready();

    return this.sql.begin(async (tx) => {
      const counterRows = await tx`
        INSERT INTO kosh_change_request_counters (repository_id, next_number)
        VALUES (${input.repositoryId}, 1)
        ON CONFLICT (repository_id)
        DO UPDATE SET next_number = kosh_change_request_counters.next_number + 1
        RETURNING next_number
      `;
      const number = Number(counterRows[0]?.next_number ?? 1);
      const id = randomUUID();

      const rows = await tx`
        INSERT INTO kosh_change_requests (
          id, repository_id, namespace, slug, number, title, description,
          base_branch, head_branch, base_sha, head_sha,
          author_user_id, author_name, status, created_at, updated_at
        )
        VALUES (
          ${id}, ${input.repositoryId}, ${input.namespace}, ${input.slug},
          ${number}, ${input.title}, ${input.description},
          ${input.baseBranch}, ${input.headBranch}, ${input.baseSha},
          ${input.headSha}, ${input.authorUserId}, ${input.authorName},
          'open', NOW(), NOW()
        )
        RETURNING *
      `;

      return changeRequestFromRow(rows[0] as Record<string, unknown>);
    });
  }

  async closeChangeRequest(repositoryId: string, number: number) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_change_requests
      SET status = 'closed', updated_at = NOW()
      WHERE repository_id = ${repositoryId}
        AND number = ${number}
        AND status = 'open'
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? changeRequestFromRow(row) : this.getChangeRequest(repositoryId, number);
  }

  async markMerged(
    repositoryId: string,
    number: number,
    mergedByUserId: string,
    mergedByName: string,
    mergeCommitSha: string
  ) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_change_requests
      SET status = 'merged',
          updated_at = NOW(),
          merged_at = NOW(),
          merged_by_user_id = ${mergedByUserId},
          merged_by_name = ${mergedByName},
          merge_commit_sha = ${mergeCommitSha}
      WHERE repository_id = ${repositoryId}
        AND number = ${number}
        AND status = 'open'
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? changeRequestFromRow(row) : this.getChangeRequest(repositoryId, number);
  }

  async createReview(input: CreateReview) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_reviews (
        id, change_request_id, reviewer_user_id, reviewer_name,
        state, body, created_at
      )
      VALUES (
        ${randomUUID()}, ${input.changeRequestId}, ${input.reviewerUserId},
        ${input.reviewerName}, ${input.state}, ${input.body}, NOW()
      )
      RETURNING *
    `;
    return reviewFromRow(rows[0] as Record<string, unknown>);
  }

  async listReviews(changeRequestId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT *
      FROM kosh_reviews
      WHERE change_request_id = ${changeRequestId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) => reviewFromRow(row as Record<string, unknown>));
  }

  async createComment(input: CreateComment) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_review_comments (
        id, change_request_id, author_user_id, author_name,
        path, line, side, body, created_at
      )
      VALUES (
        ${randomUUID()}, ${input.changeRequestId}, ${input.authorUserId},
        ${input.authorName}, ${input.path}, ${input.line}, ${input.side},
        ${input.body}, NOW()
      )
      RETURNING *
    `;
    return commentFromRow(rows[0] as Record<string, unknown>);
  }

  async listComments(changeRequestId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT *
      FROM kosh_review_comments
      WHERE change_request_id = ${changeRequestId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) => commentFromRow(row as Record<string, unknown>));
  }

  async getBranchPolicy(repositoryId: string, branch: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT *
      FROM kosh_branch_policies
      WHERE repository_id = ${repositoryId} AND branch = ${branch}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row) return policyFromRow(row);

    return {
      repositoryId,
      branch,
      requiredApprovals: 1,
      blockOnChangesRequested: true,
      allowDirectPush: false,
      allowDelete: false,
      updatedAt: now()
    };
  }

  async upsertBranchPolicy(
    repositoryId: string,
    branch: string,
    policy: Omit<StoredKoshBranchPolicy, "repositoryId" | "branch" | "updatedAt">
  ) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_branch_policies (
        repository_id, branch, required_approvals,
        block_on_changes_requested, allow_direct_push, allow_delete, updated_at
      )
      VALUES (
        ${repositoryId}, ${branch}, ${policy.requiredApprovals},
        ${policy.blockOnChangesRequested}, ${policy.allowDirectPush},
        ${policy.allowDelete}, NOW()
      )
      ON CONFLICT (repository_id, branch)
      DO UPDATE SET
        required_approvals = EXCLUDED.required_approvals,
        block_on_changes_requested = EXCLUDED.block_on_changes_requested,
        allow_direct_push = EXCLUDED.allow_direct_push,
        allow_delete = EXCLUDED.allow_delete,
        updated_at = NOW()
      RETURNING *
    `;
    return policyFromRow(rows[0] as Record<string, unknown>);
  }
}

let singleton: KoshReviewStore | null = null;

export function getKoshReviewStore(): KoshReviewStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshReviewStore(postgres(databaseUrl, { max: 5, prepare: false }))
    : new MemoryKoshReviewStore();
  return singleton;
}
