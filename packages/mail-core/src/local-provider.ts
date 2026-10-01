import type {
  MailAccount,
  MailDraft,
  MailFolder,
  MailMessage,
  MailPage,
  MailProvider,
  MailSearchQuery,
  MailSendResult,
  MailSyncResult
} from "./index";

const now = () => new Date().toISOString();

export class LocalMailProvider implements MailProvider {
  readonly key = "local";

  private cursor = 0;
  private messages = new Map<string, MailMessage>();
  private drafts = new Map<string, MailDraft>();

  constructor(seedMessages: MailMessage[] = []) {
    for (const message of seedMessages) {
      this.messages.set(message.id, structuredClone(message));
    }
  }

  async getAccount(): Promise<MailAccount> {
    return {
      id: "local",
      provider: this.key,
      displayName: "Local mailbox",
      primaryAddress: "local@tamishra.invalid",
      connected: true,
      capabilities: {
        folders: true,
        labels: true,
        threads: true,
        drafts: true,
        search: true,
        pushSync: false
      }
    };
  }

  async listFolders(): Promise<MailFolder[]> {
    const kinds = ["inbox", "sent", "drafts", "archive", "spam", "trash"] as const;

    return kinds.map((kind) => {
      const items = Array.from(this.messages.values()).filter((message) => message.folderId === kind);
      return {
        id: kind,
        name: kind[0].toUpperCase() + kind.slice(1),
        kind,
        totalCount: items.length,
        unreadCount: items.filter((message) => !message.read).length
      };
    });
  }

  async listMessages(query: MailSearchQuery): Promise<MailPage> {
    const text = query.text?.trim().toLowerCase();

    let messages = Array.from(this.messages.values()).filter((message) => {
      if (query.folderId && message.folderId !== query.folderId) return false;
      if (typeof query.unread === "boolean" && (!message.read) !== query.unread) return false;
      if (typeof query.starred === "boolean" && message.starred !== query.starred) return false;
      if (query.hasAttachments && message.attachments.length === 0) return false;
      if (query.from && !message.from.address.toLowerCase().includes(query.from.toLowerCase())) return false;
      if (query.to && !message.to.some((address) => address.address.toLowerCase().includes(query.to!.toLowerCase()))) return false;

      if (text) {
        const haystack = [
          message.from.name,
          message.from.address,
          ...message.to.flatMap((address) => [address.name, address.address]),
          message.subject,
          message.preview,
          message.textBody
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        if (!haystack.includes(text)) return false;
      }

      return true;
    });

    messages = messages.sort((a, b) => {
      const aTime = a.receivedAt ?? a.sentAt ?? "";
      const bTime = b.receivedAt ?? b.sentAt ?? "";
      return bTime.localeCompare(aTime);
    });

    if (query.limit) messages = messages.slice(0, query.limit);

    return { messages: structuredClone(messages) };
  }

  async getMessage(id: string): Promise<MailMessage> {
    const message = this.messages.get(id);
    if (!message) throw new Error(`Local message "${id}" was not found.`);
    return structuredClone(message);
  }

  async saveDraft(draft: MailDraft): Promise<MailDraft> {
    const id = draft.id ?? `draft-${crypto.randomUUID()}`;
    const saved = { ...structuredClone(draft), id };
    this.drafts.set(id, saved);
    this.bump();
    return structuredClone(saved);
  }

  async deleteDraft(id: string): Promise<void> {
    this.drafts.delete(id);
    this.bump();
  }

  async send(draft: MailDraft): Promise<MailSendResult> {
    const id = `local-${crypto.randomUUID()}`;
    const sentAt = now();

    this.messages.set(id, {
      id,
      threadId: draft.replyToMessageId ?? draft.forwardMessageId ?? id,
      folderId: "sent",
      from: { name: "You", address: "local@tamishra.invalid" },
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      textBody: draft.textBody,
      htmlBody: draft.htmlBody,
      preview: draft.textBody?.slice(0, 160) ?? "",
      sentAt,
      read: true,
      starred: false,
      labels: [],
      attachments: []
    });

    this.bump();
    return { messageId: id, providerId: id, sentAt };
  }

  async markRead(ids: string[], read: boolean): Promise<void> {
    this.patch(ids, (message) => ({ ...message, read }));
  }

  async setStarred(ids: string[], starred: boolean): Promise<void> {
    this.patch(ids, (message) => ({ ...message, starred }));
  }

  async move(ids: string[], folderId: string): Promise<void> {
    this.patch(ids, (message) => ({ ...message, folderId }));
  }

  async remove(ids: string[]): Promise<void> {
    for (const id of ids) this.messages.delete(id);
    this.bump();
  }

  async sync(cursor?: string): Promise<MailSyncResult> {
    const current = String(this.cursor);
    return {
      cursor: current,
      changedMessageIds: cursor === current ? [] : Array.from(this.messages.keys()),
      removedMessageIds: []
    };
  }

  private patch(ids: string[], update: (message: MailMessage) => MailMessage) {
    for (const id of ids) {
      const message = this.messages.get(id);
      if (message) this.messages.set(id, update(message));
    }

    this.bump();
  }

  private bump() {
    this.cursor += 1;
  }
}
