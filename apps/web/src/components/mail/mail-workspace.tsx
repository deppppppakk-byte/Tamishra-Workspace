"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { builtInMailProviders } from "@tamishra/mail-core";
import styles from "./mail.module.css";

type Folder = "inbox" | "sent" | "drafts" | "archive" | "spam" | "trash";

type MailMessage = {
  id: string;
  folder: Folder;
  from: string;
  address: string;
  subject: string;
  preview: string;
  body: string;
  time: string;
  read: boolean;
  starred: boolean;
  labels?: string[];
  attachment?: string;
};

const seedMessages: MailMessage[] = [
  {
    id: "m-101",
    folder: "inbox",
    from: "Aarav Mehta",
    address: "aarav@example.com",
    subject: "Design review notes",
    preview: "I added the decisions from today’s review and the remaining actions...",
    body: "Hi Deepak,\n\nI added the decisions from today’s design review and the remaining action items. The updated notes are ready for your review.\n\nRegards,\nAarav",
    time: "3:42 PM",
    read: false,
    starred: true,
    labels: ["Project"]
  },
  {
    id: "m-102",
    folder: "inbox",
    from: "Tamishra Workspace",
    address: "updates@patra.in",
    subject: "Your workspace foundation is ready",
    preview: "Mail, chat, meetings, notes and forms now share one product shell...",
    body: "Welcome to Tamishra Workspace.\n\nThis inbox is running in local demo mode. External delivery will be enabled through provider adapters, so the interface does not depend on one email service.",
    time: "2:18 PM",
    read: false,
    starred: false,
    labels: ["Workspace"]
  },
  {
    id: "m-103",
    folder: "inbox",
    from: "Priya Nair",
    address: "priya@example.com",
    subject: "Meeting follow-up",
    preview: "Sharing the summary and the two files we discussed during the call.",
    body: "Hello,\n\nSharing the meeting summary and the two files we discussed. Please add comments directly in the workspace when convenient.\n\nThanks,\nPriya",
    time: "12:06 PM",
    read: true,
    starred: false,
    attachment: "Meeting-summary.pdf",
    labels: ["Team"]
  },
  {
    id: "m-104",
    folder: "inbox",
    from: "Finance Desk",
    address: "finance@example.com",
    subject: "September statement",
    preview: "Your monthly statement is attached for reference.",
    body: "Hello,\n\nYour September statement is attached for reference. No action is required if the details are correct.\n\nFinance Desk",
    time: "Yesterday",
    read: true,
    starred: true,
    attachment: "September-statement.pdf",
    labels: ["Finance"]
  },
  {
    id: "m-105",
    folder: "sent",
    from: "You",
    address: "you@patra.in",
    subject: "Re: Project schedule",
    preview: "The updated schedule works for me. I have marked the review checkpoints...",
    body: "The updated schedule works for me. I have marked the review checkpoints and dependencies in the shared plan.",
    time: "Yesterday",
    read: true,
    starred: false
  },
  {
    id: "m-106",
    folder: "drafts",
    from: "Draft",
    address: "",
    subject: "Quarterly planning",
    preview: "Draft — agenda, owners and expected outcomes...",
    body: "Agenda:\n- Product priorities\n- Owners\n- Expected outcomes",
    time: "Draft",
    read: true,
    starred: false
  }
];

const folders: Array<{ id: Folder | "starred"; label: string; symbol: string }> = [
  { id: "inbox", label: "Inbox", symbol: "⌂" },
  { id: "starred", label: "Starred", symbol: "☆" },
  { id: "sent", label: "Sent", symbol: "↗" },
  { id: "drafts", label: "Drafts", symbol: "◇" },
  { id: "archive", label: "Archive", symbol: "□" },
  { id: "spam", label: "Spam", symbol: "!" },
  { id: "trash", label: "Trash", symbol: "⌫" }
];

