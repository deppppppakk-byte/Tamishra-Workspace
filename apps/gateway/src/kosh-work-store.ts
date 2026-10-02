import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshIssueState = "open" | "closed";
export type KoshMilestoneState = "open" | "closed";
export type KoshDiscussionState = "open" | "locked";
export type KoshBoardColumn = "backlog" | "ready" | "in_progress" | "in_review" | "done";

export type StoredKoshIssue = {
  id: string;
  repositoryId: string;
  namespace: string;
  slug: string;
  number: number;
  title: string;
  body: string;
  authorUserId: string;
  authorName: string;
  state: KoshIssueState;
  milestoneId: string | null;
  milestoneTitle: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedByUserId: string | null;
  closedByName: string | null;
};

export type StoredKoshLabel = {
  id: string;
  repositoryId: string;
  name: string;
  description: string;
  color: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshMilestone = {
  id: string;
  repositoryId: string;
  title: string;
  description: string;
  dueAt: string | null;
  state: KoshMilestoneState;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshIssueComment = {
  id: string;
  issueId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshDependency = {
  issueId: string;
  dependsOnIssueId: string;
  dependsOnNumber: number;
  dependsOnTitle: string;
  dependsOnState: KoshIssueState;
  createdByUserId: string;
  createdAt: string;
};

export type StoredKoshDiscussion = {
  id: string;
  repositoryId: string;
  namespace: string;
  slug: string;
  number: number;
  title: string;
  body: string;
  category: string;
  authorUserId: string;
  authorName: string;
  state: KoshDiscussionState;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshDiscussionReply = {
  id: string;
  discussionId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type StoredKoshBoard = {
  id: string;
  repositoryId: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshBoardCard = {
  id: string;
  boardId: string;
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  issueState: KoshIssueState;
  column: KoshBoardColumn;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshIssueLink = {
  id: string;
  issueId: string;
  linkType: "change_request" | "commit";
  refValue: string;
  title: string | null;
  createdByUserId: string;
  createdAt: string;
};

export type StoredKoshIssueTemplate = {
  id: string;
  repositoryId: string;
  name: string;
  titleTemplate: string;
  bodyTemplate: string;
  labelNames: string[];
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshActivity = {
  id: string;
  repositoryId: string;
  entityType: string;
  entityId: string;
  entityNumber: number | null;
  eventType: string;
  actorUserId: string;
  actorName: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type StoredKoshNotification = {
  id: string;
  userId: string;
  repositoryId: string;
  title: string;
  body: string;
  href: string;
  readAt: string | null;
  createdAt: string;
};

export interface KoshWorkStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;

  listIssues(repositoryId: string): Promise<StoredKoshIssue[]>;
  getIssue(repositoryId: string, number: number): Promise<StoredKoshIssue | null>;
  createIssue(input: Omit<StoredKoshIssue, "id" | "number" | "state" | "createdAt" | "updatedAt" | "closedAt" | "closedByUserId" | "closedByName" | "milestoneTitle">): Promise<StoredKoshIssue>;
  updateIssue(
    repositoryId: string,
    number: number,
    input: Partial<Pick<StoredKoshIssue, "title" | "body" | "milestoneId" | "assigneeUserId" | "assigneeName">> & {
      state?: KoshIssueState;
      actorUserId?: string;
      actorName?: string;
    }
  ): Promise<StoredKoshIssue | null>;

  listLabels(repositoryId: string): Promise<StoredKoshLabel[]>;
  createLabel(input: Omit<StoredKoshLabel, "id" | "createdAt" | "updatedAt">): Promise<StoredKoshLabel>;
  getIssueLabels(issueId: string): Promise<StoredKoshLabel[]>;
  replaceIssueLabels(issueId: string, labelIds: string[]): Promise<StoredKoshLabel[]>;

  listMilestones(repositoryId: string): Promise<StoredKoshMilestone[]>;
  createMilestone(input: Omit<StoredKoshMilestone, "id" | "state" | "createdAt" | "updatedAt">): Promise<StoredKoshMilestone>;

  listIssueComments(issueId: string): Promise<StoredKoshIssueComment[]>;
  createIssueComment(input: Omit<StoredKoshIssueComment, "id" | "createdAt" | "updatedAt">): Promise<StoredKoshIssueComment>;

  listDependencies(issueId: string): Promise<StoredKoshDependency[]>;
  createDependency(input: { issueId: string; dependsOnIssueId: string; createdByUserId: string }): Promise<StoredKoshDependency>;
  deleteDependency(issueId: string, dependsOnIssueId: string): Promise<boolean>;
  listIssueLinks(issueId: string): Promise<StoredKoshIssueLink[]>;
  createIssueLink(input: Omit<StoredKoshIssueLink, "id" | "createdAt">): Promise<StoredKoshIssueLink>;

  listDiscussions(repositoryId: string): Promise<StoredKoshDiscussion[]>;
  getDiscussion(repositoryId: string, number: number): Promise<StoredKoshDiscussion | null>;
  createDiscussion(input: Omit<StoredKoshDiscussion, "id" | "number" | "state" | "createdAt" | "updatedAt">): Promise<StoredKoshDiscussion>;
  updateDiscussionState(repositoryId: string, number: number, state: KoshDiscussionState): Promise<StoredKoshDiscussion | null>;
  listDiscussionReplies(discussionId: string): Promise<StoredKoshDiscussionReply[]>;
  createDiscussionReply(input: Omit<StoredKoshDiscussionReply, "id" | "createdAt">): Promise<StoredKoshDiscussionReply>;

  listBoards(repositoryId: string): Promise<StoredKoshBoard[]>;
  createBoard(input: Omit<StoredKoshBoard, "id" | "createdAt" | "updatedAt">): Promise<StoredKoshBoard>;
  listBoardCards(boardId: string): Promise<StoredKoshBoardCard[]>;
  putBoardCard(input: { boardId: string; issueId: string; column: KoshBoardColumn; position: number }): Promise<StoredKoshBoardCard>;
  deleteBoardCard(boardId: string, issueId: string): Promise<boolean>;

  listTemplates(repositoryId: string): Promise<StoredKoshIssueTemplate[]>;
  createTemplate(input: Omit<StoredKoshIssueTemplate, "id" | "createdAt" | "updatedAt">): Promise<StoredKoshIssueTemplate>;

  createActivity(input: Omit<StoredKoshActivity, "id" | "createdAt">): Promise<StoredKoshActivity>;
  listActivity(repositoryId: string, limit?: number): Promise<StoredKoshActivity[]>;

  createNotification(input: Omit<StoredKoshNotification, "id" | "readAt" | "createdAt">): Promise<StoredKoshNotification>;
  listNotifications(userId: string, repositoryId?: string): Promise<StoredKoshNotification[]>;
  markNotificationRead(id: string, userId: string): Promise<boolean>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryKoshWorkStore implements KoshWorkStore {
  readonly kind = "ephemeral-memory" as const;
  private issues = new Map<string, StoredKoshIssue>();
  private labels = new Map<string, StoredKoshLabel>();
  private issueLabels = new Map<string, Set<string>>();
  private milestones = new Map<string, StoredKoshMilestone>();
  private comments = new Map<string, StoredKoshIssueComment>();
  private dependencies = new Map<string, { createdByUserId: string; createdAt: string }>();
  private issueLinks = new Map<string, StoredKoshIssueLink>();
  private discussions = new Map<string, StoredKoshDiscussion>();
  private discussionReplies = new Map<string, StoredKoshDiscussionReply>();
  private boards = new Map<string, StoredKoshBoard>();
  private cards = new Map<string, StoredKoshBoardCard>();
  private templates = new Map<string, StoredKoshIssueTemplate>();
  private activities = new Map<string, StoredKoshActivity>();
  private notifications = new Map<string, StoredKoshNotification>();

  async ready() {}

  private nextIssueNumber(repositoryId: string) {
    return Math.max(
      0,
      ...[...this.issues.values()]
        .filter((item) => item.repositoryId === repositoryId)
        .map((item) => item.number)
    ) + 1;
  }

  private nextDiscussionNumber(repositoryId: string) {
    return Math.max(
      0,
      ...[...this.discussions.values()]
        .filter((item) => item.repositoryId === repositoryId)
        .map((item) => item.number)
    ) + 1;
  }

  async listIssues(repositoryId: string) {
    return [...this.issues.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => b.number - a.number)
      .map(clone);
  }

  async getIssue(repositoryId: string, number: number) {
    const item = [...this.issues.values()].find(
      (value) => value.repositoryId === repositoryId && value.number === number
    );
    return item ? clone(item) : null;
  }

  async createIssue(input: Omit<StoredKoshIssue, "id" | "number" | "state" | "createdAt" | "updatedAt" | "closedAt" | "closedByUserId" | "closedByName" | "milestoneTitle">) {
    const created = now();
    const milestone = input.milestoneId ? this.milestones.get(input.milestoneId) : null;
    const issue: StoredKoshIssue = {
      ...input,
      id: randomUUID(),
      number: this.nextIssueNumber(input.repositoryId),
      state: "open",
      milestoneTitle: milestone?.title ?? null,
      createdAt: created,
      updatedAt: created,
      closedAt: null,
      closedByUserId: null,
      closedByName: null
    };
    this.issues.set(issue.id, issue);
    return clone(issue);
  }

  async updateIssue(repositoryId: string, number: number, input: Partial<Pick<StoredKoshIssue, "title" | "body" | "milestoneId" | "assigneeUserId" | "assigneeName">> & { state?: KoshIssueState; actorUserId?: string; actorName?: string }) {
    const issue = [...this.issues.values()].find(
      (value) => value.repositoryId === repositoryId && value.number === number
    );
    if (!issue) return null;

    if (input.title !== undefined) issue.title = input.title;
    if (input.body !== undefined) issue.body = input.body;
    if (input.milestoneId !== undefined) {
      issue.milestoneId = input.milestoneId;
      issue.milestoneTitle = input.milestoneId
        ? this.milestones.get(input.milestoneId)?.title ?? null
        : null;
    }
    if (input.assigneeUserId !== undefined) issue.assigneeUserId = input.assigneeUserId;
    if (input.assigneeName !== undefined) issue.assigneeName = input.assigneeName;

    if (input.state && input.state !== issue.state) {
      issue.state = input.state;
      if (input.state === "closed") {
        issue.closedAt = now();
        issue.closedByUserId = input.actorUserId ?? null;
        issue.closedByName = input.actorName ?? null;
      } else {
        issue.closedAt = null;
        issue.closedByUserId = null;
        issue.closedByName = null;
      }
    }

    issue.updatedAt = now();
    return clone(issue);
  }

  async listLabels(repositoryId: string) {
    return [...this.labels.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(clone);
  }

  async createLabel(input: Omit<StoredKoshLabel, "id" | "createdAt" | "updatedAt">) {
    const duplicate = [...this.labels.values()].find(
      (value) => value.repositoryId === input.repositoryId && value.name.toLowerCase() === input.name.toLowerCase()
    );
    if (duplicate) throw Object.assign(new Error("label_exists"), { status: 409 });

    const created = now();
    const label: StoredKoshLabel = {
      ...input,
      id: randomUUID(),
      createdAt: created,
      updatedAt: created
    };
    this.labels.set(label.id, label);
    return clone(label);
  }

  async getIssueLabels(issueId: string) {
    const ids = this.issueLabels.get(issueId) ?? new Set<string>();
    return [...ids]
      .map((id) => this.labels.get(id))
      .filter((value): value is StoredKoshLabel => Boolean(value))
      .map(clone);
  }

  async replaceIssueLabels(issueId: string, labelIds: string[]) {
    this.issueLabels.set(issueId, new Set(labelIds.filter((id) => this.labels.has(id))));
    return this.getIssueLabels(issueId);
  }

  async listMilestones(repositoryId: string) {
    return [...this.milestones.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => a.title.localeCompare(b.title))
      .map(clone);
  }

  async createMilestone(input: Omit<StoredKoshMilestone, "id" | "state" | "createdAt" | "updatedAt">) {
    const created = now();
    const milestone: StoredKoshMilestone = {
      ...input,
      id: randomUUID(),
      state: "open",
      createdAt: created,
      updatedAt: created
    };
    this.milestones.set(milestone.id, milestone);
    return clone(milestone);
  }

  async listIssueComments(issueId: string) {
    return [...this.comments.values()]
      .filter((item) => item.issueId === issueId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async createIssueComment(input: Omit<StoredKoshIssueComment, "id" | "createdAt" | "updatedAt">) {
    const created = now();
    const comment: StoredKoshIssueComment = {
      ...input,
      id: randomUUID(),
      createdAt: created,
      updatedAt: created
    };
    this.comments.set(comment.id, comment);
    return clone(comment);
  }

  async listDependencies(issueId: string) {
    const rows: StoredKoshDependency[] = [];
    for (const [key, meta] of this.dependencies) {
      const [sourceId, targetId] = key.split(":");
      if (sourceId !== issueId) continue;
      const target = this.issues.get(targetId);
      if (!target) continue;
      rows.push({
        issueId,
        dependsOnIssueId: target.id,
        dependsOnNumber: target.number,
        dependsOnTitle: target.title,
        dependsOnState: target.state,
        createdByUserId: meta.createdByUserId,
        createdAt: meta.createdAt
      });
    }
    return rows.sort((a, b) => a.dependsOnNumber - b.dependsOnNumber).map(clone);
  }

  async createDependency(input: { issueId: string; dependsOnIssueId: string; createdByUserId: string }) {
    if (input.issueId === input.dependsOnIssueId) {
      throw Object.assign(new Error("issue_cannot_depend_on_itself"), { status: 400 });
    }
    const target = this.issues.get(input.dependsOnIssueId);
    if (!target) throw Object.assign(new Error("dependency_issue_not_found"), { status: 404 });
    const key = input.issueId + ":" + input.dependsOnIssueId;
    const meta = { createdByUserId: input.createdByUserId, createdAt: now() };
    this.dependencies.set(key, meta);
    return {
      issueId: input.issueId,
      dependsOnIssueId: target.id,
      dependsOnNumber: target.number,
      dependsOnTitle: target.title,
      dependsOnState: target.state,
      ...meta
    };
  }

  async deleteDependency(issueId: string, dependsOnIssueId: string) {
    return this.dependencies.delete(issueId + ":" + dependsOnIssueId);
  }

  async listIssueLinks(issueId: string) {
    return [...this.issueLinks.values()]
      .filter((item) => item.issueId === issueId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async createIssueLink(input: Omit<StoredKoshIssueLink, "id" | "createdAt">) {
    const duplicate = [...this.issueLinks.values()].find(
      (item) =>
        item.issueId === input.issueId &&
        item.linkType === input.linkType &&
        item.refValue === input.refValue
    );
    if (duplicate) return clone(duplicate);

    const link: StoredKoshIssueLink = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.issueLinks.set(link.id, link);
    return clone(link);
  }

  async listDiscussions(repositoryId: string) {
    return [...this.discussions.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => b.number - a.number)
      .map(clone);
  }

  async getDiscussion(repositoryId: string, number: number) {
    const item = [...this.discussions.values()].find(
      (value) => value.repositoryId === repositoryId && value.number === number
    );
    return item ? clone(item) : null;
  }

  async createDiscussion(input: Omit<StoredKoshDiscussion, "id" | "number" | "state" | "createdAt" | "updatedAt">) {
    const created = now();
    const discussion: StoredKoshDiscussion = {
      ...input,
      id: randomUUID(),
      number: this.nextDiscussionNumber(input.repositoryId),
      state: "open",
      createdAt: created,
      updatedAt: created
    };
    this.discussions.set(discussion.id, discussion);
    return clone(discussion);
  }

  async updateDiscussionState(repositoryId: string, number: number, state: KoshDiscussionState) {
    const discussion = [...this.discussions.values()].find(
      (value) => value.repositoryId === repositoryId && value.number === number
    );
    if (!discussion) return null;
    discussion.state = state;
    discussion.updatedAt = now();
    return clone(discussion);
  }

  async listDiscussionReplies(discussionId: string) {
    return [...this.discussionReplies.values()]
      .filter((item) => item.discussionId === discussionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async createDiscussionReply(input: Omit<StoredKoshDiscussionReply, "id" | "createdAt">) {
    const reply: StoredKoshDiscussionReply = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.discussionReplies.set(reply.id, reply);
    return clone(reply);
  }

  async listBoards(repositoryId: string) {
    return [...this.boards.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async createBoard(input: Omit<StoredKoshBoard, "id" | "createdAt" | "updatedAt">) {
    const created = now();
    const board: StoredKoshBoard = {
      ...input,
      id: randomUUID(),
      createdAt: created,
      updatedAt: created
    };
    this.boards.set(board.id, board);
    return clone(board);
  }

  async listBoardCards(boardId: string) {
    return [...this.cards.values()]
      .filter((item) => item.boardId === boardId)
      .sort((a, b) => a.position - b.position)
      .map(clone);
  }

  async putBoardCard(input: { boardId: string; issueId: string; column: KoshBoardColumn; position: number }) {
    const issue = this.issues.get(input.issueId);
    if (!issue) throw Object.assign(new Error("issue_not_found"), { status: 404 });

    const key = input.boardId + ":" + input.issueId;
    const existing = this.cards.get(key);
    const created = existing?.createdAt ?? now();
    const card: StoredKoshBoardCard = {
      id: existing?.id ?? randomUUID(),
      boardId: input.boardId,
      issueId: issue.id,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueState: issue.state,
      column: input.column,
      position: input.position,
      createdAt: created,
      updatedAt: now()
    };
    this.cards.set(key, card);
    return clone(card);
  }

  async deleteBoardCard(boardId: string, issueId: string) {
    return this.cards.delete(boardId + ":" + issueId);
  }

  async listTemplates(repositoryId: string) {
    return [...this.templates.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(clone);
  }

  async createTemplate(input: Omit<StoredKoshIssueTemplate, "id" | "createdAt" | "updatedAt">) {
    const created = now();
    const template: StoredKoshIssueTemplate = {
      ...input,
      id: randomUUID(),
      createdAt: created,
      updatedAt: created
    };
    this.templates.set(template.id, template);
    return clone(template);
  }

  async createActivity(input: Omit<StoredKoshActivity, "id" | "createdAt">) {
    const event: StoredKoshActivity = {
      ...input,
      id: randomUUID(),
      createdAt: now()
    };
    this.activities.set(event.id, event);
    return clone(event);
  }

  async listActivity(repositoryId: string, limit = 100) {
    return [...this.activities.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map(clone);
  }

  async createNotification(input: Omit<StoredKoshNotification, "id" | "readAt" | "createdAt">) {
    const notification: StoredKoshNotification = {
      ...input,
      id: randomUUID(),
      readAt: null,
      createdAt: now()
    };
    this.notifications.set(notification.id, notification);
    return clone(notification);
  }

  async listNotifications(userId: string, repositoryId?: string) {
    return [...this.notifications.values()]
      .filter((item) => item.userId === userId && (!repositoryId || item.repositoryId === repositoryId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200)
      .map(clone);
  }

  async markNotificationRead(id: string, userId: string) {
    const item = this.notifications.get(id);
    if (!item || item.userId !== userId) return false;
    item.readAt = now();
    return true;
  }
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function issueFromRow(row: Record<string, unknown>): StoredKoshIssue {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    namespace: String(row.namespace),
    slug: String(row.slug),
    number: Number(row.number),
    title: String(row.title),
    body: String(row.body ?? ""),
    authorUserId: String(row.author_user_id),
    authorName: String(row.author_name),
    state: String(row.state) as KoshIssueState,
    milestoneId: row.milestone_id ? String(row.milestone_id) : null,
    milestoneTitle: row.milestone_title ? String(row.milestone_title) : null,
    assigneeUserId: row.assignee_user_id ? String(row.assignee_user_id) : null,
    assigneeName: row.assignee_name ? String(row.assignee_name) : null,
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now(),
    closedAt: iso(row.closed_at),
    closedByUserId: row.closed_by_user_id ? String(row.closed_by_user_id) : null,
    closedByName: row.closed_by_name ? String(row.closed_by_name) : null
  };
}

function labelFromRow(row: Record<string, unknown>): StoredKoshLabel {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    color: String(row.color),
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function milestoneFromRow(row: Record<string, unknown>): StoredKoshMilestone {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    title: String(row.title),
    description: String(row.description ?? ""),
    dueAt: iso(row.due_at),
    state: String(row.state) as KoshMilestoneState,
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function commentFromRow(row: Record<string, unknown>): StoredKoshIssueComment {
  return {
    id: String(row.id),
    issueId: String(row.issue_id),
    authorUserId: String(row.author_user_id),
    authorName: String(row.author_name),
    body: String(row.body),
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function discussionFromRow(row: Record<string, unknown>): StoredKoshDiscussion {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    namespace: String(row.namespace),
    slug: String(row.slug),
    number: Number(row.number),
    title: String(row.title),
    body: String(row.body),
    category: String(row.category),
    authorUserId: String(row.author_user_id),
    authorName: String(row.author_name),
    state: String(row.state) as KoshDiscussionState,
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function discussionReplyFromRow(row: Record<string, unknown>): StoredKoshDiscussionReply {
  return {
    id: String(row.id),
    discussionId: String(row.discussion_id),
    authorUserId: String(row.author_user_id),
    authorName: String(row.author_name),
    body: String(row.body),
    createdAt: iso(row.created_at) ?? now()
  };
}

function boardFromRow(row: Record<string, unknown>): StoredKoshBoard {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function boardCardFromRow(row: Record<string, unknown>): StoredKoshBoardCard {
  return {
    id: String(row.id),
    boardId: String(row.board_id),
    issueId: String(row.issue_id),
    issueNumber: Number(row.issue_number),
    issueTitle: String(row.issue_title),
    issueState: String(row.issue_state) as KoshIssueState,
    column: String(row.column_key) as KoshBoardColumn,
    position: Number(row.position),
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function templateFromRow(row: Record<string, unknown>): StoredKoshIssueTemplate {
  const rawLabels = row.label_names;
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    name: String(row.name),
    titleTemplate: String(row.title_template ?? ""),
    bodyTemplate: String(row.body_template ?? ""),
    labelNames: Array.isArray(rawLabels) ? rawLabels.map(String) : [],
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function activityFromRow(row: Record<string, unknown>): StoredKoshActivity {
  const payload =
    row.payload && typeof row.payload === "object"
      ? row.payload as Record<string, unknown>
      : {};
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    entityNumber: row.entity_number === null || row.entity_number === undefined ? null : Number(row.entity_number),
    eventType: String(row.event_type),
    actorUserId: String(row.actor_user_id),
    actorName: String(row.actor_name),
    payload,
    createdAt: iso(row.created_at) ?? now()
  };
}

function notificationFromRow(row: Record<string, unknown>): StoredKoshNotification {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    repositoryId: String(row.repository_id),
    title: String(row.title),
    body: String(row.body),
    href: String(row.href),
    readAt: iso(row.read_at),
    createdAt: iso(row.created_at) ?? now()
  };
}

class PostgresKoshWorkStore implements KoshWorkStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_issue_counters (
      repository_id TEXT PRIMARY KEY,
      next_number INTEGER NOT NULL CHECK (next_number > 0)
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_issues (
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
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_issues_repository_idx
      ON kosh_issues(repository_id, updated_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_labels (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, name)
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_issue_labels (
      issue_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      PRIMARY KEY(issue_id, label_id)
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_milestones (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      due_at TIMESTAMPTZ,
      state TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (state IN ('open','closed'))
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_issue_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_issue_comments_issue_idx
      ON kosh_issue_comments(issue_id, created_at ASC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_issue_dependencies (
      issue_id TEXT NOT NULL,
      depends_on_issue_id TEXT NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(issue_id, depends_on_issue_id),
      CHECK (issue_id <> depends_on_issue_id)
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_issue_links (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      ref_value TEXT NOT NULL,
      title TEXT,
      created_by_user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(issue_id, link_type, ref_value),
      CHECK (link_type IN ('change_request','commit'))
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_discussion_counters (
      repository_id TEXT PRIMARY KEY,
      next_number INTEGER NOT NULL CHECK (next_number > 0)
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_discussions (
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
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_discussion_replies (
      id TEXT PRIMARY KEY,
      discussion_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_project_boards (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_project_cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      column_key TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(board_id, issue_id),
      CHECK (column_key IN ('backlog','ready','in_progress','in_review','done'))
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_issue_templates (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      name TEXT NOT NULL,
      title_template TEXT NOT NULL DEFAULT '',
      body_template TEXT NOT NULL DEFAULT '',
      label_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_activity_events (
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
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_activity_repository_idx
      ON kosh_activity_events(repository_id, created_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      href TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_notifications_user_idx
      ON kosh_notifications(user_id, created_at DESC)`;

    this.initialized = true;
  }

  async listIssues(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT i.*, m.title AS milestone_title
      FROM kosh_issues i
      LEFT JOIN kosh_milestones m ON m.id = i.milestone_id
      WHERE i.repository_id = ${repositoryId}
      ORDER BY i.number DESC
      LIMIT 1000
    `;
    return rows.map((row) => issueFromRow(row as Record<string, unknown>));
  }

  async getIssue(repositoryId: string, number: number) {
    await this.ready();
    const rows = await this.sql`
      SELECT i.*, m.title AS milestone_title
      FROM kosh_issues i
      LEFT JOIN kosh_milestones m ON m.id = i.milestone_id
      WHERE i.repository_id = ${repositoryId} AND i.number = ${number}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? issueFromRow(row) : null;
  }

  async createIssue(input: Omit<StoredKoshIssue, "id" | "number" | "state" | "createdAt" | "updatedAt" | "closedAt" | "closedByUserId" | "closedByName" | "milestoneTitle">) {
    await this.ready();
    return this.sql.begin(async (tx) => {
      const counterRows = await tx`
        INSERT INTO kosh_issue_counters(repository_id, next_number)
        VALUES (${input.repositoryId}, 1)
        ON CONFLICT(repository_id)
        DO UPDATE SET next_number = kosh_issue_counters.next_number + 1
        RETURNING next_number
      `;
      const number = Number(counterRows[0]?.next_number ?? 1);
      const rows = await tx`
        INSERT INTO kosh_issues(
          id, repository_id, namespace, slug, number, title, body,
          author_user_id, author_name, milestone_id, assignee_user_id, assignee_name
        )
        VALUES (
          ${randomUUID()}, ${input.repositoryId}, ${input.namespace}, ${input.slug},
          ${number}, ${input.title}, ${input.body},
          ${input.authorUserId}, ${input.authorName}, ${input.milestoneId},
          ${input.assigneeUserId}, ${input.assigneeName}
        )
        RETURNING *
      `;
      const created = issueFromRow(rows[0] as Record<string, unknown>);
      if (input.milestoneId) {
        const milestoneRows = await tx`SELECT title FROM kosh_milestones WHERE id = ${input.milestoneId} LIMIT 1`;
        created.milestoneTitle = milestoneRows[0]?.title ? String(milestoneRows[0].title) : null;
      }
      return created;
    });
  }

  async updateIssue(repositoryId: string, number: number, input: Partial<Pick<StoredKoshIssue, "title" | "body" | "milestoneId" | "assigneeUserId" | "assigneeName">> & { state?: KoshIssueState; actorUserId?: string; actorName?: string }) {
    await this.ready();
    const current = await this.getIssue(repositoryId, number);
    if (!current) return null;

    const nextState = input.state ?? current.state;
    const closedAt = nextState === "closed" ? (current.closedAt ?? now()) : null;
    const closedByUserId = nextState === "closed" ? (current.closedByUserId ?? input.actorUserId ?? null) : null;
    const closedByName = nextState === "closed" ? (current.closedByName ?? input.actorName ?? null) : null;

    const rows = await this.sql`
      UPDATE kosh_issues
      SET title = ${input.title ?? current.title},
          body = ${input.body ?? current.body},
          milestone_id = ${input.milestoneId === undefined ? current.milestoneId : input.milestoneId},
          assignee_user_id = ${input.assigneeUserId === undefined ? current.assigneeUserId : input.assigneeUserId},
          assignee_name = ${input.assigneeName === undefined ? current.assigneeName : input.assigneeName},
          state = ${nextState},
          closed_at = ${closedAt},
          closed_by_user_id = ${closedByUserId},
          closed_by_name = ${closedByName},
          updated_at = NOW()
      WHERE repository_id = ${repositoryId} AND number = ${number}
      RETURNING *
    `;

    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const issue = issueFromRow(row);
    if (issue.milestoneId) {
      const milestoneRows = await this.sql`SELECT title FROM kosh_milestones WHERE id = ${issue.milestoneId} LIMIT 1`;
      issue.milestoneTitle = milestoneRows[0]?.title ? String(milestoneRows[0].title) : null;
    }
    return issue;
  }

  async listLabels(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_labels
      WHERE repository_id = ${repositoryId}
      ORDER BY name ASC
    `;
    return rows.map((row) => labelFromRow(row as Record<string, unknown>));
  }

  async createLabel(input: Omit<StoredKoshLabel, "id" | "createdAt" | "updatedAt">) {
    await this.ready();
    try {
      const rows = await this.sql`
        INSERT INTO kosh_labels(id, repository_id, name, description, color)
        VALUES (${randomUUID()}, ${input.repositoryId}, ${input.name}, ${input.description}, ${input.color})
        RETURNING *
      `;
      return labelFromRow(rows[0] as Record<string, unknown>);
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") {
        throw Object.assign(new Error("label_exists"), { status: 409 });
      }
      throw error;
    }
  }

  async getIssueLabels(issueId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT l.*
      FROM kosh_issue_labels il
      JOIN kosh_labels l ON l.id = il.label_id
      WHERE il.issue_id = ${issueId}
      ORDER BY l.name ASC
    `;
    return rows.map((row) => labelFromRow(row as Record<string, unknown>));
  }

  async replaceIssueLabels(issueId: string, labelIds: string[]) {
    await this.ready();
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM kosh_issue_labels WHERE issue_id = ${issueId}`;
      for (const labelId of [...new Set(labelIds)].slice(0, 50)) {
        await tx`
          INSERT INTO kosh_issue_labels(issue_id, label_id)
          SELECT ${issueId}, id FROM kosh_labels WHERE id = ${labelId}
          ON CONFLICT DO NOTHING
        `;
      }
    });
    return this.getIssueLabels(issueId);
  }

  async listMilestones(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_milestones
      WHERE repository_id = ${repositoryId}
      ORDER BY title ASC
    `;
    return rows.map((row) => milestoneFromRow(row as Record<string, unknown>));
  }

  async createMilestone(input: Omit<StoredKoshMilestone, "id" | "state" | "createdAt" | "updatedAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_milestones(id, repository_id, title, description, due_at)
      VALUES (${randomUUID()}, ${input.repositoryId}, ${input.title}, ${input.description}, ${input.dueAt})
      RETURNING *
    `;
    return milestoneFromRow(rows[0] as Record<string, unknown>);
  }

  async listIssueComments(issueId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_issue_comments
      WHERE issue_id = ${issueId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) => commentFromRow(row as Record<string, unknown>));
  }

  async createIssueComment(input: Omit<StoredKoshIssueComment, "id" | "createdAt" | "updatedAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_issue_comments(id, issue_id, author_user_id, author_name, body)
      VALUES (${randomUUID()}, ${input.issueId}, ${input.authorUserId}, ${input.authorName}, ${input.body})
      RETURNING *
    `;
    return commentFromRow(rows[0] as Record<string, unknown>);
  }

  async listDependencies(issueId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT d.issue_id, d.depends_on_issue_id, d.created_by_user_id, d.created_at,
             i.number AS depends_on_number, i.title AS depends_on_title, i.state AS depends_on_state
      FROM kosh_issue_dependencies d
      JOIN kosh_issues i ON i.id = d.depends_on_issue_id
      WHERE d.issue_id = ${issueId}
      ORDER BY i.number ASC
    `;
    return rows.map((row) => ({
      issueId: String(row.issue_id),
      dependsOnIssueId: String(row.depends_on_issue_id),
      dependsOnNumber: Number(row.depends_on_number),
      dependsOnTitle: String(row.depends_on_title),
      dependsOnState: String(row.depends_on_state) as KoshIssueState,
      createdByUserId: String(row.created_by_user_id),
      createdAt: iso(row.created_at) ?? now()
    }));
  }

  async createDependency(input: { issueId: string; dependsOnIssueId: string; createdByUserId: string }) {
    await this.ready();
    if (input.issueId === input.dependsOnIssueId) {
      throw Object.assign(new Error("issue_cannot_depend_on_itself"), { status: 400 });
    }
    await this.sql`
      INSERT INTO kosh_issue_dependencies(issue_id, depends_on_issue_id, created_by_user_id)
      VALUES (${input.issueId}, ${input.dependsOnIssueId}, ${input.createdByUserId})
      ON CONFLICT DO NOTHING
    `;
    const rows = await this.sql`
      SELECT d.issue_id, d.depends_on_issue_id, d.created_by_user_id, d.created_at,
             i.number AS depends_on_number, i.title AS depends_on_title, i.state AS depends_on_state
      FROM kosh_issue_dependencies d
      JOIN kosh_issues i ON i.id = d.depends_on_issue_id
      WHERE d.issue_id = ${input.issueId} AND d.depends_on_issue_id = ${input.dependsOnIssueId}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error("dependency_issue_not_found"), { status: 404 });
    return {
      issueId: String(row.issue_id),
      dependsOnIssueId: String(row.depends_on_issue_id),
      dependsOnNumber: Number(row.depends_on_number),
      dependsOnTitle: String(row.depends_on_title),
      dependsOnState: String(row.depends_on_state) as KoshIssueState,
      createdByUserId: String(row.created_by_user_id),
      createdAt: iso(row.created_at) ?? now()
    };
  }

  async deleteDependency(issueId: string, dependsOnIssueId: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_issue_dependencies
      WHERE issue_id = ${issueId} AND depends_on_issue_id = ${dependsOnIssueId}
      RETURNING issue_id
    `;
    return rows.length > 0;
  }

  async listIssueLinks(issueId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_issue_links
      WHERE issue_id = ${issueId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) => ({
      id: String(row.id),
      issueId: String(row.issue_id),
      linkType: String(row.link_type) as "change_request" | "commit",
      refValue: String(row.ref_value),
      title: row.title ? String(row.title) : null,
      createdByUserId: String(row.created_by_user_id),
      createdAt: iso(row.created_at) ?? now()
    }));
  }

  async createIssueLink(input: Omit<StoredKoshIssueLink, "id" | "createdAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_issue_links(
        id, issue_id, link_type, ref_value, title, created_by_user_id
      )
      VALUES (
        ${randomUUID()}, ${input.issueId}, ${input.linkType},
        ${input.refValue}, ${input.title}, ${input.createdByUserId}
      )
      ON CONFLICT(issue_id, link_type, ref_value)
      DO UPDATE SET title = COALESCE(EXCLUDED.title, kosh_issue_links.title)
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      issueId: String(row.issue_id),
      linkType: String(row.link_type) as "change_request" | "commit",
      refValue: String(row.ref_value),
      title: row.title ? String(row.title) : null,
      createdByUserId: String(row.created_by_user_id),
      createdAt: iso(row.created_at) ?? now()
    };
  }

  async listDiscussions(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_discussions
      WHERE repository_id = ${repositoryId}
      ORDER BY number DESC
      LIMIT 1000
    `;
    return rows.map((row) => discussionFromRow(row as Record<string, unknown>));
  }

  async getDiscussion(repositoryId: string, number: number) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_discussions
      WHERE repository_id = ${repositoryId} AND number = ${number}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? discussionFromRow(row) : null;
  }

  async createDiscussion(input: Omit<StoredKoshDiscussion, "id" | "number" | "state" | "createdAt" | "updatedAt">) {
    await this.ready();
    return this.sql.begin(async (tx) => {
      const counterRows = await tx`
        INSERT INTO kosh_discussion_counters(repository_id, next_number)
        VALUES (${input.repositoryId}, 1)
        ON CONFLICT(repository_id)
        DO UPDATE SET next_number = kosh_discussion_counters.next_number + 1
        RETURNING next_number
      `;
      const number = Number(counterRows[0]?.next_number ?? 1);
      const rows = await tx`
        INSERT INTO kosh_discussions(
          id, repository_id, namespace, slug, number, title, body, category,
          author_user_id, author_name
        )
        VALUES (
          ${randomUUID()}, ${input.repositoryId}, ${input.namespace}, ${input.slug},
          ${number}, ${input.title}, ${input.body}, ${input.category},
          ${input.authorUserId}, ${input.authorName}
        )
        RETURNING *
      `;
      return discussionFromRow(rows[0] as Record<string, unknown>);
    });
  }

  async updateDiscussionState(repositoryId: string, number: number, state: KoshDiscussionState) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_discussions
      SET state = ${state}, updated_at = NOW()
      WHERE repository_id = ${repositoryId} AND number = ${number}
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? discussionFromRow(row) : null;
  }

  async listDiscussionReplies(discussionId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_discussion_replies
      WHERE discussion_id = ${discussionId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) => discussionReplyFromRow(row as Record<string, unknown>));
  }

  async createDiscussionReply(input: Omit<StoredKoshDiscussionReply, "id" | "createdAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_discussion_replies(id, discussion_id, author_user_id, author_name, body)
      VALUES (${randomUUID()}, ${input.discussionId}, ${input.authorUserId}, ${input.authorName}, ${input.body})
      RETURNING *
    `;
    return discussionReplyFromRow(rows[0] as Record<string, unknown>);
  }

  async listBoards(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_project_boards
      WHERE repository_id = ${repositoryId}
      ORDER BY created_at ASC
    `;
    return rows.map((row) => boardFromRow(row as Record<string, unknown>));
  }

  async createBoard(input: Omit<StoredKoshBoard, "id" | "createdAt" | "updatedAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_project_boards(id, repository_id, name, description)
      VALUES (${randomUUID()}, ${input.repositoryId}, ${input.name}, ${input.description})
      RETURNING *
    `;
    return boardFromRow(rows[0] as Record<string, unknown>);
  }

  async listBoardCards(boardId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT c.*, i.number AS issue_number, i.title AS issue_title, i.state AS issue_state
      FROM kosh_project_cards c
      JOIN kosh_issues i ON i.id = c.issue_id
      WHERE c.board_id = ${boardId}
      ORDER BY c.column_key ASC, c.position ASC, i.number ASC
    `;
    return rows.map((row) => boardCardFromRow(row as Record<string, unknown>));
  }

  async putBoardCard(input: { boardId: string; issueId: string; column: KoshBoardColumn; position: number }) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_project_cards(id, board_id, issue_id, column_key, position)
      VALUES (${randomUUID()}, ${input.boardId}, ${input.issueId}, ${input.column}, ${input.position})
      ON CONFLICT(board_id, issue_id)
      DO UPDATE SET column_key = EXCLUDED.column_key, position = EXCLUDED.position, updated_at = NOW()
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    const issueRows = await this.sql`
      SELECT number, title, state FROM kosh_issues WHERE id = ${input.issueId} LIMIT 1
    `;
    if (!issueRows[0]) throw Object.assign(new Error("issue_not_found"), { status: 404 });
    return boardCardFromRow({
      ...row,
      issue_number: issueRows[0].number,
      issue_title: issueRows[0].title,
      issue_state: issueRows[0].state
    });
  }

  async deleteBoardCard(boardId: string, issueId: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM kosh_project_cards
      WHERE board_id = ${boardId} AND issue_id = ${issueId}
      RETURNING id
    `;
    return rows.length > 0;
  }

  async listTemplates(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_issue_templates
      WHERE repository_id = ${repositoryId}
      ORDER BY name ASC
    `;
    return rows.map((row) => templateFromRow(row as Record<string, unknown>));
  }

  async createTemplate(input: Omit<StoredKoshIssueTemplate, "id" | "createdAt" | "updatedAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_issue_templates(
        id, repository_id, name, title_template, body_template, label_names
      )
      VALUES (
        ${randomUUID()}, ${input.repositoryId}, ${input.name},
        ${input.titleTemplate}, ${input.bodyTemplate},
        ${this.sql.json(input.labelNames)}
      )
      RETURNING *
    `;
    return templateFromRow(rows[0] as Record<string, unknown>);
  }

  async createActivity(input: Omit<StoredKoshActivity, "id" | "createdAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_activity_events(
        id, repository_id, entity_type, entity_id, entity_number,
        event_type, actor_user_id, actor_name, payload
      )
      VALUES (
        ${randomUUID()}, ${input.repositoryId}, ${input.entityType},
        ${input.entityId}, ${input.entityNumber}, ${input.eventType},
        ${input.actorUserId}, ${input.actorName}, ${this.sql.json(input.payload)}
      )
      RETURNING *
    `;
    return activityFromRow(rows[0] as Record<string, unknown>);
  }

  async listActivity(repositoryId: string, limit = 100) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_activity_events
      WHERE repository_id = ${repositoryId}
      ORDER BY created_at DESC
      LIMIT ${Math.max(1, Math.min(500, limit))}
    `;
    return rows.map((row) => activityFromRow(row as Record<string, unknown>));
  }

  async createNotification(input: Omit<StoredKoshNotification, "id" | "readAt" | "createdAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_notifications(id, user_id, repository_id, title, body, href)
      VALUES (${randomUUID()}, ${input.userId}, ${input.repositoryId}, ${input.title}, ${input.body}, ${input.href})
      RETURNING *
    `;
    return notificationFromRow(rows[0] as Record<string, unknown>);
  }

  async listNotifications(userId: string, repositoryId?: string) {
    await this.ready();
    const rows = repositoryId
      ? await this.sql`
          SELECT * FROM kosh_notifications
          WHERE user_id = ${userId} AND repository_id = ${repositoryId}
          ORDER BY created_at DESC
          LIMIT 200
        `
      : await this.sql`
          SELECT * FROM kosh_notifications
          WHERE user_id = ${userId}
          ORDER BY created_at DESC
          LIMIT 200
        `;
    return rows.map((row) => notificationFromRow(row as Record<string, unknown>));
  }

  async markNotificationRead(id: string, userId: string) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_notifications
      SET read_at = COALESCE(read_at, NOW())
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    `;
    return rows.length > 0;
  }
}

let singleton: KoshWorkStore | null = null;

export function getKoshWorkStore(): KoshWorkStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshWorkStore(postgres(databaseUrl, { max: 5, prepare: false }))
    : new MemoryKoshWorkStore();
  return singleton;
}
