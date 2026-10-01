import { randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type {
  ChatAttachment,
  ChatConversation,
  ChatConversationKind,
  ChatEvent,
  ChatEventType,
  ChatMember,
  ChatMemberRole,
  ChatMessage,
  ChatNotification,
  ChatNotificationKind,
  ChatPresence,
  ChatReactionSummary,
  ChatSearchResult,
  ChatTypingState
} from "@tamishra/chat-core";

type StoredReaction = {
  messageId: string;
  userId: string;
  emoji: string;
  createdAt: string;
};

type NewConversationInput = {
  organizationId: string;
  kind: ChatConversationKind;
  name: string;
  topic: string;
  createdBy: string;
  memberIds: string[];
};

type NewMessageInput = {
  conversationId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;
  parentMessageId: string | null;
  mentions: string[];
  attachments: ChatAttachment[];
};

export type StoredChatFile = {
  id: string;
  organizationId: string;
  conversationId: string;
  uploaderId: string;
  name: string;
  mimeType: string;
  size: number;
  bytes: Buffer;
  createdAt: string;
};

type AppendEventInput = {
  organizationId: string;
  conversationId?: string | null;
  actorId?: string | null;
  targetUserId?: string | null;
  type: ChatEventType;
  payload?: Record<string, unknown>;
};

type CreateNotificationInput = {
  organizationId: string;
  userId: string;
  conversationId: string;
  messageId: string;
  kind: ChatNotificationKind;
  title: string;
  bodyPreview: string;
};

export interface ChatStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  listConversations(organizationId: string, userId: string): Promise<ChatConversation[]>;
  getConversationForUser(conversationId: string, userId: string): Promise<ChatConversation | null>;
  createConversation(input: NewConversationInput): Promise<ChatConversation>;
  listMembers(conversationId: string): Promise<ChatMember[]>;
  addMember(conversationId: string, userId: string, role: ChatMemberRole): Promise<ChatMember>;
  removeMember(conversationId: string, userId: string): Promise<boolean>;
  listMessages(
    conversationId: string,
    userId: string,
    options?: { before?: string | null; limit?: number }
  ): Promise<ChatMessage[]>;
  getMessageForUser(messageId: string, userId: string): Promise<ChatMessage | null>;
  createMessage(input: NewMessageInput): Promise<ChatMessage>;
  updateMessage(messageId: string, userId: string, body: string): Promise<ChatMessage | null>;
  deleteMessage(messageId: string, userId: string, allowModeration: boolean): Promise<boolean>;
  setRead(conversationId: string, userId: string, messageId?: string | null): Promise<ChatMember | null>;
  addReaction(messageId: string, userId: string, emoji: string): Promise<boolean>;
  removeReaction(messageId: string, userId: string, emoji: string): Promise<boolean>;
  updateMemberSettings(
    conversationId: string,
    userId: string,
    settings: { muted?: boolean; pinned?: boolean }
  ): Promise<ChatMember | null>;
  createFile(input: {
    organizationId: string;
    conversationId: string;
    uploaderId: string;
    name: string;
    mimeType: string;
    bytes: Buffer;
  }): Promise<ChatAttachment>;
  validateFiles(conversationId: string, fileIds: string[]): Promise<boolean>;
  getFileForUser(fileId: string, userId: string): Promise<StoredChatFile | null>;
  appendEvent(input: AppendEventInput): Promise<ChatEvent>;
  listEvents(
    organizationId: string,
    userId: string,
    afterId: string,
    limit?: number
  ): Promise<ChatEvent[]>;
  createNotification(input: CreateNotificationInput): Promise<ChatNotification>;
  listNotifications(
    organizationId: string,
    userId: string,
    limit?: number
  ): Promise<ChatNotification[]>;
  markNotificationRead(notificationId: string, userId: string): Promise<boolean>;
  markAllNotificationsRead(organizationId: string, userId: string): Promise<number>;
  heartbeatPresence(
    organizationId: string,
    userId: string,
    displayName: string
  ): Promise<ChatPresence>;
  listPresence(organizationId: string): Promise<ChatPresence[]>;
  setTyping(
    conversationId: string,
    userId: string,
    displayName: string,
    active: boolean
  ): Promise<ChatTypingState | null>;
  listTyping(conversationId: string): Promise<ChatTypingState[]>;
  searchMessages(organizationId: string, userId: string, query: string): Promise<ChatSearchResult[]>;
}

