export type ChatConversationKind = "channel" | "group" | "direct";

export type ChatMemberRole = "owner" | "moderator" | "member";

export type ChatNotificationKind = "mention" | "direct" | "thread";

export type ChatEventType =
  | "conversation.created"
  | "member.changed"
  | "message.created"
  | "message.updated"
  | "message.deleted"
  | "reaction.changed"
  | "read.changed"
  | "settings.changed"
  | "typing.changed"
  | "presence.changed"
  | "notification.created";

export type ChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  fileId?: string;
  url?: string;
};

export type ChatReactionSummary = {
  emoji: string;
  count: number;
  reactedByMe: boolean;
};

export type ChatConversation = {
  id: string;
  organizationId: string;
  kind: ChatConversationKind;
  name: string;
  topic: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  unreadCount: number;
  muted: boolean;
  pinned: boolean;
  lastReadAt: string | null;
};

export type ChatMember = {
  conversationId: string;
  userId: string;
  role: ChatMemberRole;
  joinedAt: string;
  muted: boolean;
  pinned: boolean;
  lastReadMessageId: string | null;
  lastReadAt: string | null;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;
  parentMessageId: string | null;
  mentions: string[];
  attachments: ChatAttachment[];
  reactions: ChatReactionSummary[];
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
};

export type ChatEvent = {
  id: string;
  organizationId: string;
  conversationId: string | null;
  actorId: string | null;
  targetUserId: string | null;
  type: ChatEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ChatNotification = {
  id: string;
  organizationId: string;
  userId: string;
  conversationId: string;
  messageId: string;
  kind: ChatNotificationKind;
  title: string;
  bodyPreview: string;
  createdAt: string;
  readAt: string | null;
};

export type ChatTypingState = {
  conversationId: string;
  userId: string;
  displayName: string;
  expiresAt: string;
};

export type ChatPresence = {
  organizationId: string;
  userId: string;
  displayName: string;
  status: "online" | "away" | "offline";
  lastSeenAt: string;
};

export type ChatSearchResult = {
  conversation: Pick<ChatConversation, "id" | "kind" | "name">;
  message: ChatMessage;
};

export type ChatConversationCreateInput = {
  organizationId: string;
  kind: ChatConversationKind;
  name?: string;
  topic?: string;
  memberIds?: string[];
};

export type ChatMessageCreateInput = {
  body: string;
  parentMessageId?: string | null;
  mentions?: string[];
  attachments?: ChatAttachment[];
};

export function isChatConversationKind(value: unknown): value is ChatConversationKind {
  return value === "channel" || value === "group" || value === "direct";
}

export function isChatMemberRole(value: unknown): value is ChatMemberRole {
  return value === "owner" || value === "moderator" || value === "member";
}