export function MailWorkspace() {
  const [messages, setMessages] = useState(seedMessages);
  const [folder, setFolder] = useState<Folder | "starred">("inbox");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(seedMessages[0].id);
  const [checked, setChecked] = useState<string[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [providerPanelOpen, setProviderPanelOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("tamishra");
  const [mobileReading, setMobileReading] = useState(false);
  const [compose, setCompose] = useState({ to: "", subject: "", body: "" });
  const [notice, setNotice] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const visibleMessages = useMemo(() => {
    const normalized = query.trim().toLowerCase();

    return messages.filter((message) => {
      const folderMatch = folder === "starred" ? message.starred : message.folder === folder;
      if (!folderMatch) return false;
      if (!normalized) return true;

      return [message.from, message.address, message.subject, message.preview, message.body]
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    });
  }, [folder, messages, query]);

  const activeMessage =
    visibleMessages.find((message) => message.id === selectedId) ??
    messages.find((message) => message.id === selectedId) ??
    visibleMessages[0];

  const unreadCount = messages.filter((message) => message.folder === "inbox" && !message.read).length;
  const draftCount = messages.filter((message) => message.folder === "drafts").length;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;

      if (event.key === "/" && !editing) {
        event.preventDefault();
        searchRef.current?.focus();
      }

      if (event.key.toLowerCase() === "c" && !editing) {
        event.preventDefault();
        setComposeOpen(true);
      }

      if (event.key === "Escape" && composeOpen) {
        setComposeOpen(false);
      }

      if (event.key === "Escape" && providerPanelOpen) {
        setProviderPanelOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [composeOpen, providerPanelOpen]);

  function chooseFolder(nextFolder: Folder | "starred") {
    setFolder(nextFolder);
    setChecked([]);
    setSelectedId("");
    setMobileReading(false);
  }

  function openMessage(id: string) {
    setSelectedId(id);
    setMobileReading(true);
    setMessages((current) =>
      current.map((message) => (message.id === id ? { ...message, read: true } : message))
    );
  }

  function toggleStar(id: string) {
    setMessages((current) =>
      current.map((message) =>
        message.id === id ? { ...message, starred: !message.starred } : message
      )
    );
  }

  function toggleChecked(id: string) {
    setChecked((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  }

  function toggleAll() {
    const visibleIds = visibleMessages.map((message) => message.id);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => checked.includes(id));
    setChecked(allSelected ? [] : visibleIds);
  }

  function moveChecked(destination: Folder) {
    if (!checked.length) return;

    setMessages((current) =>
      current.map((message) =>
        checked.includes(message.id) ? { ...message, folder: destination } : message
      )
    );
    setChecked([]);
    setSelectedId("");
    setNotice(destination === "trash" ? "Moved to Trash" : "Message updated");
    window.setTimeout(() => setNotice(""), 2200);
  }

  function moveMessage(id: string, destination: Folder) {
    setMessages((current) =>
      current.map((message) =>
        message.id === id ? { ...message, folder: destination } : message
      )
    );
    setChecked((current) => current.filter((messageId) => messageId !== id));
    setSelectedId("");
    setNotice(destination === "trash" ? "Moved to Trash" : "Message archived");
    window.setTimeout(() => setNotice(""), 2200);
  }

  function closeComposer() {
    if (compose.to.trim() || compose.subject.trim() || compose.body.trim()) {
      const draft: MailMessage = {
        id: `draft-${Date.now()}`,
        folder: "drafts",
        from: "Draft",
        address: compose.to.trim(),
        subject: compose.subject.trim() || "(no subject)",
        preview: compose.body.trim() || "Draft message",
        body: compose.body,
        time: "Draft",
        read: true,
        starred: false
      };
      setMessages((current) => [draft, ...current]);
      setNotice("Draft saved locally");
      window.setTimeout(() => setNotice(""), 2200);
    }

    setCompose({ to: "", subject: "", body: "" });
    setComposeOpen(false);
  }

  function sendMessage() {
    if (!compose.to.trim()) {
      setNotice("Add a recipient before sending");
      window.setTimeout(() => setNotice(""), 2200);
      return;
    }

    const sent: MailMessage = {
      id: `sent-${Date.now()}`,
      folder: "sent",
      from: "You",
      address: compose.to.trim(),
      subject: compose.subject.trim() || "(no subject)",
      preview: compose.body.trim() || "No message body",
      body: compose.body,
      time: "Now",
      read: true,
      starred: false
    };

    setMessages((current) => [sent, ...current]);
    setCompose({ to: "", subject: "", body: "" });
    setComposeOpen(false);
    setNotice("Saved to Sent locally — Patra delivery will use your @patra.in mailbox");
    window.setTimeout(() => setNotice(""), 3600);
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.appRail} aria-label="Workspace apps">
        <Link className={styles.workspaceMark} href="/" aria-label="Tamishra Workspace home">T</Link>
        <Link className={styles.railActive} href="/apps/mail" aria-label="Patra">P</Link>
        <button type="button" aria-label="Chat">C</button>
        <button type="button" aria-label="Meet">V</button>
        <button type="button" aria-label="Notes">N</button>
        <button type="button" aria-label="Forms">F</button>
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

        <button className={styles.composeButton} type="button" onClick={() => setComposeOpen(true)}>
          <span>＋</span>
          Compose
        </button>

        <nav className={styles.folderList} aria-label="Patra folders">
          {folders.map((item) => {
            const count =
              item.id === "inbox" ? unreadCount :
              item.id === "drafts" ? draftCount :
              0;

            return (
              <button
                className={folder === item.id ? styles.folderActive : ""}
                key={item.id}
                type="button"
                onClick={() => chooseFolder(item.id)}
              >
                <span className={styles.folderSymbol}>{item.symbol}</span>
                <span>{item.label}</span>
                {count > 0 && <b>{count}</b>}
              </button>
            );
          })}
        </nav>

        <div className={styles.sidebarFooter}>
          <div className={styles.accountDot}>DK</div>
          <div>
            <strong>Local mailbox</strong>
            <span>Provider not connected</span>
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
            <button type="button" aria-label="Refresh" onClick={() => setNotice("Inbox refreshed locally")}>↻</button>
            <button type="button" aria-label="Patra settings" onClick={() => setProviderPanelOpen(true)}>⚙</button>
            <button className={styles.avatar} type="button" aria-label="Account">DK</button>
          </div>
        </header>

        <div className={styles.connectionBanner}>
          <span className={styles.statusDot} />
          <div>
            <strong>Local demo mailbox</strong>
            <span>Interface is active. External send/receive will use a provider adapter.</span>
          </div>
          <button type="button" onClick={() => setProviderPanelOpen(true)}>
            Connect provider
          </button>
        </div>

        <div className={styles.mailLayout}>
          <section className={[styles.listPane, mobileReading ? styles.listMobileHidden : ""].join(" ")}>
            <div className={styles.listHeader}>
              <div>
                <p>{folder === "starred" ? "Starred" : folder[0].toUpperCase() + folder.slice(1)}</p>
                <span>{visibleMessages.length} messages</span>
              </div>
              <button type="button" aria-label="More options">•••</button>
            </div>

            <div className={styles.selectionToolbar}>
              <input
                type="checkbox"
                aria-label="Select all visible messages"
                checked={visibleMessages.length > 0 && visibleMessages.every((message) => checked.includes(message.id))}
                onChange={toggleAll}
              />
              <button type="button" disabled={!checked.length} onClick={() => moveChecked("archive")}>Archive</button>
              <button type="button" disabled={!checked.length} onClick={() => moveChecked("trash")}>Delete</button>
              <span>{checked.length ? `${checked.length} selected` : "Select messages"}</span>
            </div>

            <div className={styles.messageList}>
              {visibleMessages.length === 0 ? (
                <div className={styles.emptyState}>
                  <strong>No messages here</strong>
                  <span>Try another folder or clear your search.</span>
                </div>
              ) : (
                visibleMessages.map((message) => (
                  <article
                    className={[
                      styles.messageRow,
                      selectedId === message.id ? styles.messageSelected : "",
                      !message.read ? styles.messageUnread : ""
                    ].join(" ")}
                    key={message.id}
                    onClick={() => openMessage(message.id)}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${message.subject}`}
                      checked={checked.includes(message.id)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => toggleChecked(message.id)}
                    />
                    <button
                      className={message.starred ? styles.starred : styles.star}
                      type="button"
                      aria-label={message.starred ? "Unstar message" : "Star message"}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleStar(message.id);
                      }}
                    >
                      {message.starred ? "★" : "☆"}
                    </button>
                    <div className={styles.messageCopy}>
                      <div className={styles.senderLine}>
                        <strong>{message.from}</strong>
                        <time>{message.time}</time>
                      </div>
                      <h3>{message.subject}</h3>
                      <p>{message.preview}</p>
                      <div className={styles.messageMeta}>
                        {message.labels?.map((label) => <span key={label}>{label}</span>)}
                        {message.attachment && <span>⌕ {message.attachment}</span>}
                      </div>
                    </div>
                  </article>
                ))
              )}
            </div>
          </section>

          <section className={[styles.readerPane, mobileReading ? styles.readerMobileOpen : ""].join(" ")}>
            {activeMessage ? (
              <>
                <div className={styles.readerToolbar}>
                  <button
                    className={styles.mobileBack}
                    type="button"
                    onClick={() => setMobileReading(false)}
                    aria-label="Back to message list"
                  >
                    ←
                  </button>
                  <button type="button" onClick={() => moveMessage(activeMessage.id, "archive")} aria-label="Archive message">□</button>
                  <button
                    type="button"
                    onClick={() => moveMessage(activeMessage.id, "trash")}
                    aria-label="Delete message"
                  >
                    ⌫
                  </button>
                  <span />
                  <button type="button" aria-label="Previous message">‹</button>
                  <button type="button" aria-label="Next message">›</button>
                </div>

                <div className={styles.readerContent}>
                  <div className={styles.readerHeading}>
                    <div>
                      <span className={styles.readerLabel}>
                        {activeMessage.folder === "inbox" ? "Inbox" : activeMessage.folder}
                      </span>
                      <h1>{activeMessage.subject}</h1>
                    </div>
                    <button
                      className={activeMessage.starred ? styles.starred : styles.star}
                      type="button"
                      onClick={() => toggleStar(activeMessage.id)}
                      aria-label="Toggle starred"
                    >
                      {activeMessage.starred ? "★" : "☆"}
                    </button>
                  </div>

                  <div className={styles.senderCard}>
                    <div className={styles.senderAvatar}>{activeMessage.from.slice(0, 1).toUpperCase()}</div>
                    <div>
                      <strong>{activeMessage.from}</strong>
                      <span>{activeMessage.address || "Local draft"}</span>
                    </div>
                    <time>{activeMessage.time}</time>
                  </div>

                  <div className={styles.messageBody}>
                    {activeMessage.body.split("\n").map((line, index) => (
                      <p key={index}>{line || "\u00a0"}</p>
                    ))}
                  </div>

                  {activeMessage.attachment && (
                    <button className={styles.attachment} type="button">
                      <span>PDF</span>
                      <div>
                        <strong>{activeMessage.attachment}</strong>
                        <small>Attachment preview placeholder</small>
                      </div>
                    </button>
                  )}

                  <div className={styles.replyRow}>
                    <button type="button" onClick={() => {
                      setCompose({
                        to: activeMessage.address,
                        subject: activeMessage.subject.startsWith("Re:") ? activeMessage.subject : `Re: ${activeMessage.subject}`,
                        body: ""
                      });
                      setComposeOpen(true);
                    }}>
                      ↩ Reply
                    </button>
                    <button type="button" onClick={() => {
                      setCompose({
                        to: "",
                        subject: activeMessage.subject.startsWith("Fwd:") ? activeMessage.subject : `Fwd: ${activeMessage.subject}`,
                        body: `\n\n---------- Forwarded message ----------\nFrom: ${activeMessage.from}\nSubject: ${activeMessage.subject}\n\n${activeMessage.body}`
                      });
                      setComposeOpen(true);
                    }}>
                      ↗ Forward
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className={styles.readerEmpty}>
                <div>M</div>
                <strong>Select a message</strong>
                <span>Choose a conversation to read it here.</span>
              </div>
            )}
          </section>
        </div>
      </section>

      {composeOpen && (
        <section className={styles.composePanel} aria-label="Compose email">
          <header>
            <strong>New message</strong>
            <button type="button" aria-label="Close and save draft" onClick={closeComposer}>×</button>
          </header>
          <label>
            <span>To</span>
            <input
              value={compose.to}
              onChange={(event) => setCompose((current) => ({ ...current, to: event.target.value }))}
              placeholder="name@patra.in"
            />
          </label>
          <label>
            <span>Subject</span>
            <input
              value={compose.subject}
              onChange={(event) => setCompose((current) => ({ ...current, subject: event.target.value }))}
              placeholder="Subject"
            />
          </label>
          <textarea
            value={compose.body}
            onChange={(event) => setCompose((current) => ({ ...current, body: event.target.value }))}
            placeholder="Write your message..."
            aria-label="Message body"
          />
          <footer>
            <button className={styles.sendButton} type="button" onClick={sendMessage}>Send</button>
            <button type="button" aria-label="Attach file">⌕ Attach</button>
            <span>Local mode</span>
          </footer>
        </section>
      )}

      {providerPanelOpen && (
        <div className={styles.providerBackdrop} role="presentation" onMouseDown={() => setProviderPanelOpen(false)}>
          <section
            className={styles.providerPanel}
            role="dialog"
            aria-modal="true"
            aria-label="Connect mail provider"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>PATRA ACCOUNTS</span>
                <h2>Connect a provider</h2>
              </div>
              <button type="button" aria-label="Close provider panel" onClick={() => setProviderPanelOpen(false)}>×</button>
            </header>

            <div className={styles.providerBody}>
              <div className={styles.providerList}>
                {builtInMailProviders.map((provider) => (
                  <button
                    className={selectedProvider === provider.key ? styles.providerActive : ""}
                    key={provider.key}
                    type="button"
                    onClick={() => setSelectedProvider(provider.key)}
                  >
                    <span>{provider.name.slice(0, 1)}</span>
                    <div>
                      <strong>{provider.name}</strong>
                      <small>{provider.connectionMethod === "native" ? "Tamishra native" : "Mail server"}</small>
                    </div>
                    {provider.recommended && <b>Recommended</b>}
                  </button>
                ))}
              </div>

              {(() => {
                const provider = builtInMailProviders.find((item) => item.key === selectedProvider) ?? builtInMailProviders[0]!;

                return (
                  <div className={styles.providerDetail}>
                    <div className={styles.providerTitle}>
                      <div>{provider.name.slice(0, 1)}</div>
                      <div>
                        <h3>{provider.name}</h3>
                        <p>{provider.description}</p>
                      </div>
                    </div>

                    <div className={styles.capabilityGrid}>
                      <span className={provider.capabilities.threads ? styles.capabilityOn : ""}>Threads</span>
                      <span className={provider.capabilities.search ? styles.capabilityOn : ""}>Search</span>
                      <span className={provider.capabilities.drafts ? styles.capabilityOn : ""}>Drafts</span>
                      <span className={provider.capabilities.pushSync ? styles.capabilityOn : ""}>Push sync</span>
                    </div>

                    {provider.fields ? (
                      <div className={styles.providerFields}>
                        {provider.fields.map((field) => (
                          <label key={field.key}>
                            <span>{field.label}</span>
                            <input
                              type={field.type}
                              placeholder={field.placeholder}
                              autoComplete={field.secret ? "off" : undefined}
                              disabled
                            />
                          </label>
                        ))}
                        <p>
                          Server credentials are intentionally disabled in this browser build.
                          They will be submitted only to the secure mail gateway.
                        </p>
                      </div>
                    ) : (
                      <div className={styles.oauthNotice}>
                        <strong>Tamishra-native account</strong>
                        <p>
                          This mailbox uses the Tamishra Workspace identity and secure gateway.
                          No Google or Microsoft account is required.
                        </p>
                      </div>
                    )}

                    <div className={styles.providerActions}>
                      <button
                        className={styles.providerPrimary}
                        type="button"
                        onClick={() => {
                          setProviderPanelOpen(false);
                          setNotice(
                            provider.key === "tamishra"
                              ? "Tamishra Patra selected — first-party mailbox setup will use the Workspace gateway"
                              : `${provider.name} selected — secure gateway credentials are required to complete connection`
                          );
                          window.setTimeout(() => setNotice(""), 3600);
                        }}
                      >
                        Continue securely
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setProviderPanelOpen(false);
                          setNotice("Local demo mailbox remains active");
                          window.setTimeout(() => setNotice(""), 2200);
                        }}
                      >
                        Keep local mailbox
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </section>
        </div>
      )}

      {notice && <div className={styles.toast} role="status">{notice}</div>}
    </main>
  );
}