function nowIso() {
  return new Date().toISOString();
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function presenceStatus(lastSeenAt: string): ChatPresence["status"] {
  const age = Date.now() - Date.parse(lastSeenAt);
  if (age <= 60_000) return "online";
  if (age <= 5 * 60_000) return "away";
  return "offline";
}

function normalizeJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function summarizeReactions(
  messageId: string,
  userId: string,
  reactions: StoredReaction[]
): ChatReactionSummary[] {
  const counts = new Map<string, { count: number; reactedByMe: boolean }>();
  for (const reaction of reactions) {
    if (reaction.messageId !== messageId) continue;
    const current = counts.get(reaction.emoji) ?? { count: 0, reactedByMe: false };
    current.count += 1;
    if (reaction.userId === userId) current.reactedByMe = true;
    counts.set(reaction.emoji, current);
  }
  return Array.from(counts.entries())
    .map(([emoji, summary]) => ({ emoji, ...summary }))
    .sort((left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji));
}

function toConversation(row: Record<string, unknown>): ChatConversation {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    kind: String(row.kind) as ChatConversationKind,
    name: String(row.name ?? ""),
    topic: String(row.topic ?? ""),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at) ?? nowIso(),
    updatedAt: iso(row.updated_at) ?? nowIso(),
    memberCount: Number(row.member_count ?? 0),
    unreadCount: Number(row.unread_count ?? 0),
    muted: Boolean(row.muted),
    pinned: Boolean(row.pinned),
    lastReadAt: iso(row.last_read_at)
  };
}

function toMember(row: Record<string, unknown>): ChatMember {
  return {
    conversationId: String(row.conversation_id),
    userId: String(row.user_id),
    role: String(row.role) as ChatMemberRole,
    joinedAt: iso(row.joined_at) ?? nowIso(),
    muted: Boolean(row.muted),
    pinned: Boolean(row.pinned),
    lastReadMessageId: row.last_read_message_id ? String(row.last_read_message_id) : null,
    lastReadAt: iso(row.last_read_at)
  };
}

function toMessage(
  row: Record<string, unknown>,
  reactions: ChatReactionSummary[] = []
): ChatMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    authorId: String(row.author_id),
    authorDisplayName: String(row.author_display_name ?? "Workspace member"),
    body: String(row.body ?? ""),
    parentMessageId: row.parent_message_id ? String(row.parent_message_id) : null,
    mentions: normalizeJsonArray<string>(row.mentions),
    attachments: normalizeJsonArray<ChatAttachment>(row.attachments),
    reactions,
    createdAt: iso(row.created_at) ?? nowIso(),
    editedAt: iso(row.edited_at),
    deletedAt: iso(row.deleted_at)
  };
}

function toEvent(row: Record<string, unknown>): ChatEvent {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    conversationId: row.conversation_id ? String(row.conversation_id) : null,
    actorId: row.actor_id ? String(row.actor_id) : null,
    targetUserId: row.target_user_id ? String(row.target_user_id) : null,
    type: String(row.type) as ChatEventType,
    payload: normalizeJsonObject(row.payload),
    createdAt: iso(row.created_at) ?? nowIso()
  };
}

function toNotification(row: Record<string, unknown>): ChatNotification {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    userId: String(row.user_id),
    conversationId: String(row.conversation_id),
    messageId: String(row.message_id),
    kind: String(row.kind) as ChatNotificationKind,
    title: String(row.title ?? ""),
    bodyPreview: String(row.body_preview ?? ""),
    createdAt: iso(row.created_at) ?? nowIso(),
    readAt: iso(row.read_at)
  };
}

function toPresence(row: Record<string, unknown>): ChatPresence {
  const lastSeenAt = iso(row.last_seen_at) ?? nowIso();
  return {
    organizationId: String(row.organization_id),
    userId: String(row.user_id),
    displayName: String(row.display_name ?? "Workspace member"),
    status: presenceStatus(lastSeenAt),
    lastSeenAt
  };
}

