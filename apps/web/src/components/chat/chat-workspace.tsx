"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type {
  ChatAttachment,
  ChatConversation,
  ChatEvent,
  ChatMember,
  ChatMessage,
  ChatNotification,
  ChatPresence,
  ChatSearchResult,
  ChatTypingState
} from "@tamishra/chat-core";
import {
  workspaceApi,
  workspaceApiBase,
  type WorkspaceSessionResponse
} from "../../lib/workspace-api";
import styles from "./chat-workspace.module.css";

type DirectoryMember = {
  membership: {
    id: string;
    organizationId: string;
    role: "owner" | "admin" | "member" | "guest";
  };
  user: {
    id: string;
    email: string;
    displayName: string;
  };
};

type CreateMode = "channel" | "group" | "direct";

const quickReactions = ["👍", "✅", "❤️"];
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return Math.round(value) + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function conversationIcon(conversation: ChatConversation) {
  if (conversation.kind === "channel") return "#";
  if (conversation.kind === "group") return "G";
  return "D";
}

function conversationTitle(conversation: ChatConversation) {
  if (conversation.name.trim()) return conversation.name;
  if (conversation.kind === "direct") return "Direct message";
  if (conversation.kind === "group") return "Group chat";
  return "Channel";
}

export function ChatWorkspace() {
  const [session, setSession] = useState<WorkspaceSessionResponse | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [directory, setDirectory] = useState<DirectoryMember[]>([]);
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [composer, setComposer] = useState("");
  const [threadRootId, setThreadRootId] = useState("");
  const [threadComposer, setThreadComposer] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChatSearchResult[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>("channel");
  const [createName, setCreateName] = useState("");
  const [createTopic, setCreateTopic] = useState("");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [conversationMembers, setConversationMembers] = useState<ChatMember[]>([]);
  const [notifications, setNotifications] = useState<ChatNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [presence, setPresence] = useState<ChatPresence[]>([]);
  const [typing, setTyping] = useState<ChatTypingState[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [threadFiles, setThreadFiles] = useState<File[]>([]);
  const [realtimeStatus, setRealtimeStatus] = useState<"connecting" | "live" | "offline">("connecting");
  const mainFileInputRef = useRef<HTMLInputElement>(null);
  const threadFileInputRef = useRef<HTMLInputElement>(null);
  const typingLastSentRef = useRef(0);
  const typingStopTimerRef = useRef<number | null>(null);

  const currentUser = session?.authenticated ? session.user : null;
  const memberships = session?.authenticated ? session.memberships : [];
  const activeConversation = conversations.find(
    (conversation) => conversation.id === activeConversationId
  );
  const threadRoot = messages.find((message) => message.id === threadRootId) ?? null;
  const threadReplies = useMemo(
    () => messages.filter((message) => message.parentMessageId === threadRootId),
    [messages, threadRootId]
  );
  const rootMessages = useMemo(
    () => messages.filter((message) => !message.parentMessageId),
    [messages]
  );
  const unreadNotificationCount = useMemo(
    () => notifications.filter((notification) => !notification.readAt).length,
    [notifications]
  );
  const activeMemberIds = useMemo(
    () => new Set(conversationMembers.map((member) => member.userId)),
    [conversationMembers]
  );
  const presenceByUser = useMemo(
    () => new Map(presence.map((item) => [item.userId, item])),
    [presence]
  );
  const mainMentionSuggestions = useMemo(
    () => mentionSuggestions(composer),
    [composer, directory, activeMemberIds]
  );
  const threadMentionSuggestions = useMemo(
    () => mentionSuggestions(threadComposer),
    [threadComposer, directory, activeMemberIds]
  );

  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    if (!organizationId || !currentUser) return;

    setRealtimeStatus("connecting");
    const source = new EventSource(
      workspaceApiBase +
        "/v1/chat/events?organizationId=" +
        encodeURIComponent(organizationId),
      { withCredentials: true }
    );

    source.onopen = () => setRealtimeStatus("live");
    source.onerror = () => setRealtimeStatus("offline");
    source.addEventListener("chat", (event) => {
      try {
        const chatEvent = JSON.parse((event as MessageEvent).data) as ChatEvent;
        void handleRealtimeEvent(chatEvent);
      } catch {
        // Ignore malformed event frames; EventSource will continue.
      }
    });

    const recoveryTimer = window.setInterval(() => {
      void loadConversations(organizationId, activeConversationId, false);
      void loadNotifications(organizationId);
      void loadPresence(organizationId);
      if (activeConversationId) {
        void refreshMessages(activeConversationId, false);
        void loadTyping(activeConversationId);
      }
    }, 30_000);

    return () => {
      source.close();
      window.clearInterval(recoveryTimer);
    };
  }, [organizationId, currentUser?.id, activeConversationId]);

  useEffect(() => {
    if (!organizationId || !currentUser) return;
    void heartbeatPresence(organizationId);
    const timer = window.setInterval(
      () => void heartbeatPresence(organizationId),
      30_000
    );
    return () => window.clearInterval(timer);
  }, [organizationId, currentUser?.id]);

  useEffect(() => {
    return () => {
      if (typingStopTimerRef.current) {
        window.clearTimeout(typingStopTimerRef.current);
      }
    };
  }, []);

  async function initialize() {
    setLoading(true);
    setError("");
    try {
      const nextSession = await workspaceApi<WorkspaceSessionResponse>("/v1/auth/session");
      setSession(nextSession);
      if (!nextSession.authenticated) return;
      const firstOrganization = nextSession.memberships[0]?.organization.id ?? "";
      setOrganizationId(firstOrganization);
      if (firstOrganization) {
        await Promise.all([
          loadDirectory(firstOrganization),
          loadConversations(firstOrganization)
        ]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to open Chat.");
    } finally {
      setLoading(false);
    }
  }

  async function loadDirectory(nextOrganizationId: string) {
    const response = await workspaceApi<{ members: DirectoryMember[] }>(
      "/v1/auth/organizations/" +
        encodeURIComponent(nextOrganizationId) +
        "/members"
    );
    setDirectory(response.members);
  }

  async function loadConversations(
    nextOrganizationId: string,
    preferredConversationId = "",
    updateLoading = true
  ) {
    if (updateLoading) setLoading(true);
    try {
      const response = await workspaceApi<{ conversations: ChatConversation[] }>(
        "/v1/chat/conversations?organizationId=" +
          encodeURIComponent(nextOrganizationId)
      );
      setConversations(response.conversations);
      const nextActive =
        preferredConversationId &&
        response.conversations.some((item) => item.id === preferredConversationId)
          ? preferredConversationId
          : activeConversationId &&
              response.conversations.some((item) => item.id === activeConversationId)
            ? activeConversationId
            : response.conversations[0]?.id ?? "";

      if (nextActive && nextActive !== activeConversationId) {
        setActiveConversationId(nextActive);
        await refreshMessages(nextActive);
      } else if (!nextActive) {
        setActiveConversationId("");
        setMessages([]);
      }
    } finally {
      if (updateLoading) setLoading(false);
    }
  }

  async function refreshMessages(conversationId: string, markRead = true) {
    const response = await workspaceApi<{ messages: ChatMessage[] }>(
      "/v1/chat/conversations/" +
        encodeURIComponent(conversationId) +
        "/messages?limit=100"
    );
    setMessages(response.messages);
    if (markRead && response.messages.length) {
      const last = response.messages[response.messages.length - 1];
      await workspaceApi(
        "/v1/chat/conversations/" +
          encodeURIComponent(conversationId) +
          "/read",
        {
          method: "POST",
          body: JSON.stringify({ messageId: last.id })
        }
      ).catch(() => undefined);
    }
  }

  async function changeOrganization(nextOrganizationId: string) {
    setOrganizationId(nextOrganizationId);
    setActiveConversationId("");
    setMessages([]);
    setThreadRootId("");
    setSearchResults(null);
    setError("");
    try {
      await Promise.all([
        loadDirectory(nextOrganizationId),
        loadConversations(nextOrganizationId)
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to change workspace.");
    }
  }

  async function openConversation(conversationId: string) {
    setActiveConversationId(conversationId);
    setThreadRootId("");
    setSearchResults(null);
    setError("");
    try {
      await refreshMessages(conversationId);
      await loadConversations(organizationId, conversationId, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load conversation.");
    }
  }

  async function sendMessage(
    event: FormEvent,
    parentMessageId: string | null = null
  ) {
    event.preventDefault();
    if (!activeConversationId || sending) return;
    const body = (parentMessageId ? threadComposer : composer).trim();
    if (!body) return;

    setSending(true);
    setError("");
    try {
      await workspaceApi(
        "/v1/chat/conversations/" +
          encodeURIComponent(activeConversationId) +
          "/messages",
        {
          method: "POST",
          body: JSON.stringify({ body, parentMessageId })
        }
      );
      if (parentMessageId) setThreadComposer("");
      else setComposer("");
      await refreshMessages(activeConversationId);
      await loadConversations(organizationId, activeConversationId, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  }

  async function toggleReaction(message: ChatMessage, emoji: string) {
    const existing = message.reactions.find((reaction) => reaction.emoji === emoji);
    const method = existing?.reactedByMe ? "DELETE" : "POST";
    const path =
      "/v1/chat/messages/" +
      encodeURIComponent(message.id) +
      "/reactions" +
      (method === "DELETE" ? "/" + encodeURIComponent(emoji) : "");

    await workspaceApi(path, {
      method,
      ...(method === "POST" ? { body: JSON.stringify({ emoji }) } : {})
    });
    await refreshMessages(activeConversationId, false);
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    const query = searchQuery.trim();
    if (query.length < 2 || !organizationId) {
      setSearchResults(null);
      return;
    }

    try {
      const response = await workspaceApi<{ results: ChatSearchResult[] }>(
        "/v1/chat/search?organizationId=" +
          encodeURIComponent(organizationId) +
          "&q=" +
          encodeURIComponent(query)
      );
      setSearchResults(response.results);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Search failed.");
    }
  }

  function toggleMember(userId: string) {
    setSelectedMembers((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId]
    );
  }

  async function createConversation(event: FormEvent) {
    event.preventDefault();
    if (!organizationId || !currentUser) return;

    if (createMode === "direct" && selectedMembers.length !== 1) {
      setError("Choose exactly one person for a direct message.");
      return;
    }
    if (createMode === "group" && selectedMembers.length < 1) {
      setError("Choose at least one person for a group chat.");
      return;
    }
    if (createMode === "channel" && createName.trim().length < 2) {
      setError("Enter a channel name.");
      return;
    }

    let name = createName.trim();
    if (createMode === "direct") {
      const person = directory.find((member) => member.user.id === selectedMembers[0]);
      name = person?.user.displayName ?? "Direct message";
    } else if (createMode === "group" && !name) {
      name = "Group chat";
    }

    try {
      const response = await workspaceApi<{ conversation: ChatConversation }>(
        "/v1/chat/conversations",
        {
          method: "POST",
          body: JSON.stringify({
            organizationId,
            kind: createMode,
            name,
            topic: createTopic.trim(),
            memberIds: selectedMembers
          })
        }
      );
      setCreateOpen(false);
      setCreateName("");
      setCreateTopic("");
      setSelectedMembers([]);
      await loadConversations(organizationId, response.conversation.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Conversation could not be created.");
    }
  }

  if (loading && !session) {
    return (
      <main className={styles.centerState}>
        <div className={styles.loader} />
        <strong>Opening Tamishra Chat</strong>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className={styles.centerState}>
        <div className={styles.logo}>T</div>
        <h1>Sign in to Tamishra Chat</h1>
        <p>Your conversations use the same Tamishra Workspace identity and organization permissions.</p>
        <Link className={styles.primaryLink} href="/sign-in">Sign in</Link>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.rail}>
        <Link className={styles.brand} href="/" aria-label="Tamishra Workspace home">T</Link>
        <button className={styles.railActive} aria-label="Chat">◉</button>
        <Link className={styles.railButton} href="/apps/meet" aria-label="Meet">⌁</Link>
        <Link className={styles.railButton} href="/apps/mail" aria-label="Patra">✉</Link>
        <span className={styles.railSpacer} />
        <span className={styles.avatarSmall}>
          {currentUser.displayName.slice(0, 2).toUpperCase()}
        </span>
      </aside>

      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <div>
            <span className={styles.kicker}>TAMISHRA</span>
            <strong>Chat</strong>
          </div>
          <button
            className={styles.iconButton}
            onClick={() => setCreateOpen((open) => !open)}
            aria-label="New conversation"
          >
            +
          </button>
        </div>

        {memberships.length > 1 ? (
          <select
            className={styles.organizationSelect}
            value={organizationId}
            onChange={(event) => void changeOrganization(event.target.value)}
          >
            {memberships.map(({ membership, organization }) => (
              <option key={membership.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </select>
        ) : (
          <div className={styles.organizationLabel}>
            {memberships[0]?.organization.name ?? "Workspace"}
          </div>
        )}

        <form className={styles.searchBox} onSubmit={search}>
          <span>⌕</span>
          <input
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              if (!event.target.value.trim()) setSearchResults(null);
            }}
            placeholder="Search messages"
            aria-label="Search messages"
          />
        </form>

        {createOpen && (
          <form className={styles.createCard} onSubmit={createConversation}>
            <div className={styles.segmented}>
              {(["channel", "direct", "group"] as CreateMode[]).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  className={createMode === mode ? styles.segmentActive : ""}
                  onClick={() => {
                    setCreateMode(mode);
                    setSelectedMembers([]);
                  }}
                >
                  {mode === "channel" ? "Channel" : mode === "direct" ? "DM" : "Group"}
                </button>
              ))}
            </div>

            {createMode !== "direct" && (
              <input
                className={styles.field}
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
                placeholder={createMode === "channel" ? "Channel name" : "Group name (optional)"}
              />
            )}
            {createMode === "channel" && (
              <input
                className={styles.field}
                value={createTopic}
                onChange={(event) => setCreateTopic(event.target.value)}
                placeholder="Topic (optional)"
              />
            )}

            {createMode !== "channel" && (
              <div className={styles.peoplePicker}>
                {directory
                  .filter((member) => member.user.id !== currentUser.id)
                  .map((member) => (
                    <label key={member.user.id}>
                      <input
                        type={createMode === "direct" ? "radio" : "checkbox"}
                        name={createMode === "direct" ? "direct-member" : undefined}
                        checked={selectedMembers.includes(member.user.id)}
                        onChange={() => {
                          if (createMode === "direct") setSelectedMembers([member.user.id]);
                          else toggleMember(member.user.id);
                        }}
                      />
                      <span className={styles.personAvatar}>
                        {member.user.displayName.slice(0, 2).toUpperCase()}
                      </span>
                      <span>
                        <strong>{member.user.displayName}</strong>
                        <small>{member.user.email}</small>
                      </span>
                    </label>
                  ))}
                {directory.filter((member) => member.user.id !== currentUser.id).length === 0 && (
                  <p className={styles.emptySmall}>No other organization members yet.</p>
                )}
              </div>
            )}

            <div className={styles.createActions}>
              <button type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
              <button type="submit" className={styles.createPrimary}>Create</button>
            </div>
          </form>
        )}

        <div className={styles.listHeader}>
          <span>{searchResults ? "SEARCH RESULTS" : "CONVERSATIONS"}</span>
          {searchResults && (
            <button onClick={() => setSearchResults(null)}>Clear</button>
          )}
        </div>

        <div className={styles.conversationList}>
          {searchResults ? (
            searchResults.map((result) => (
              <button
                key={result.message.id}
                className={styles.searchResult}
                onClick={() => void openConversation(result.conversation.id)}
              >
                <strong>{result.conversation.name || "Conversation"}</strong>
                <span>{result.message.authorDisplayName}</span>
                <p>{result.message.body}</p>
              </button>
            ))
          ) : (
            conversations.map((conversation) => (
              <button
                key={conversation.id}
                className={
                  styles.conversation +
                  (conversation.id === activeConversationId ? " " + styles.conversationActive : "")
                }
                onClick={() => void openConversation(conversation.id)}
              >
                <span className={styles.conversationIcon}>
                  {conversationIcon(conversation)}
                </span>
                <span className={styles.conversationText}>
                  <strong>{conversationTitle(conversation)}</strong>
                  <small>
                    {conversation.kind === "channel"
                      ? conversation.topic || "Channel"
                      : conversation.kind === "group"
                        ? conversation.memberCount + " members"
                        : "Direct message"}
                  </small>
                </span>
                {conversation.unreadCount > 0 && (
                  <span className={styles.badge}>{Math.min(99, conversation.unreadCount)}</span>
                )}
              </button>
            ))
          )}

          {!searchResults && conversations.length === 0 && (
            <div className={styles.emptySidebar}>
              <span>✦</span>
              <strong>Start the first conversation</strong>
              <p>Create a channel, direct message, or group chat.</p>
            </div>
          )}
        </div>
      </aside>

      <section className={styles.chatArea}>
        {activeConversation ? (
          <>
            <header className={styles.chatHeader}>
              <div className={styles.chatTitle}>
                <span className={styles.largeConversationIcon}>
                  {conversationIcon(activeConversation)}
                </span>
                <div>
                  <h1>{conversationTitle(activeConversation)}</h1>
                  <p>
                    {activeConversation.topic ||
                      (activeConversation.kind === "channel"
                        ? activeConversation.memberCount + " members"
                        : activeConversation.kind === "direct"
                          ? "Private conversation"
                          : activeConversation.memberCount + " members")}
                  </p>
                </div>
              </div>
              <div className={styles.headerActions}>
                <Link href="/apps/meet" className={styles.meetButton}>⌁ Start Meet</Link>
                <button className={styles.iconButton} aria-label="Conversation details">ⓘ</button>
              </div>
            </header>

            {error && <div className={styles.errorBanner}>{error}</div>}

            <div className={styles.messageScroll}>
              <div className={styles.messageIntro}>
                <span className={styles.introIcon}>{conversationIcon(activeConversation)}</span>
                <h2>{conversationTitle(activeConversation)}</h2>
                <p>
                  {activeConversation.kind === "channel"
                    ? "This is the beginning of this channel."
                    : "This conversation is private to its members."}
                </p>
              </div>

              {rootMessages.map((message) => {
                const replies = messages.filter(
                  (item) => item.parentMessageId === message.id
                ).length;
                return (
                  <article
                    key={message.id}
                    className={
                      styles.message +
                      (message.id === threadRootId ? " " + styles.messageSelected : "")
                    }
                  >
                    <span className={styles.messageAvatar}>
                      {message.authorDisplayName.slice(0, 2).toUpperCase()}
                    </span>
                    <div className={styles.messageBody}>
                      <div className={styles.messageMeta}>
                        <strong>{message.authorDisplayName}</strong>
                        <time>{formatTime(message.createdAt)}</time>
                        {message.editedAt && <span>edited</span>}
                      </div>
                      <p>{message.deletedAt ? "Message removed" : message.body}</p>
                      {!message.deletedAt && (
                        <div className={styles.messageFooter}>
                          {message.reactions.map((reaction) => (
                            <button
                              key={reaction.emoji}
                              className={reaction.reactedByMe ? styles.reactionActive : styles.reaction}
                              onClick={() => void toggleReaction(message, reaction.emoji)}
                            >
                              {reaction.emoji} {reaction.count}
                            </button>
                          ))}
                          {quickReactions
                            .filter((emoji) => !message.reactions.some((reaction) => reaction.emoji === emoji))
                            .slice(0, 1)
                            .map((emoji) => (
                              <button
                                key={emoji}
                                className={styles.reactionGhost}
                                onClick={() => void toggleReaction(message, emoji)}
                              >
                                {emoji}
                              </button>
                            ))}
                          <button
                            className={styles.threadButton}
                            onClick={() => setThreadRootId(message.id)}
                          >
                            {replies ? replies + (replies === 1 ? " reply" : " replies") : "Reply"}
                          </button>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            <form className={styles.composer} onSubmit={(event) => void sendMessage(event)}>
              <textarea
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                placeholder={"Message " + conversationTitle(activeConversation)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                rows={1}
              />
              <div className={styles.composerBar}>
                <span className={styles.composerHint}>Shift + Enter for a new line</span>
                <button type="submit" disabled={sending || !composer.trim()}>
                  {sending ? "Sending…" : "Send"}
                </button>
              </div>
            </form>
          </>
        ) : (
          <div className={styles.emptyMain}>
            <div className={styles.logo}>T</div>
            <h1>Tamishra Chat</h1>
            <p>Choose a conversation or create one to start collaborating.</p>
            <button onClick={() => setCreateOpen(true)}>New conversation</button>
          </div>
        )}
      </section>

      <aside className={styles.threadPane}>
        {threadRoot ? (
          <>
            <header className={styles.threadHeader}>
              <div>
                <span>THREAD</span>
                <strong>{threadReplies.length} replies</strong>
              </div>
              <button onClick={() => setThreadRootId("")}>×</button>
            </header>
            <div className={styles.threadScroll}>
              <article className={styles.threadRoot}>
                <strong>{threadRoot.authorDisplayName}</strong>
                <time>{formatTime(threadRoot.createdAt)}</time>
                <p>{threadRoot.body}</p>
              </article>
              {threadReplies.map((reply) => (
                <article className={styles.threadReply} key={reply.id}>
                  <span className={styles.messageAvatar}>
                    {reply.authorDisplayName.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <strong>{reply.authorDisplayName}</strong>
                    <time>{formatTime(reply.createdAt)}</time>
                    <p>{reply.body}</p>
                  </div>
                </article>
              ))}
            </div>
            <form
              className={styles.threadComposer}
              onSubmit={(event) => void sendMessage(event, threadRoot.id)}
            >
              <textarea
                rows={2}
                value={threadComposer}
                onChange={(event) => setThreadComposer(event.target.value)}
                placeholder="Reply in thread"
              />
              <button type="submit" disabled={sending || !threadComposer.trim()}>
                Reply
              </button>
            </form>
          </>
        ) : (
          <div className={styles.detailsPane}>
            <span className={styles.detailsGlyph}>✦</span>
            <strong>Conversation details</strong>
            <p>
              Open a thread to keep focused replies separate from the main conversation.
            </p>
            {activeConversation && (
              <div className={styles.detailStats}>
                <div><span>Type</span><strong>{activeConversation.kind}</strong></div>
                <div><span>Members</span><strong>{activeConversation.memberCount}</strong></div>
                <div><span>Unread</span><strong>{activeConversation.unreadCount}</strong></div>
              </div>
            )}
          </div>
        )}
      </aside>
    </main>
  );
}
