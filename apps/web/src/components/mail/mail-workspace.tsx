"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workspaceApi } from "../../lib/workspace-api";
import styles from "./mail.module.css";

type FolderKind = "inbox" | "sent" | "drafts" | "archive" | "spam" | "trash";

type PatraMailbox = {
  id: string;
  address: string;
  localPart: string;
  domain: string;
  mailboxClass: "public" | "tamishra-company";
  displayName: string;
  status: "active" | "suspended";
  quotaBytes: string;
  usedBytes: string;
  createdAt: string;
};

type PatraFolder = {
  id: string;
  name: string;
  kind: FolderKind;
  totalCount: number;
  unreadCount: number;
};

type PatraAddress = {
  name?: string;
  address: string;
};

type PatraMessage = {
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
  deliveryStatus:
    | "draft"
    | "queued"
    | "delivered-local"
    | "sent-external"
    | "failed";
  createdAt: string;
  updatedAt: string;
};

type MailboxesResponse = {
  mailboxes: PatraMailbox[];
  persistence: "postgres" | "ephemeral-memory";
};

type FoldersResponse = {
  mailbox: PatraMailbox;
  folders: PatraFolder[];
};

type MessagesResponse = {
  mailbox: PatraMailbox;
  folder: FolderKind;
  messages: PatraMessage[];
};

const folderSymbols: Record<FolderKind, string> = {
  inbox: "⌂",
  sent: "↗",
  drafts: "◇",
  archive: "□",
  spam: "!",
  trash: "⌫"
};

function formatTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function recipientList(value: string) {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function initials(value: string) {
  return (
    value
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "P"
  );
}

export function MailWorkspace() {
  const [mailboxes, setMailboxes] = useState<PatraMailbox[]>([]);
  const [mailboxId, setMailboxId] = useState("");
  const [folders, setFolders] = useState<PatraFolder[]>([]);
  const [folder, setFolder] = useState<FolderKind>("inbox");
  const [messages, setMessages] = useState<PatraMessage[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [compose, setCompose] = useState({ to: "", subject: "", body: "" });
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [setupUsername, setSetupUsername] = useState("");
  const [availability, setAvailability] = useState<null | {
    address: string;
    available: boolean;
  }>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const mailbox = useMemo(
    () => mailboxes.find((item) => item.id === mailboxId) ?? mailboxes[0] ?? null,
    [mailboxId, mailboxes]
  );

  const activeMessage = useMemo(
    () => messages.find((item) => item.id === selectedId) ?? messages[0] ?? null,
    [messages, selectedId]
  );

  const loadMailboxes = useCallback(async () => {
    try {
      const result = await workspaceApi<MailboxesResponse>("/v1/patra/mailboxes");
      setMailboxes(result.mailboxes);
      setMailboxId((current) => {
        if (current && result.mailboxes.some((item) => item.id === current)) {
          return current;
        }
        return result.mailboxes[0]?.id ?? "";
      });
      setNeedsSignIn(false);
      return result.mailboxes;
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? Number((error as { status?: unknown }).status ?? 0)
          : 0;
      if (status === 401) setNeedsSignIn(true);
      throw error;
    }
  }, []);

  const loadFolders = useCallback(async (id: string) => {
    if (!id) return;
    const result = await workspaceApi<FoldersResponse>(
      `/v1/patra/mailboxes/${encodeURIComponent(id)}/folders`
    );
    setFolders(result.folders);
  }, []);

  const loadMessages = useCallback(
    async (id: string, nextFolder: FolderKind, search = "") => {
      if (!id) return;
      const params = new URLSearchParams({ folder: nextFolder, limit: "150" });
      if (search.trim()) params.set("q", search.trim());
      const result = await workspaceApi<MessagesResponse>(
        `/v1/patra/mailboxes/${encodeURIComponent(id)}/messages?${params.toString()}`
      );
      setMessages(result.messages);
      setSelectedId((current) =>
        result.messages.some((item) => item.id === current)
          ? current
          : result.messages[0]?.id ?? ""
      );
    },
    []
  );

  const refresh = useCallback(async () => {
    if (!mailboxId) return;
    await Promise.all([
      loadFolders(mailboxId),
      loadMessages(mailboxId, folder, query)
    ]);
  }, [folder, loadFolders, loadMessages, mailboxId, query]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadMailboxes()
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [loadMailboxes]);

  useEffect(() => {
    if (!mailboxId) {
      setFolders([]);
      setMessages([]);
      return;
    }

    let alive = true;
    const timer = window.setTimeout(() => {
      Promise.all([
        loadFolders(mailboxId),
        loadMessages(mailboxId, folder, query)
      ]).catch(() => {
        if (alive) setNotice("Unable to load Patra mailbox");
      });
    }, query ? 220 : 0);

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [folder, loadFolders, loadMessages, mailboxId, query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (event.key === "/" && !editing && mailbox) {
        event.preventDefault();
        searchRef.current?.focus();
      }

      if (event.key.toLowerCase() === "c" && !editing && mailbox) {
        event.preventDefault();
        setComposeOpen(true);
      }

      if (event.key === "Escape" && composeOpen) setComposeOpen(false);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [composeOpen, mailbox]);

  function flash(message: string, duration = 3200) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), duration);
  }

  async function provisionMailbox(event: FormEvent) {
    event.preventDefault();
    if (setupBusy) return;
    setSetupBusy(true);
    try {
      const result = await workspaceApi<{ mailbox: PatraMailbox }>(
        "/v1/patra/mailboxes",
        {
          method: "POST",
          body: JSON.stringify({ username: setupUsername })
        }
      );
      setMailboxes((current) => [...current, result.mailbox]);
      setMailboxId(result.mailbox.id);
      setAvailability(null);
      flash(`${result.mailbox.address} is ready`);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      flash(
        code === "mailbox_address_taken"
          ? "That Patra address is already taken."
          : code === "mailbox_username_reserved"
            ? "That address is reserved by Patra."
            : code === "invalid_mailbox_username"
              ? "Use 3–64 letters, numbers, dots, underscores or hyphens."
              : "Unable to create the Patra mailbox."
      );
    } finally {
      setSetupBusy(false);
    }
  }

  async function checkAvailability() {
    const username = setupUsername.trim();
    if (!username) return;
    try {
      const result = await workspaceApi<{
        address: string;
        available: boolean;
      }>(`/v1/patra/availability?username=${encodeURIComponent(username)}`);
      setAvailability(result);
    } catch {
      setAvailability(null);
      flash("Enter a valid Patra username.");
    }
  }

  async function patchMessage(
    messageId: string,
    patch: { folder?: FolderKind; read?: boolean; starred?: boolean }
  ) {
    if (!mailbox) return;
    await workspaceApi(
      `/v1/patra/mailboxes/${encodeURIComponent(mailbox.id)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch)
      }
    );
    await refresh();
  }

  async function openMessage(message: PatraMessage) {
    setSelectedId(message.id);
    if (!message.read) {
      try {
        await patchMessage(message.id, { read: true });
      } catch {
        flash("Unable to update read state");
      }
    }
  }

  async function sendMessage() {
    if (!mailbox) return;
    const to = recipientList(compose.to);
    if (!to.length) {
      flash("Add at least one recipient.");
      return;
    }

    try {
      const result = await workspaceApi<{
        localRecipients: number;
        externalRecipients: string[];
        delivery: string;
      }>(`/v1/patra/mailboxes/${encodeURIComponent(mailbox.id)}/send`, {
        method: "POST",
        body: JSON.stringify({
          to,
          subject: compose.subject,
          textBody: compose.body,
          threadId: activeMessage?.threadId
        })
      });

      setCompose({ to: "", subject: "", body: "" });
      setComposeOpen(false);
      setFolder("sent");
      await Promise.all([loadFolders(mailbox.id), loadMessages(mailbox.id, "sent")]);

      flash(
        result.externalRecipients.length
          ? `Message queued: ${result.localRecipients} local, ${result.externalRecipients.length} external recipient(s).`
          : "Message delivered inside Patra."
      );
    } catch {
      flash("Unable to send this message.");
    }
  }

  async function closeComposer() {
    if (!mailbox) {
      setComposeOpen(false);
      return;
    }

    const hasContent =
      compose.to.trim() || compose.subject.trim() || compose.body.trim();

    if (hasContent) {
      try {
        await workspaceApi(
          `/v1/patra/mailboxes/${encodeURIComponent(mailbox.id)}/drafts`,
          {
            method: "POST",
            body: JSON.stringify({
              to: recipientList(compose.to),
              subject: compose.subject,
              textBody: compose.body
            })
          }
        );
        flash("Draft saved in Patra.");
      } catch {
        flash("Unable to save draft.");
      }
    }

    setCompose({ to: "", subject: "", body: "" });
    setComposeOpen(false);
    if (folder === "drafts") {
      await loadMessages(mailbox.id, "drafts", query).catch(() => undefined);
    }
    await loadFolders(mailbox.id).catch(() => undefined);
  }

  function startReply(message: PatraMessage) {
    setCompose({
      to: message.from.address,
      subject: message.subject.startsWith("Re:")
        ? message.subject
        : `Re: ${message.subject}`,
      body: ""
    });
    setComposeOpen(true);
  }

  function startForward(message: PatraMessage) {
    setCompose({
      to: "",
      subject: message.subject.startsWith("Fwd:")
        ? message.subject
        : `Fwd: ${message.subject}`,
      body:
        "\n\n---------- Forwarded message ----------\n" +
        `From: ${message.from.name ?? message.from.address} <${message.from.address}>\n` +
        `Subject: ${message.subject}\n\n${message.textBody}`
    });
    setComposeOpen(true);
  }

  if (loading) {
    return (
      <main className={styles.setupShell}>
        <div className={styles.setupCard}>
          <div className={styles.setupMark}>P</div>
          <p>Opening Tamishra Patra…</p>
        </div>
      </main>
    );
  }

  if (needsSignIn) {
    return (
      <main className={styles.setupShell}>
        <div className={styles.setupCard}>
          <div className={styles.setupMark}>P</div>
          <p className={styles.setupEyebrow}>TAMISHRA PATRA</p>
          <h1>Sign in before opening your mailbox.</h1>
          <p>
            Patra uses your Tamishra Workspace identity. Your mailbox remains
            separate from your login email.
          </p>
          <Link className={styles.setupPrimary} href="/sign-in">
            Sign in to continue
          </Link>
        </div>
      </main>
    );
  }

  if (!mailbox) {
    return (
      <main className={styles.setupShell}>
        <Link className={styles.setupHome} href="/">← Workspace</Link>
        <form className={styles.setupCard} onSubmit={provisionMailbox}>
          <div className={styles.setupMark}>P</div>
          <p className={styles.setupEyebrow}>CREATE YOUR PATRA ADDRESS</p>
          <h1>Choose your @patra.tamishra.in mailbox.</h1>
          <p>
            Public Patra registration creates one personal address. Company
            @tamishra.in addresses are provisioned separately by Tamishra.
          </p>

          <label className={styles.setupField}>
            <span>Patra username</span>
            <div>
              <input
                value={setupUsername}
                onChange={(event) => {
                  setSetupUsername(event.target.value.toLowerCase());
                  setAvailability(null);
                }}
                placeholder="yourname"
                maxLength={64}
                autoComplete="username"
                required
              />
              <b>@patra.tamishra.in</b>
            </div>
          </label>

          {availability && (
            <div
              className={
                availability.available
                  ? styles.setupAvailable
                  : styles.setupUnavailable
              }
            >
              {availability.address} is{" "}
              {availability.available ? "available" : "already taken"}.
            </div>
          )}

          <div className={styles.setupActions}>
            <button type="button" onClick={checkAvailability}>
              Check availability
            </button>
            <button
              className={styles.setupPrimaryButton}
              type="submit"
              disabled={setupBusy}
            >
              {setupBusy ? "Creating…" : "Create mailbox"}
            </button>
          </div>
        </form>
        {notice && <div className={styles.toast} role="status">{notice}</div>}
      </main>
    );
  }

  const currentFolder =
    folders.find((item) => item.kind === folder) ?? null;

  return (
    <main className={styles.shell}>
      <aside className={styles.appRail} aria-label="Workspace apps">
        <Link className={styles.workspaceMark} href="/" aria-label="Tamishra Workspace home">
          T
        </Link>
        <Link className={styles.railActive} href="/apps/mail" aria-label="Patra">
          P
        </Link>
        <Link href="/apps/chat" aria-label="Chat">C</Link>
        <Link href="/apps/meet" aria-label="Meet">V</Link>
        <Link href="/apps/notes" aria-label="Notes">N</Link>
        <Link href="/apps/forms" aria-label="Forms">F</Link>
        <span className={styles.railSpacer} />
        <Link href="/" aria-label="All apps">•••</Link>
      </aside>

      <aside className={styles.mailSidebar}>
        <div className={styles.brandRow}>
          <div>
            <span>Tamishra</span>
            <strong>Patra</strong>
          </div>
          <Link href="/" aria-label="Back to workspace">↙</Link>
        </div>

        <button
          className={styles.composeButton}
          type="button"
          onClick={() => setComposeOpen(true)}
        >
          <span>＋</span>
          Compose
        </button>

        <nav className={styles.folderList} aria-label="Patra folders">
          {folders.map((item) => (
            <button
              className={folder === item.kind ? styles.folderActive : ""}
              key={item.id}
              type="button"
              onClick={() => {
                setFolder(item.kind);
                setSelectedId("");
              }}
            >
              <span className={styles.folderSymbol}>{folderSymbols[item.kind]}</span>
              <span>{item.name}</span>
              {(item.unreadCount > 0 || item.kind === "drafts") && (
                <b>
                  {item.kind === "drafts"
                    ? item.totalCount
                    : item.unreadCount}
                </b>
              )}
            </button>
          ))}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.accountDot}>{initials(mailbox.displayName)}</div>
          <div className={styles.mailboxIdentity}>
            <strong>{mailbox.displayName}</strong>
            <span>{mailbox.address}</span>
            {mailboxes.length > 1 && (
              <select
                value={mailbox.id}
                onChange={(event) => {
                  setMailboxId(event.target.value);
                  setFolder("inbox");
                  setSelectedId("");
                }}
                aria-label="Switch Patra mailbox"
              >
                {mailboxes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.address}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      </aside>

      <section className={styles.mailStage}>
        <header className={styles.topbar}>
          <label className={styles.search}>
            <span>⌕</span>
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search Patra"
              aria-label="Search Patra"
            />
            <kbd>/</kbd>
          </label>

          <div className={styles.topActions}>
            <button
              type="button"
              aria-label="Refresh Patra"
              onClick={() =>
                refresh()
                  .then(() => flash("Patra refreshed", 1800))
                  .catch(() => flash("Unable to refresh Patra"))
              }
            >
              ↻
            </button>
            <button type="button" aria-label="Mailbox information">ⓘ</button>
            <button className={styles.avatar} type="button" aria-label="Account">
              {initials(mailbox.displayName)}
            </button>
          </div>
        </header>

        <div className={styles.connectionBanner}>
          <span className={styles.statusDotActive} />
          <div>
            <strong>{mailbox.address}</strong>
            <span>
              Native Patra mailbox · {mailbox.mailboxClass === "tamishra-company" ? "Tamishra company" : "Public Patra"}
            </span>
          </div>
          <button type="button" onClick={() => flash("Mailbox is connected to the Patra backend.")}>
            Connected
          </button>
        </div>

        <div className={styles.mailLayout}>
          <section className={styles.listPane}>
            <div className={styles.listHeader}>
              <div>
                <p>{currentFolder?.name ?? "Inbox"}</p>
                <span>{messages.length} messages</span>
              </div>
              <button type="button" aria-label="More options">•••</button>
            </div>

            <div className={styles.selectionToolbar}>
              <span className={styles.listStatus}>
                {query ? `Search: “${query}”` : mailbox.address}
              </span>
            </div>

            <div className={styles.messageList}>
              {!messages.length ? (
                <div className={styles.emptyState}>
                  <strong>No messages here</strong>
                  <span>
                    {folder === "inbox"
                      ? "Your Patra inbox is ready."
                      : "This folder is empty."}
                  </span>
                </div>
              ) : (
                messages.map((message) => (
                  <article
                    className={[
                      styles.messageRow,
                      selectedId === message.id ? styles.messageSelected : "",
                      !message.read ? styles.messageUnread : ""
                    ].join(" ")}
                    key={message.id}
                    onClick={() => void openMessage(message)}
                  >
                    <span />
                    <button
                      className={message.starred ? styles.starred : styles.star}
                      type="button"
                      aria-label={message.starred ? "Unstar message" : "Star message"}
                      onClick={(event) => {
                        event.stopPropagation();
                        void patchMessage(message.id, {
                          starred: !message.starred
                        }).catch(() => flash("Unable to update star"));
                      }}
                    >
                      {message.starred ? "★" : "☆"}
                    </button>

                    <div className={styles.messageCopy}>
                      <div className={styles.senderLine}>
                        <strong>{message.from.name ?? message.from.address}</strong>
                        <time>{formatTime(message.receivedAt ?? message.sentAt ?? message.createdAt)}</time>
                      </div>
                      <h3>{message.subject || "(no subject)"}</h3>
                      <p>{message.preview || "No message body"}</p>
                      <div className={styles.messageMeta}>
                        <span>{message.deliveryStatus}</span>
                        {message.labels.map((label) => (
                          <span key={label}>{label}</span>
                        ))}
                      </div>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className={styles.readerPane}>
            {activeMessage ? (
              <>
                <div className={styles.readerToolbar}>
                  <button
                    type="button"
                    onClick={() =>
                      void patchMessage(activeMessage.id, { folder: "archive" }).catch(
                        () => flash("Unable to archive message")
                      )
                    }
                    aria-label="Archive message"
                  >
                    □
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void patchMessage(activeMessage.id, { folder: "trash" }).catch(
                        () => flash("Unable to move message to Trash")
                      )
                    }
                    aria-label="Delete message"
                  >
                    ⌫
                  </button>
                  <span />
                </div>

                <div className={styles.readerContent}>
                  <div className={styles.readerHeading}>
                    <div>
                      <span className={styles.readerLabel}>{folder}</span>
                      <h1>{activeMessage.subject || "(no subject)"}</h1>
                    </div>
                    <button
                      className={activeMessage.starred ? styles.starred : styles.star}
                      type="button"
                      onClick={() =>
                        void patchMessage(activeMessage.id, {
                          starred: !activeMessage.starred
                        }).catch(() => flash("Unable to update star"))
                      }
                      aria-label="Toggle starred"
                    >
                      {activeMessage.starred ? "★" : "☆"}
                    </button>
                  </div>

                  <div className={styles.senderCard}>
                    <div className={styles.senderAvatar}>
                      {initials(activeMessage.from.name ?? activeMessage.from.address)}
                    </div>
                    <div>
                      <strong>{activeMessage.from.name ?? activeMessage.from.address}</strong>
                      <span>{activeMessage.from.address}</span>
                    </div>
                    <time>
                      {formatTime(
                        activeMessage.receivedAt ??
                          activeMessage.sentAt ??
                          activeMessage.createdAt
                      )}
                    </time>
                  </div>

                  <div className={styles.recipientLine}>
                    To:{" "}
                    {activeMessage.to.map((item) => item.address).join(", ") ||
                      mailbox.address}
                  </div>

                  <div className={styles.messageBody}>
                    {activeMessage.textBody.split("\n").map((line, index) => (
                      <p key={index}>{line || "\u00a0"}</p>
                    ))}
                  </div>

                  <div className={styles.replyRow}>
                    <button type="button" onClick={() => startReply(activeMessage)}>
                      ↩ Reply
                    </button>
                    <button type="button" onClick={() => startForward(activeMessage)}>
                      ↗ Forward
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className={styles.readerEmpty}>
                <div>P</div>
                <strong>Select a message</strong>
                <span>Choose a Patra conversation to read it here.</span>
              </div>
            )}
          </section>
        </div>
      </section>

      {composeOpen && (
        <section className={styles.composePanel} aria-label="Compose Patra message">
          <header>
            <strong>New message · {mailbox.address}</strong>
            <button type="button" aria-label="Close and save draft" onClick={() => void closeComposer()}>
              ×
            </button>
          </header>
          <label>
            <span>To</span>
            <input
              value={compose.to}
              onChange={(event) =>
                setCompose((current) => ({ ...current, to: event.target.value }))
              }
              placeholder="name@patra.tamishra.in"
              autoComplete="off"
            />
          </label>
          <label>
            <span>Subject</span>
            <input
              value={compose.subject}
              onChange={(event) =>
                setCompose((current) => ({
                  ...current,
                  subject: event.target.value
                }))
              }
              placeholder="Subject"
            />
          </label>
          <textarea
            value={compose.body}
            onChange={(event) =>
              setCompose((current) => ({ ...current, body: event.target.value }))
            }
            placeholder="Write your message..."
            aria-label="Message body"
          />
          <footer>
            <button className={styles.sendButton} type="button" onClick={() => void sendMessage()}>
              Send
            </button>
            <span>
              Internal Patra delivery is active; external recipients use the delivery queue.
            </span>
          </footer>
        </section>
      )}

      {notice && <div className={styles.toast} role="status">{notice}</div>}
    </main>
  );
}