function toTyping(row: Record<string, unknown>): ChatTypingState {
  return {
    conversationId: String(row.conversation_id),
    userId: String(row.user_id),
    displayName: String(row.display_name ?? "Workspace member"),
    expiresAt: iso(row.expires_at) ?? nowIso()
  };
}

class MemoryChatStore implements ChatStore {
  readonly kind = "ephemeral-memory" as const;
  private readonly conversations = new Map<string, ChatConversation>();
  private readonly members = new Map<string, ChatMember>();
  private readonly messages = new Map<string, ChatMessage>();
  private readonly reactions = new Map<string, StoredReaction>();

  async ready() {}

  private memberKey(conversationId: string, userId: string) {
    return conversationId + ":" + userId;
  }

  private reactionKey(messageId: string, userId: string, emoji: string) {
    return messageId + ":" + userId + ":" + emoji;
  }

  private withUnread(conversation: ChatConversation, userId: string) {
    const member = this.members.get(this.memberKey(conversation.id, userId));
    if (!member) return null;
    const lastRead = member.lastReadAt ? Date.parse(member.lastReadAt) : 0;
    const unreadCount = Array.from(this.messages.values()).filter(
      (message) =>
        message.conversationId === conversation.id &&
        !message.deletedAt &&
        message.authorId !== userId &&
        Date.parse(message.createdAt) > lastRead
    ).length;
    const memberCount = Array.from(this.members.values()).filter(
      (item) => item.conversationId === conversation.id
    ).length;
    return {
      ...conversation,
      memberCount,
      unreadCount,
      muted: member.muted,
      lastReadAt: member.lastReadAt
    };
  }

  async listConversations(organizationId: string, userId: string) {
    return Array.from(this.conversations.values())
      .filter((conversation) => conversation.organizationId === organizationId)
      .map((conversation) => this.withUnread(conversation, userId))
      .filter((conversation): conversation is ChatConversation => Boolean(conversation))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(clone);
  }

  async getConversationForUser(conversationId: string, userId: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return null;
    const hydrated = this.withUnread(conversation, userId);
    return hydrated ? clone(hydrated) : null;
  }

  async createConversation(input: NewConversationInput) {
    const createdAt = nowIso();
    const id = randomUUID();
    const conversation: ChatConversation = {
      id,
      organizationId: input.organizationId,
      kind: input.kind,
      name: input.name,
      topic: input.topic,
      createdBy: input.createdBy,
      createdAt,
      updatedAt: createdAt,
      memberCount: 0,
      unreadCount: 0,
      muted: false,
      lastReadAt: createdAt
    };
    this.conversations.set(id, conversation);
    const memberIds = Array.from(new Set([input.createdBy, ...input.memberIds]));
    for (const userId of memberIds) {
      const role: ChatMemberRole = userId === input.createdBy ? "owner" : "member";
      this.members.set(this.memberKey(id, userId), {
        conversationId: id,
        userId,
        role,
        joinedAt: createdAt,
        muted: false,
        lastReadMessageId: null,
        lastReadAt: createdAt
      });
    }
    return clone((await this.getConversationForUser(id, input.createdBy))!);
  }

