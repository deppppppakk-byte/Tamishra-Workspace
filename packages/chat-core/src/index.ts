export type ChatConversationKind = "channel" | "group" | "direct";

export type ChatMemberRole = "owner" | "moderator" | "member";

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
  lastReadAt: string | null;
};

export type ChatMember = {
  conversationId: string;
  userId: string;
  role: ChatMemberRole;
  joinedAt: string;
  muted: boolean;
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
