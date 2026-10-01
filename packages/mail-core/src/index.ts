export type MailFolderKind =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "spam"
  | "trash"
  | "custom";

export type MailAddress = {
  name?: string;
  address: string;
};

export type MailAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  inline?: boolean;
  contentId?: string;
};

export type MailFolder = {
  id: string;
  name: string;
  kind: MailFolderKind;
  unreadCount?: number;
  totalCount?: number;
};

export type MailMessage = {
  id: string;
  threadId?: string;
  folderId: string;
  providerId?: string;
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  replyTo?: MailAddress[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  preview: string;
  receivedAt?: string;
  sentAt?: string;
  read: boolean;
  starred: boolean;
  labels: string[];
  attachments: MailAttachment[];
  headers?: Record<string, string>;
};

export type MailDraft = {
  id?: string;
  replyToMessageId?: string;
  forwardMessageId?: string;
  to: MailAddress[];
  cc?: MailAddress[];
  bcc?: MailAddress[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  attachmentIds?: string[];
};

export type MailSearchQuery = {
  text?: string;
  folderId?: string;
  unread?: boolean;
  starred?: boolean;
  from?: string;
  to?: string;
  hasAttachments?: boolean;
  before?: string;
  after?: string;
  limit?: number;
  cursor?: string;
};

export type MailPage = {
  messages: MailMessage[];
  nextCursor?: string;
};

export type MailSyncResult = {
  cursor: string;
  changedMessageIds: string[];
  removedMessageIds: string[];
};

export type MailSendResult = {
  messageId: string;
  providerId?: string;
  sentAt: string;
};

export type MailProviderCapabilities = {
  folders: boolean;
  labels: boolean;
  threads: boolean;
  drafts: boolean;
  search: boolean;
  pushSync: boolean;
};

export type MailAccount = {
  id: string;
  provider: string;
  displayName: string;
  primaryAddress: string;
  connected: boolean;
  capabilities: MailProviderCapabilities;
};

export interface MailProvider {
  readonly key: string;

  getAccount(): Promise<MailAccount>;
  listFolders(): Promise<MailFolder[]>;
  listMessages(query: MailSearchQuery): Promise<MailPage>;
  getMessage(id: string): Promise<MailMessage>;
  saveDraft(draft: MailDraft): Promise<MailDraft>;
  deleteDraft(id: string): Promise<void>;
  send(draft: MailDraft): Promise<MailSendResult>;
  markRead(ids: string[], read: boolean): Promise<void>;
  setStarred(ids: string[], starred: boolean): Promise<void>;
  move(ids: string[], folderId: string): Promise<void>;
  remove(ids: string[]): Promise<void>;
  sync(cursor?: string): Promise<MailSyncResult>;
}

export class MailProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not-connected"
      | "authentication"
      | "rate-limited"
      | "permission"
      | "not-found"
      | "provider-unavailable"
      | "unknown",
    readonly retryable = false
  ) {
    super(message);
    this.name = "MailProviderError";
  }
}

export * from "./provider-registry";
export * from "./local-provider";