  async listMembers(conversationId: string) {
    return Array.from(this.members.values())
      .filter((member) => member.conversationId === conversationId)
      .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt))
      .map(clone);
  }

  async addMember(conversationId: string, userId: string, role: ChatMemberRole) {
    const key = this.memberKey(conversationId, userId);
    const existing = this.members.get(key);
    if (existing) {
      existing.role = role;
      return clone(existing);
    }
    const member: ChatMember = {
      conversationId,
      userId,
      role,
      joinedAt: nowIso(),
      muted: false,
      lastReadMessageId: null,
      lastReadAt: null
    };
    this.members.set(key, member);
    return clone(member);
  }

  async removeMember(conversationId: string, userId: string) {
    return this.members.delete(this.memberKey(conversationId, userId));
  }

  async listMessages(
    conversationId: string,
    userId: string,
    options: { before?: string | null; limit?: number } = {}
  ) {
    if (!this.members.has(this.memberKey(conversationId, userId))) return [];
    const limit = Math.max(1, Math.min(100, options.limit ?? 50));
    const beforeMessage = options.before ? this.messages.get(options.before) : null;
    const beforeTime = beforeMessage ? Date.parse(beforeMessage.createdAt) : Number.POSITIVE_INFINITY;
    const reactions = Array.from(this.reactions.values());
    return Array.from(this.messages.values())
      .filter(
        (message) =>
          message.conversationId === conversationId &&
          Date.parse(message.createdAt) < beforeTime
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .reverse()
      .map((message) => ({
        ...clone(message),
        reactions: summarizeReactions(message.id, userId, reactions)
      }));
  }

  async getMessageForUser(messageId: string, userId: string) {
    const message = this.messages.get(messageId);
    if (!message || !this.members.has(this.memberKey(message.conversationId, userId))) {
      return null;
    }
    const reactions = summarizeReactions(
      message.id,
      userId,
      Array.from(this.reactions.values())
    );
    return { ...clone(message), reactions };
  }

  async createMessage(input: NewMessageInput) {
    if (input.parentMessageId) {
      const parent = this.messages.get(input.parentMessageId);
      if (!parent || parent.conversationId !== input.conversationId || parent.deletedAt) {
        throw Object.assign(new Error("invalid_thread_parent"), { status: 400 });
      }
    }
    const createdAt = nowIso();
    const message: ChatMessage = {
      id: randomUUID(),
      conversationId: input.conversationId,
      authorId: input.authorId,
      authorDisplayName: input.authorDisplayName,
      body: input.body,
      parentMessageId: input.parentMessageId,
      mentions: clone(input.mentions),
      attachments: clone(input.attachments),
      reactions: [],
      createdAt,
      editedAt: null,
      deletedAt: null
    };
    this.messages.set(message.id, message);
    const conversation = this.conversations.get(input.conversationId);
    if (conversation) conversation.updatedAt = createdAt;
    await this.setRead(input.conversationId, input.authorId, message.id);
    return clone(message);
  }

  async updateMessage(messageId: string, userId: string, body: string) {
    const message = this.messages.get(messageId);
    if (
      !message ||
      message.authorId !== userId ||
      message.deletedAt ||
      !this.members.has(this.memberKey(message.conversationId, userId))
    ) return null;
    message.body = body;
    message.editedAt = nowIso();
    return clone(message);
  }

  async deleteMessage(messageId: string, userId: string, allowModeration: boolean) {
    const message = this.messages.get(messageId);
    if (!message || message.deletedAt) return false;
    if (message.authorId !== userId && !allowModeration) return false;
    message.body = "";
    message.attachments = [];
    message.mentions = [];
    message.deletedAt = nowIso();
    message.editedAt = message.deletedAt;
    return true;
  }

  async setRead(conversationId: string, userId: string, messageId?: string | null) {
    const member = this.members.get(this.memberKey(conversationId, userId));
    if (!member) return null;
    member.lastReadMessageId = messageId ?? member.lastReadMessageId;
    member.lastReadAt = nowIso();
    return clone(member);
  }

  async addReaction(messageId: string, userId: string, emoji: string) {
    const message = this.messages.get(messageId);
    if (!message || message.deletedAt) return false;
    const key = this.reactionKey(messageId, userId, emoji);
    if (!this.reactions.has(key)) {
      this.reactions.set(key, { messageId, userId, emoji, createdAt: nowIso() });
    }
    return true;
  }

  async removeReaction(messageId: string, userId: string, emoji: string) {
    return this.reactions.delete(this.reactionKey(messageId, userId, emoji));
  }

  async searchMessages(organizationId: string, userId: string, query: string) {
    const needle = query.toLowerCase();
    const accessible = new Map(
      (await this.listConversations(organizationId, userId)).map((conversation) => [
        conversation.id,
        conversation
      ])
    );
    const reactions = Array.from(this.reactions.values());
    return Array.from(this.messages.values())
      .filter(
        (message) =>
          accessible.has(message.conversationId) &&
          !message.deletedAt &&
          message.body.toLowerCase().includes(needle)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 50)
      .map((message) => {
        const conversation = accessible.get(message.conversationId)!;
        return {
          conversation: {
            id: conversation.id,
            kind: conversation.kind,
            name: conversation.name
          },
          message: {
            ...clone(message),
            reactions: summarizeReactions(message.id, userId, reactions)
          }
        };
      });
  }
}

