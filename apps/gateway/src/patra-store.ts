import { randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type PatraMailboxClass = "public" | "tamishra-company";
export type PatraMailboxStatus = "active" | "suspended";
export type PatraFolderKind =
  | "inbox"
  | "sent"
  | "drafts"
  | "archive"
  | "spam"
  | "trash";
export type PatraDeliveryStatus =
  | "draft"
  | "queued"
  | "delivered-local"
  | "sent-external"
  | "failed";

export type PatraAddress = {
  name?: string;
  address: string;
};

export type StoredPatraMailbox = {
  id: string;
  userId: string;
  localPart: string;
  domain: string;
  address: string;
  mailboxClass: PatraMailboxClass;
  displayName: string;
  status: PatraMailboxStatus;
  quotaBytes: string;
  usedBytes: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredPatraFolder = {
  id: string;
  mailboxId: string;
  name: string;
  kind: PatraFolderKind;
  totalCount?: number;
  unreadCount?: number;
  createdAt: string;
};

export type StoredPatraMessage = {
  id: string;
  mailboxId: string;
  folderId: string;
  threadId: string;
  from: PatraAddress;
  to: PatraAddress[];
  cc: PatraAddress[];
  bcc: PatraAddress[];
  subject: string;
  textBody: string;
  htmlBody: string | null;
  preview: string;
  receivedAt: string | null;
  sentAt: string | null;
  read: boolean;
  starred: boolean;
  labels: string[];
  deliveryStatus: PatraDeliveryStatus;
  internetMessageId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredPatraQueueItem = {
  id: string;
  messageId: string;
  mailboxId: string;
  status: "queued" | "processing" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProvisionMailboxInput = {
  userId: string;
  localPart: string;
  domain: string;
  mailboxClass: PatraMailboxClass;
  displayName: string;
};

export type CreateMessageInput = {
  mailboxId: string;
  folderKind: PatraFolderKind;
  from: PatraAddress;
  to: PatraAddress[];
  cc?: PatraAddress[];
  bcc?: PatraAddress[];
  subject: string;
  textBody?: string;
  htmlBody?: string | null;
  read?: boolean;
  starred?: boolean;
  labels?: string[];
  deliveryStatus: PatraDeliveryStatus;
  sentAt?: string | null;
  receivedAt?: string | null;
  internetMessageId?: string | null;
  threadId?: string;
};

export interface PatraStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  isAddressAvailable(address: string): Promise<boolean>;
  provisionMailbox(input: ProvisionMailboxInput): Promise<StoredPatraMailbox>;
  getMailbox(mailboxId: string): Promise<StoredPatraMailbox | null>;
  getMailboxByAddress(address: string): Promise<StoredPatraMailbox | null>;
  listMailboxesForUser(userId: string): Promise<StoredPatraMailbox[]>;
  listFolders(mailboxId: string): Promise<StoredPatraFolder[]>;
  listMessages(
    mailboxId: string,
    folderKind: PatraFolderKind,
    options?: { search?: string; limit?: number }
  ): Promise<StoredPatraMessage[]>;
  getMessage(mailboxId: string, messageId: string): Promise<StoredPatraMessage | null>;
  createMessage(input: CreateMessageInput): Promise<StoredPatraMessage>;
  updateMessageState(
    mailboxId: string,
    messageId: string,
    patch: {
      folderKind?: PatraFolderKind;
      read?: boolean;
      starred?: boolean;
      deliveryStatus?: PatraDeliveryStatus;
      sentAt?: string | null;
    }
  ): Promise<StoredPatraMessage | null>;
  enqueueDelivery(messageId: string, mailboxId: string): Promise<StoredPatraQueueItem>;
  listQueuedDeliveries(limit?: number): Promise<StoredPatraQueueItem[]>;
}

const SYSTEM_FOLDERS: Array<{ kind: PatraFolderKind; name: string }> = [
  { kind: "inbox", name: "Inbox" },
  { kind: "sent", name: "Sent" },
  { kind: "drafts", name: "Drafts" },
  { kind: "archive", name: "Archive" },
  { kind: "spam", name: "Spam" },
  { kind: "trash", name: "Trash" }
];

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseJsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function toMailbox(row: Record<string, unknown>): StoredPatraMailbox {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    localPart: String(row.local_part),
    domain: String(row.domain),
    address: String(row.address),
    mailboxClass: String(row.mailbox_class) as PatraMailboxClass,
    displayName: String(row.display_name),
    status: String(row.status) as PatraMailboxStatus,
    quotaBytes: String(row.quota_bytes ?? "0"),
    usedBytes: String(row.used_bytes ?? "0"),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString()
  };
}

function toFolder(row: Record<string, unknown>): StoredPatraFolder {
  return {
    id: String(row.id),
    mailboxId: String(row.mailbox_id),
    name: String(row.name),
    kind: String(row.kind) as PatraFolderKind,
    totalCount:
      row.total === undefined || row.total === null ? undefined : Number(row.total),
    unreadCount:
      row.unread === undefined || row.unread === null ? undefined : Number(row.unread),
    createdAt: iso(row.created_at) ?? new Date().toISOString()
  };
}

function toMessage(row: Record<string, unknown>): StoredPatraMessage {
  return {
    id: String(row.id),
    mailboxId: String(row.mailbox_id),
    folderId: String(row.folder_id),
    threadId: String(row.thread_id),
    from: {
      name: row.from_name ? String(row.from_name) : undefined,
      address: String(row.from_address)
    },
    to: parseJsonArray<PatraAddress>(row.to_json),
    cc: parseJsonArray<PatraAddress>(row.cc_json),
    bcc: parseJsonArray<PatraAddress>(row.bcc_json),
    subject: String(row.subject ?? ""),
    textBody: String(row.text_body ?? ""),
    htmlBody: row.html_body ? String(row.html_body) : null,
    preview: String(row.preview ?? ""),
    receivedAt: iso(row.received_at),
    sentAt: iso(row.sent_at),
    read: Boolean(row.is_read),
    starred: Boolean(row.starred),
    labels: parseJsonArray<string>(row.labels_json),
    deliveryStatus: String(row.delivery_status) as PatraDeliveryStatus,
    internetMessageId: row.internet_message_id
      ? String(row.internet_message_id)
      : null,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString()
  };
}

function toQueueItem(row: Record<string, unknown>): StoredPatraQueueItem {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    mailboxId: String(row.mailbox_id),
    status: String(row.status) as StoredPatraQueueItem["status"],
    attempts: Number(row.attempts ?? 0),
    nextAttemptAt: iso(row.next_attempt_at) ?? new Date().toISOString(),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString()
  };
}

class MemoryPatraStore implements PatraStore {
  readonly kind = "ephemeral-memory" as const;
  private readonly mailboxes = new Map<string, StoredPatraMailbox>();
  private readonly folders = new Map<string, StoredPatraFolder>();
  private readonly messages = new Map<string, StoredPatraMessage>();
  private readonly queue = new Map<string, StoredPatraQueueItem>();

  async ready() {}

  async isAddressAvailable(address: string) {
    const normalized = address.trim().toLowerCase();
    return !Array.from(this.mailboxes.values()).some(
      (mailbox) => mailbox.address === normalized
    );
  }

  async provisionMailbox(input: ProvisionMailboxInput) {
    const address = (input.localPart + "@" + input.domain).toLowerCase();
    if (!(await this.isAddressAvailable(address))) {
      throw Object.assign(new Error("mailbox_address_taken"), { code: "23505" });
    }

    const now = new Date().toISOString();
    const mailbox: StoredPatraMailbox = {
      id: "mbx_" + randomUUID(),
      userId: input.userId,
      localPart: input.localPart,
      domain: input.domain,
      address,
      mailboxClass: input.mailboxClass,
      displayName: input.displayName,
      status: "active",
      quotaBytes: String(5 * 1024 * 1024 * 1024),
      usedBytes: "0",
      createdAt: now,
      updatedAt: now
    };
    this.mailboxes.set(mailbox.id, mailbox);

    for (const folder of SYSTEM_FOLDERS) {
      const stored: StoredPatraFolder = {
        id: "fld_" + randomUUID(),
        mailboxId: mailbox.id,
        name: folder.name,
        kind: folder.kind,
        createdAt: now
      };
      this.folders.set(stored.id, stored);
    }

    return structuredClone(mailbox);
  }

  async getMailbox(mailboxId: string) {
    return this.mailboxes.get(mailboxId) ?? null;
  }

  async getMailboxByAddress(address: string) {
    const normalized = address.trim().toLowerCase();
    return (
      Array.from(this.mailboxes.values()).find(
        (mailbox) => mailbox.address === normalized
      ) ?? null
    );
  }

  async listMailboxesForUser(userId: string) {
    return Array.from(this.mailboxes.values())
      .filter((mailbox) => mailbox.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((mailbox) => structuredClone(mailbox));
  }

  async listFolders(mailboxId: string) {
    const counts = new Map<PatraFolderKind, { total: number; unread: number }>();
    for (const folder of this.folders.values()) {
      if (folder.mailboxId !== mailboxId) continue;
      const items = Array.from(this.messages.values()).filter(
        (message) => message.mailboxId === mailboxId && message.folderId === folder.id
      );
      counts.set(folder.kind, {
        total: items.length,
        unread: items.filter((item) => !item.read).length
      });
    }

    return Array.from(this.folders.values())
      .filter((folder) => folder.mailboxId === mailboxId)
      .sort(
        (a, b) =>
          SYSTEM_FOLDERS.findIndex((item) => item.kind === a.kind) -
          SYSTEM_FOLDERS.findIndex((item) => item.kind === b.kind)
      )
      .map((folder) => {
        const count = counts.get(folder.kind) ?? { total: 0, unread: 0 };
        return {
          ...structuredClone(folder),
          totalCount: count.total,
          unreadCount: count.unread
        };
      });
  }

  async listMessages(
    mailboxId: string,
    folderKind: PatraFolderKind,
    options: { search?: string; limit?: number } = {}
  ) {
    const folder = Array.from(this.folders.values()).find(
      (item) => item.mailboxId === mailboxId && item.kind === folderKind
    );
    if (!folder) return [];

    const search = options.search?.trim().toLowerCase() ?? "";
    return Array.from(this.messages.values())
      .filter((message) => {
        if (message.mailboxId !== mailboxId || message.folderId !== folder.id) return false;
        if (!search) return true;
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
        return haystack.includes(search);
      })
      .sort((a, b) =>
        (b.receivedAt ?? b.sentAt ?? b.createdAt).localeCompare(
          a.receivedAt ?? a.sentAt ?? a.createdAt
        )
      )
      .slice(0, Math.max(1, Math.min(options.limit ?? 100, 200)))
      .map((message) => structuredClone(message));
  }

  async getMessage(mailboxId: string, messageId: string) {
    const message = this.messages.get(messageId);
    return message?.mailboxId === mailboxId ? structuredClone(message) : null;
  }

  async createMessage(input: CreateMessageInput) {
    const folder = Array.from(this.folders.values()).find(
      (item) =>
        item.mailboxId === input.mailboxId && item.kind === input.folderKind
    );
    if (!folder) throw new Error("mailbox_folder_not_found");

    const now = new Date().toISOString();
    const id = "msg_" + randomUUID();
    const message: StoredPatraMessage = {
      id,
      mailboxId: input.mailboxId,
      folderId: folder.id,
      threadId: input.threadId || id,
      from: structuredClone(input.from),
      to: structuredClone(input.to),
      cc: structuredClone(input.cc ?? []),
      bcc: structuredClone(input.bcc ?? []),
      subject: input.subject,
      textBody: input.textBody ?? "",
      htmlBody: input.htmlBody ?? null,
      preview: (input.textBody ?? "").replace(/\s+/g, " ").trim().slice(0, 180),
      receivedAt: input.receivedAt ?? null,
      sentAt: input.sentAt ?? null,
      read: input.read ?? false,
      starred: input.starred ?? false,
      labels: structuredClone(input.labels ?? []),
      deliveryStatus: input.deliveryStatus,
      internetMessageId: input.internetMessageId ?? null,
      createdAt: now,
      updatedAt: now
    };
    this.messages.set(id, message);
    return structuredClone(message);
  }

  async updateMessageState(
    mailboxId: string,
    messageId: string,
    patch: {
      folderKind?: PatraFolderKind;
      read?: boolean;
      starred?: boolean;
      deliveryStatus?: PatraDeliveryStatus;
      sentAt?: string | null;
    }
  ) {
    const message = this.messages.get(messageId);
    if (!message || message.mailboxId !== mailboxId) return null;

    if (patch.folderKind) {
      const folder = Array.from(this.folders.values()).find(
        (item) => item.mailboxId === mailboxId && item.kind === patch.folderKind
      );
      if (!folder) throw new Error("mailbox_folder_not_found");
      message.folderId = folder.id;
    }
    if (patch.read !== undefined) message.read = patch.read;
    if (patch.starred !== undefined) message.starred = patch.starred;
    if (patch.deliveryStatus !== undefined) {
      message.deliveryStatus = patch.deliveryStatus;
    }
    if (patch.sentAt !== undefined) message.sentAt = patch.sentAt;
    message.updatedAt = new Date().toISOString();
    return structuredClone(message);
  }

  async enqueueDelivery(messageId: string, mailboxId: string) {
    const now = new Date().toISOString();
    const item: StoredPatraQueueItem = {
      id: "q_" + randomUUID(),
      messageId,
      mailboxId,
      status: "queued",
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    this.queue.set(item.id, item);
    return structuredClone(item);
  }

  async listQueuedDeliveries(limit = 50) {
    return Array.from(this.queue.values())
      .filter(
        (item) =>
          item.status === "queued" &&
          new Date(item.nextAttemptAt).getTime() <= Date.now()
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((item) => structuredClone(item));
  }
}

class PostgresPatraStore implements PatraStore {
  readonly kind = "postgres" as const;
  private readonly sql: NeonQueryFunction<false, false>;
  private readyPromise: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon<false, false>(databaseUrl);
  }

  ready() {
    this.readyPromise ??= this.initialize();
    return this.readyPromise;
  }

  private async initialize() {
    await this.sql`
      create table if not exists patra_mailboxes (
        id text primary key,
        user_id text not null references workspace_users(id) on delete cascade,
        local_part text not null,
        domain text not null,
        address text not null unique,
        mailbox_class text not null,
        display_name text not null,
        status text not null default 'active',
        quota_bytes bigint not null default 5368709120,
        used_bytes bigint not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique(user_id, domain)
      )
    `;

    await this.sql`
      create table if not exists patra_folders (
        id text primary key,
        mailbox_id text not null references patra_mailboxes(id) on delete cascade,
        name text not null,
        kind text not null,
        created_at timestamptz not null default now(),
        unique(mailbox_id, kind)
      )
    `;

    await this.sql`
      create table if not exists patra_messages (
        id text primary key,
        mailbox_id text not null references patra_mailboxes(id) on delete cascade,
        folder_id text not null references patra_folders(id) on delete cascade,
        thread_id text not null,
        from_name text,
        from_address text not null,
        to_json jsonb not null default '[]'::jsonb,
        cc_json jsonb not null default '[]'::jsonb,
        bcc_json jsonb not null default '[]'::jsonb,
        subject text not null default '',
        text_body text not null default '',
        html_body text,
        preview text not null default '',
        received_at timestamptz,
        sent_at timestamptz,
        is_read boolean not null default false,
        starred boolean not null default false,
        labels_json jsonb not null default '[]'::jsonb,
        delivery_status text not null,
        internet_message_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create table if not exists patra_delivery_queue (
        id text primary key,
        message_id text not null references patra_messages(id) on delete cascade,
        mailbox_id text not null references patra_mailboxes(id) on delete cascade,
        status text not null default 'queued',
        attempts integer not null default 0,
        next_attempt_at timestamptz not null default now(),
        last_error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create index if not exists patra_mailboxes_user_idx
      on patra_mailboxes(user_id, created_at)
    `;
    await this.sql`
      create index if not exists patra_messages_mailbox_folder_idx
      on patra_messages(mailbox_id, folder_id, created_at desc)
    `;
    await this.sql`
      create index if not exists patra_messages_thread_idx
      on patra_messages(mailbox_id, thread_id, created_at)
    `;
    await this.sql`
      create index if not exists patra_delivery_queue_ready_idx
      on patra_delivery_queue(status, next_attempt_at, created_at)
    `;
  }

  async isAddressAvailable(address: string) {
    await this.ready();
    const normalized = address.trim().toLowerCase();
    const rows = await this.sql`
      select id from patra_mailboxes
      where address=${normalized}
      limit 1
    `;
    return !rows[0];
  }

  async provisionMailbox(input: ProvisionMailboxInput) {
    await this.ready();
    const id = "mbx_" + randomUUID();
    const address = (input.localPart + "@" + input.domain).toLowerCase();

    const rows = await this.sql`
      insert into patra_mailboxes(
        id, user_id, local_part, domain, address,
        mailbox_class, display_name, status
      ) values (
        ${id}, ${input.userId}, ${input.localPart}, ${input.domain}, ${address},
        ${input.mailboxClass}, ${input.displayName}, 'active'
      )
      returning *
    `;

    try {
      for (const folder of SYSTEM_FOLDERS) {
        await this.sql`
          insert into patra_folders(id, mailbox_id, name, kind)
          values (
            ${"fld_" + randomUUID()},
            ${id},
            ${folder.name},
            ${folder.kind}
          )
        `;
      }
    } catch (error) {
      await this.sql`delete from patra_mailboxes where id=${id}`;
      throw error;
    }

    return toMailbox(rows[0] as Record<string, unknown>);
  }

  async getMailbox(mailboxId: string) {
    await this.ready();
    const rows = await this.sql`
      select * from patra_mailboxes
      where id=${mailboxId}
      limit 1
    `;
    return rows[0] ? toMailbox(rows[0] as Record<string, unknown>) : null;
  }

  async getMailboxByAddress(address: string) {
    await this.ready();
    const normalized = address.trim().toLowerCase();
    const rows = await this.sql`
      select * from patra_mailboxes
      where address=${normalized}
      limit 1
    `;
    return rows[0] ? toMailbox(rows[0] as Record<string, unknown>) : null;
  }

  async listMailboxesForUser(userId: string) {
    await this.ready();
    const rows = await this.sql`
      select * from patra_mailboxes
      where user_id=${userId}
      order by created_at asc
    `;
    return rows.map((row) => toMailbox(row as Record<string, unknown>));
  }

  async listFolders(mailboxId: string) {
    await this.ready();
    const rows = await this.sql`
      select
        f.*,
        count(m.id)::int as total,
        count(m.id) filter (where m.is_read=false)::int as unread
      from patra_folders f
      left join patra_messages m
        on m.folder_id=f.id and m.mailbox_id=f.mailbox_id
      where f.mailbox_id=${mailboxId}
      group by f.id
      order by
        case f.kind
          when 'inbox' then 0
          when 'sent' then 1
          when 'drafts' then 2
          when 'archive' then 3
          when 'spam' then 4
          when 'trash' then 5
          else 6
        end
    `;
    return rows.map((row) => toFolder(row as Record<string, unknown>));
  }

  async listMessages(
    mailboxId: string,
    folderKind: PatraFolderKind,
    options: { search?: string; limit?: number } = {}
  ) {
    await this.ready();
    const safeLimit = Math.max(1, Math.min(options.limit ?? 100, 200));
    const search = options.search?.trim() ?? "";

    const rows = search
      ? await this.sql`
          select m.*
          from patra_messages m
          join patra_folders f on f.id=m.folder_id
          where m.mailbox_id=${mailboxId}
            and f.kind=${folderKind}
            and (
              lower(m.from_address) like lower(${"%" + search + "%"}) or
              lower(coalesce(m.from_name,'')) like lower(${"%" + search + "%"}) or
              lower(m.subject) like lower(${"%" + search + "%"}) or
              lower(m.preview) like lower(${"%" + search + "%"}) or
              lower(m.text_body) like lower(${"%" + search + "%"})
            )
          order by coalesce(m.received_at, m.sent_at, m.created_at) desc
          limit ${safeLimit}
        `
      : await this.sql`
          select m.*
          from patra_messages m
          join patra_folders f on f.id=m.folder_id
          where m.mailbox_id=${mailboxId}
            and f.kind=${folderKind}
          order by coalesce(m.received_at, m.sent_at, m.created_at) desc
          limit ${safeLimit}
        `;

    return rows.map((row) => toMessage(row as Record<string, unknown>));
  }

  async getMessage(mailboxId: string, messageId: string) {
    await this.ready();
    const rows = await this.sql`
      select * from patra_messages
      where mailbox_id=${mailboxId} and id=${messageId}
      limit 1
    `;
    return rows[0] ? toMessage(rows[0] as Record<string, unknown>) : null;
  }

  async createMessage(input: CreateMessageInput) {
    await this.ready();
    const folderRows = await this.sql`
      select id from patra_folders
      where mailbox_id=${input.mailboxId} and kind=${input.folderKind}
      limit 1
    `;
    if (!folderRows[0]) throw new Error("mailbox_folder_not_found");

    const id = "msg_" + randomUUID();
    const threadId = input.threadId || id;
    const textBody = input.textBody ?? "";
    const preview = textBody.replace(/\s+/g, " ").trim().slice(0, 180);
    const toJson = JSON.stringify(input.to);
    const ccJson = JSON.stringify(input.cc ?? []);
    const bccJson = JSON.stringify(input.bcc ?? []);
    const labelsJson = JSON.stringify(input.labels ?? []);

    const rows = await this.sql`
      insert into patra_messages(
        id, mailbox_id, folder_id, thread_id,
        from_name, from_address, to_json, cc_json, bcc_json,
        subject, text_body, html_body, preview,
        received_at, sent_at, is_read, starred,
        labels_json, delivery_status, internet_message_id
      ) values (
        ${id}, ${input.mailboxId}, ${String((folderRows[0] as Record<string, unknown>).id)}, ${threadId},
        ${input.from.name ?? null}, ${input.from.address},
        ${toJson}::jsonb, ${ccJson}::jsonb, ${bccJson}::jsonb,
        ${input.subject}, ${textBody}, ${input.htmlBody ?? null}, ${preview},
        ${input.receivedAt ?? null}, ${input.sentAt ?? null},
        ${input.read ?? false}, ${input.starred ?? false},
        ${labelsJson}::jsonb, ${input.deliveryStatus}, ${input.internetMessageId ?? null}
      )
      returning *
    `;
    return toMessage(rows[0] as Record<string, unknown>);
  }

  async updateMessageState(
    mailboxId: string,
    messageId: string,
    patch: {
      folderKind?: PatraFolderKind;
      read?: boolean;
      starred?: boolean;
      deliveryStatus?: PatraDeliveryStatus;
      sentAt?: string | null;
    }
  ) {
    await this.ready();
    const current = await this.getMessage(mailboxId, messageId);
    if (!current) return null;

    let folderId = current.folderId;
    if (patch.folderKind) {
      const folderRows = await this.sql`
        select id from patra_folders
        where mailbox_id=${mailboxId} and kind=${patch.folderKind}
        limit 1
      `;
      if (!folderRows[0]) throw new Error("mailbox_folder_not_found");
      folderId = String((folderRows[0] as Record<string, unknown>).id);
    }

    const rows = await this.sql`
      update patra_messages
      set
        folder_id=${folderId},
        is_read=${patch.read ?? current.read},
        starred=${patch.starred ?? current.starred},
        delivery_status=${patch.deliveryStatus ?? current.deliveryStatus},
        sent_at=${patch.sentAt === undefined ? current.sentAt : patch.sentAt},
        updated_at=now()
      where mailbox_id=${mailboxId} and id=${messageId}
      returning *
    `;
    return rows[0] ? toMessage(rows[0] as Record<string, unknown>) : null;
  }

  async enqueueDelivery(messageId: string, mailboxId: string) {
    await this.ready();
    const id = "q_" + randomUUID();
    const rows = await this.sql`
      insert into patra_delivery_queue(
        id, message_id, mailbox_id, status, attempts, next_attempt_at
      ) values (
        ${id}, ${messageId}, ${mailboxId}, 'queued', 0, now()
      )
      returning *
    `;
    return toQueueItem(rows[0] as Record<string, unknown>);
  }

  async listQueuedDeliveries(limit = 50) {
    await this.ready();
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const rows = await this.sql`
      select *
      from patra_delivery_queue
      where status='queued' and next_attempt_at <= now()
      order by created_at asc
      limit ${safeLimit}
    `;
    return rows.map((row) => toQueueItem(row as Record<string, unknown>));
  }
}

export function createPatraStore(): PatraStore {
  const databaseUrl =
    process.env.WORKSPACE_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();

  return databaseUrl
    ? new PostgresPatraStore(databaseUrl)
    : new MemoryPatraStore();
}