class PostgresChatStore implements ChatStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: NeonQueryFunction<false, false>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`
      CREATE TABLE IF NOT EXISTS workspace_chat_conversations (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('channel', 'group', 'direct')),
        name TEXT NOT NULL DEFAULT '',
        topic TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS workspace_chat_conversations_org_idx
      ON workspace_chat_conversations (organization_id, updated_at DESC)
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS workspace_chat_members (
        conversation_id TEXT NOT NULL REFERENCES workspace_chat_conversations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        muted BOOLEAN NOT NULL DEFAULT FALSE,
        last_read_message_id TEXT,
        last_read_at TIMESTAMPTZ,
        PRIMARY KEY (conversation_id, user_id)
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS workspace_chat_members_user_idx
      ON workspace_chat_members (user_id, conversation_id)
    `;
    await this.sql`
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
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS workspace_chat_messages_conversation_idx
      ON workspace_chat_messages (conversation_id, created_at DESC)
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS workspace_chat_messages_thread_idx
      ON workspace_chat_messages (parent_message_id, created_at ASC)
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS workspace_chat_reactions (
        message_id TEXT NOT NULL REFERENCES workspace_chat_messages(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (message_id, user_id, emoji)
      )
    `;
    this.initialized = true;
  }

  private async reactionRows(conversationId: string) {
    const rows = await this.sql`
      SELECT r.message_id, r.user_id, r.emoji, r.created_at
      FROM workspace_chat_reactions r
      JOIN workspace_chat_messages m ON m.id = r.message_id
      WHERE m.conversation_id = ${conversationId}
    `;
    return rows.map((row) => ({
      messageId: String((row as Record<string, unknown>).message_id),
      userId: String((row as Record<string, unknown>).user_id),
      emoji: String((row as Record<string, unknown>).emoji),
      createdAt: iso((row as Record<string, unknown>).created_at) ?? nowIso()
    } satisfies StoredReaction));
  }

  async listConversations(organizationId: string, userId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT
        c.id,
        c.organization_id,
        c.kind,
        c.name,
        c.topic,
        c.created_by,
        c.created_at,
        c.updated_at,
        cm.muted,
        cm.last_read_at,
        (SELECT COUNT(*) FROM workspace_chat_members x WHERE x.conversation_id = c.id) AS member_count,
        (
          SELECT COUNT(*)
          FROM workspace_chat_messages m
          WHERE m.conversation_id = c.id
            AND m.deleted_at IS NULL
            AND m.author_id <> ${userId}
            AND m.created_at > COALESCE(cm.last_read_at, to_timestamp(0))
        ) AS unread_count
      FROM workspace_chat_conversations c
      JOIN workspace_chat_members cm
        ON cm.conversation_id = c.id
       AND cm.user_id = ${userId}
      WHERE c.organization_id = ${organizationId}
      ORDER BY c.updated_at DESC
    `;
    return rows.map((row) => toConversation(row as Record<string, unknown>));
  }

  async getConversationForUser(conversationId: string, userId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT
        c.id,
        c.organization_id,
        c.kind,
        c.name,
        c.topic,
        c.created_by,
        c.created_at,
        c.updated_at,
        cm.muted,
        cm.last_read_at,
        (SELECT COUNT(*) FROM workspace_chat_members x WHERE x.conversation_id = c.id) AS member_count,
        (
          SELECT COUNT(*)
          FROM workspace_chat_messages m
          WHERE m.conversation_id = c.id
            AND m.deleted_at IS NULL
            AND m.author_id <> ${userId}
            AND m.created_at > COALESCE(cm.last_read_at, to_timestamp(0))
        ) AS unread_count
      FROM workspace_chat_conversations c
      JOIN workspace_chat_members cm
        ON cm.conversation_id = c.id
       AND cm.user_id = ${userId}
      WHERE c.id = ${conversationId}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toConversation(row) : null;
  }

  async createConversation(input: NewConversationInput) {
    await this.ready();
    const id = randomUUID();
    await this.sql`
      INSERT INTO workspace_chat_conversations (
        id, organization_id, kind, name, topic, created_by
      )
      VALUES (
        ${id},
        ${input.organizationId},
        ${input.kind},
        ${input.name},
        ${input.topic},
        ${input.createdBy}
      )
    `;

    for (const userId of Array.from(new Set([input.createdBy, ...input.memberIds]))) {
      const role: ChatMemberRole = userId === input.createdBy ? "owner" : "member";
      await this.sql`
        INSERT INTO workspace_chat_members (
          conversation_id, user_id, role, last_read_at
        )
        VALUES (${id}, ${userId}, ${role}, NOW())
        ON CONFLICT (conversation_id, user_id)
        DO UPDATE SET role = EXCLUDED.role
      `;
    }

    return (await this.getConversationForUser(id, input.createdBy))!;
  }

  async listMembers(conversationId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT conversation_id, user_id, role, joined_at, muted, last_read_message_id, last_read_at
      FROM workspace_chat_members
      WHERE conversation_id = ${conversationId}
      ORDER BY joined_at ASC
    `;
    return rows.map((row) => toMember(row as Record<string, unknown>));
  }

  async addMember(conversationId: string, userId: string, role: ChatMemberRole) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO workspace_chat_members (conversation_id, user_id, role)
      VALUES (${conversationId}, ${userId}, ${role})
      ON CONFLICT (conversation_id, user_id)
      DO UPDATE SET role = EXCLUDED.role
      RETURNING conversation_id, user_id, role, joined_at, muted, last_read_message_id, last_read_at
    `;
    return toMember(rows[0] as Record<string, unknown>);
  }

  async removeMember(conversationId: string, userId: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM workspace_chat_members
      WHERE conversation_id = ${conversationId}
        AND user_id = ${userId}
      RETURNING user_id
    `;
    return rows.length > 0;
  }

  async listMessages(
    conversationId: string,
    userId: string,
    options: { before?: string | null; limit?: number } = {}
  ) {
    await this.ready();
    if (!(await this.getConversationForUser(conversationId, userId))) return [];

    const limit = Math.max(1, Math.min(100, options.limit ?? 50));
    let rows;
    if (options.before) {
      const anchorRows = await this.sql`
        SELECT created_at
        FROM workspace_chat_messages
        WHERE id = ${options.before}
          AND conversation_id = ${conversationId}
        LIMIT 1
      `;
      const anchor = anchorRows[0] as Record<string, unknown> | undefined;
      if (!anchor) return [];
      rows = await this.sql`
        SELECT *
        FROM workspace_chat_messages
        WHERE conversation_id = ${conversationId}
          AND created_at < ${String(anchor.created_at)}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } else {
      rows = await this.sql`
        SELECT *
        FROM workspace_chat_messages
        WHERE conversation_id = ${conversationId}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }

    const reactions = await this.reactionRows(conversationId);
    return rows
      .map((row) => {
        const base = toMessage(row as Record<string, unknown>);
        return { ...base, reactions: summarizeReactions(base.id, userId, reactions) };
      })
      .reverse();
  }

  async getMessageForUser(messageId: string, userId: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT m.*
      FROM workspace_chat_messages m
      JOIN workspace_chat_members cm
        ON cm.conversation_id = m.conversation_id
       AND cm.user_id = ${userId}
      WHERE m.id = ${messageId}
      LIMIT 1
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const base = toMessage(row);
    const reactions = await this.reactionRows(base.conversationId);
    return { ...base, reactions: summarizeReactions(base.id, userId, reactions) };
  }

  async createMessage(input: NewMessageInput) {
    await this.ready();
    if (input.parentMessageId) {
      const parentRows = await this.sql`
        SELECT id
        FROM workspace_chat_messages
        WHERE id = ${input.parentMessageId}
          AND conversation_id = ${input.conversationId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!parentRows.length) {
        throw Object.assign(new Error("invalid_thread_parent"), { status: 400 });
      }
    }
    const id = randomUUID();
    const rows = await this.sql`
      INSERT INTO workspace_chat_messages (
        id,
        conversation_id,
        author_id,
        author_display_name,
        body,
        parent_message_id,
        mentions,
        attachments
      )
      VALUES (
        ${id},
        ${input.conversationId},
        ${input.authorId},
        ${input.authorDisplayName},
        ${input.body},
        ${input.parentMessageId},
        ${JSON.stringify(input.mentions)}::jsonb,
        ${JSON.stringify(input.attachments)}::jsonb
      )
      RETURNING *
    `;
    await this.sql`
      UPDATE workspace_chat_conversations
      SET updated_at = NOW()
      WHERE id = ${input.conversationId}
    `;
    await this.setRead(input.conversationId, input.authorId, id);
    return toMessage(rows[0] as Record<string, unknown>);
  }

  async updateMessage(messageId: string, userId: string, body: string) {
    await this.ready();
    const rows = await this.sql`
      UPDATE workspace_chat_messages
      SET body = ${body}, edited_at = NOW()
      WHERE id = ${messageId}
        AND author_id = ${userId}
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1
          FROM workspace_chat_members cm
          WHERE cm.conversation_id = workspace_chat_messages.conversation_id
            AND cm.user_id = ${userId}
        )
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toMessage(row) : null;
  }

  async deleteMessage(messageId: string, userId: string, allowModeration: boolean) {
    await this.ready();
    const rows = allowModeration
      ? await this.sql`
          UPDATE workspace_chat_messages
          SET body = '', attachments = '[]'::jsonb, mentions = '[]'::jsonb,
              deleted_at = NOW(), edited_at = NOW()
          WHERE id = ${messageId}
            AND deleted_at IS NULL
          RETURNING id
        `
      : await this.sql`
          UPDATE workspace_chat_messages
          SET body = '', attachments = '[]'::jsonb, mentions = '[]'::jsonb,
              deleted_at = NOW(), edited_at = NOW()
          WHERE id = ${messageId}
            AND author_id = ${userId}
            AND deleted_at IS NULL
          RETURNING id
        `;
    return rows.length > 0;
  }

  async setRead(conversationId: string, userId: string, messageId?: string | null) {
    await this.ready();
    const rows = await this.sql`
      UPDATE workspace_chat_members
      SET
        last_read_message_id = COALESCE(${messageId ?? null}, last_read_message_id),
        last_read_at = NOW()
      WHERE conversation_id = ${conversationId}
        AND user_id = ${userId}
      RETURNING conversation_id, user_id, role, joined_at, muted, last_read_message_id, last_read_at
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? toMember(row) : null;
  }

  async addReaction(messageId: string, userId: string, emoji: string) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO workspace_chat_reactions (message_id, user_id, emoji)
      SELECT ${messageId}, ${userId}, ${emoji}
      WHERE EXISTS (
        SELECT 1
        FROM workspace_chat_messages m
        JOIN workspace_chat_members cm ON cm.conversation_id = m.conversation_id
        WHERE m.id = ${messageId}
          AND cm.user_id = ${userId}
          AND m.deleted_at IS NULL
      )
      ON CONFLICT (message_id, user_id, emoji) DO NOTHING
      RETURNING message_id
    `;
    return rows.length > 0;
  }

  async removeReaction(messageId: string, userId: string, emoji: string) {
    await this.ready();
    const rows = await this.sql`
      DELETE FROM workspace_chat_reactions
      WHERE message_id = ${messageId}
        AND user_id = ${userId}
        AND emoji = ${emoji}
      RETURNING message_id
    `;
    return rows.length > 0;
  }

  async searchMessages(organizationId: string, userId: string, query: string) {
    await this.ready();
    const pattern = "%" + query + "%";
    const rows = await this.sql`
      SELECT
        m.*,
        c.id AS search_conversation_id,
        c.kind AS search_conversation_kind,
        c.name AS search_conversation_name
      FROM workspace_chat_messages m
      JOIN workspace_chat_conversations c ON c.id = m.conversation_id
      JOIN workspace_chat_members cm
        ON cm.conversation_id = c.id
       AND cm.user_id = ${userId}
      WHERE c.organization_id = ${organizationId}
        AND m.deleted_at IS NULL
        AND m.body ILIKE ${pattern}
      ORDER BY m.created_at DESC
      LIMIT 50
    `;
    return rows.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        conversation: {
          id: String(record.search_conversation_id),
          kind: String(record.search_conversation_kind) as ChatConversationKind,
          name: String(record.search_conversation_name ?? "")
        },
        message: toMessage(record)
      };
    });
  }
}

export function createChatStore(): ChatStore {
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!databaseUrl) return new MemoryChatStore();
  return new PostgresChatStore(neon(databaseUrl));
}
