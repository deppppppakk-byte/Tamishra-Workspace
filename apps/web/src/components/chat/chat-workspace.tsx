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

function findMentionIds(
  value: string,
  directory: DirectoryMember[],
  allowedIds: Set<string>
) {
  const lower = value.toLowerCase();
  return directory
    .filter((member) => allowedIds.has(member.user.id))
    .filter((member) =>
      lower.includes("@" + member.user.displayName.toLowerCase())
    )
    .map((member) => member.user.id);
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
  const eventCursorRef = useRef("0");

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

  function mentionSuggestions(value: string) {
    const match = value.match(/(?:^|\s)@([^\s@]{0,40})$/);
    if (!match) return [] as DirectoryMember[];
    const query = match[1].toLowerCase();
    return directory
      .filter((member) => activeMemberIds.has(member.user.id))
      .filter((member) => member.user.id !== currentUser?.id)
      .filter(
        (member) =>
          !query || member.user.displayName.toLowerCase().includes(query)
      )
      .slice(0, 6);
  }

  function insertMention(
    member: DirectoryMember,
    target: "main" | "thread"
  ) {
    const setter = target === "main" ? setComposer : setThreadComposer;
    setter((current) =>
      current.replace(
        /(?:^|\s)@([^\s@]{0,40})$/,
        (matched) =>
          (matched.startsWith(" ") ? " " : "") +
          "@" +
          member.user.displayName +
          " "
      )
    );
  }


  useEffect(() => {
    void initialize();
  }, []);

  useEffect(() => {
    if (!organizationId || !currentUser) return;

    setRealtimeStatus("connecting");
    const source = new EventSource(
      workspaceApiBase +
        "/v1/chat/events?organizationId=" +
        encodeURIComponent(organizationId) +
        "&after=" +
        encodeURIComponent(eventCursorRef.current),
      { withCredentials: true }
    );

    source.onopen = () => setRealtimeStatus("live");
    source.onerror = () => setRealtimeStatus("offline");
    source.addEventListener("chat", (event) => {
      try {
        const chatEvent = JSON.parse((event as MessageEvent).data) as ChatEvent;
        eventCursorRef.current = chatEvent.id;
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
          loadConversations(firstOrganization),
          loadNotifications(firstOrganization),
          loadPresence(firstOrganization),
          heartbeatPresence(firstOrganization)
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

  async function loadNotifications(nextOrganizationId: string) {
    const response = await workspaceApi<{ notifications: ChatNotification[] }>(
      "/v1/chat/notifications?organizationId=" +
        encodeURIComponent(nextOrganizationId)
    );
    setNotifications(response.notifications);
  }

  async function loadPresence(nextOrganizationId: string) {
    const response = await workspaceApi<{ presence: ChatPresence[] }>(
      "/v1/chat/presence?organizationId=" +
        encodeURIComponent(nextOrganizationId)
    );
    setPresence(response.presence);
  }

  async function heartbeatPresence(nextOrganizationId: string) {
    await workspaceApi("/v1/chat/presence", {
      method: "POST",
      body: JSON.stringify({ organizationId: nextOrganizationId })
    }).catch(() => undefined);
  }

  async function loadConversationMembers(conversationId: string) {
    const response = await workspaceApi<{ members: ChatMember[] }>(
      "/v1/chat/conversations/" +
        encodeURIComponent(conversationId) +
        "/members"
    );
    setConversationMembers(response.members);
  }

  async function loadTyping(conversationId: string) {
    const response = await workspaceApi<{ typing: ChatTypingState[] }>(
      "/v1/chat/conversations/" +
        encodeURIComponent(conversationId) +
        "/typing"
    );
    setTyping(response.typing);
  }

  async function handleRealtimeEvent(event: ChatEvent) {
    if (event.type === "notification.created") {
      await loadNotifications(organizationId);
    }
    if (event.type === "presence.changed") {
      await loadPresence(organizationId);
    }
    if (event.type === "typing.changed" && activeConversationId) {
      await loadTyping(activeConversationId);
      return;
    }
    await loadConversations(organizationId, activeConversationId, false);
    if (
      activeConversationId &&
      (!event.conversationId || event.conversationId === activeConversationId)
    ) {
      await Promise.all([
        refreshMessages(activeConversationId, false),
        loadConversationMembers(activeConversationId),
        loadTyping(activeConversationId)
      ]);
    }
  }

  async function sendTyping(active: boolean) {
    if (!activeConversationId) return;
    const now = Date.now();
    if (active && now - typingLastSentRef.current < 1500) return;
    if (active) typingLastSentRef.current = now;
    await workspaceApi(
      "/v1/chat/conversations/" +
        encodeURIComponent(activeConversationId) +
        "/typing",
      {
        method: "POST",
        body: JSON.stringify({ active })
      }
    ).catch(() => undefined);
  }

  function noteTyping(value: string) {
    void sendTyping(Boolean(value.trim()));
    if (typingStopTimerRef.current) {
      window.clearTimeout(typingStopTimerRef.current);
    }
    typingStopTimerRef.current = window.setTimeout(() => {
      void sendTyping(false);
    }, 3500);
  }

  async function uploadFiles(files: File[]) {
    if (!activeConversationId) return [] as ChatAttachment[];
    const uploaded: ChatAttachment[] = [];
    for (const file of files.slice(0, MAX_ATTACHMENTS)) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(file.name + " exceeds the 10 MB Chat limit.");
      }
      const response = await fetch(
        workspaceApiBase +
          "/v1/chat/conversations/" +
          encodeURIComponent(activeConversationId) +
          "/files?name=" +
          encodeURIComponent(file.name),
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": file.type || "application/octet-stream"
          },
          body: file
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          typeof body?.error === "string" ? body.error : "file_upload_failed"
        );
      }
      uploaded.push(body.attachment as ChatAttachment);
    }
    return uploaded;
  }

  async function updateConversationSetting(
    setting: "muted" | "pinned",
    value: boolean
  ) {
    if (!activeConversationId) return;
    await workspaceApi(
      "/v1/chat/conversations/" +
        encodeURIComponent(activeConversationId) +
        "/settings",
      {
        method: "PATCH",
        body: JSON.stringify({ [setting]: value })
      }
    );
    await loadConversations(organizationId, activeConversationId, false);
  }

  async function openNotification(notification: ChatNotification) {
    if (!notification.readAt) {
      await workspaceApi(
        "/v1/chat/notifications/" +
          encodeURIComponent(notification.id) +
          "/read",
        { method: "POST", body: "{}" }
      ).catch(() => undefined);
    }
    setNotificationsOpen(false);
    await openConversation(notification.conversationId);
    await loadNotifications(organizationId);
  }

  async function markAllNotificationsRead() {
    await workspaceApi("/v1/chat/notifications/read-all", {
      method: "POST",
      body: JSON.stringify({ organizationId })
    });
    await loadNotifications(organizationId);
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
        await Promise.all([
          refreshMessages(nextActive),
          loadConversationMembers(nextActive),
          loadTyping(nextActive)
        ]);
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
    eventCursorRef.current = "0";
    setOrganizationId(nextOrganizationId);
    setActiveConversationId("");
    setMessages([]);
    setThreadRootId("");
    setSearchResults(null);
    setError("");
    try {
      await Promise.all([
        loadDirectory(nextOrganizationId),
        loadConversations(nextOrganizationId),
        loadNotifications(nextOrganizationId),
        loadPresence(nextOrganizationId),
        heartbeatPresence(nextOrganizationId)
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
      await Promise.all([
        refreshMessages(conversationId),
        loadConversationMembers(conversationId),
        loadTyping(conversationId)
      ]);
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
    const files = parentMessageId ? threadFiles : pendingFiles;
    if (!body && !files.length) return;

    setSending(true);
    setError("");
    try {
      const attachments = await uploadFiles(files);
      const mentions = findMentionIds(
        body,
        directory,
        activeMemberIds
      );
      await workspaceApi(
        "/v1/chat/conversations/" +
          encodeURIComponent(activeConversationId) +
          "/messages",
        {
          method: "POST",
          body: JSON.stringify({
            body,
            parentMessageId,
            mentions,
            attachments
          })
        }
      );
      void sendTyping(false);
      if (parentMessageId) {
        setThreadComposer("");
        setThreadFiles([]);
      } else {
        setComposer("");
        setPendingFiles([]);
      }
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
      <input
        ref={mainFileInputRef}
        className={styles.hiddenInput}
        type="file"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []).slice(0, MAX_ATTACHMENTS);
          setPendingFiles((current) => [...current, ...files].slice(0, MAX_ATTACHMENTS));
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={threadFileInputRef}
        className={styles.hiddenInput}
        type="file"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []).slice(0, MAX_ATTACHMENTS);
          setThreadFiles((current) => [...current, ...files].slice(0, MAX_ATTACHMENTS));
          event.currentTarget.value = "";
        }}
      />
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
            <span className={styles.realtimeState} data-state={realtimeStatus}>
              <i />
              {realtimeStatus === "live" ? "Live" : realtimeStatus === "connecting" ? "Connecting" : "Reconnecting"}
            </span>
          </div>
          <div className={styles.sidebarHeaderActions}>
            <button
              className={styles.notificationButton}
              onClick={() => setNotificationsOpen((open) => !open)}
              aria-label="Notifications"
            >
              ◔
              {unreadNotificationCount > 0 && (
                <span>{Math.min(99, unreadNotificationCount)}</span>
              )}
            </button>
            <button
              className={styles.iconButton}
              onClick={() => setCreateOpen((open) => !open)}
              aria-label="New conversation"
            >
              +
            </button>
          </div>
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

        {notificationsOpen && (
          <section className={styles.notificationPanel}>
            <header>
              <div>
                <strong>Notifications</strong>
                <span>{unreadNotificationCount} unread</span>
              </div>
              {unreadNotificationCount > 0 && (
                <button onClick={() => void markAllNotificationsRead()}>
                  Mark all read
                </button>
              )}
            </header>
            <div className={styles.notificationList}>
              {notifications.map((notification) => (
                <button
                  key={notification.id}
                  className={
                    styles.notificationItem +
                    (!notification.readAt ? " " + styles.notificationUnread : "")
                  }
                  onClick={() => void openNotification(notification)}
                >
                  <span className={styles.notificationGlyph}>
                    {notification.kind === "mention" ? "@" : notification.kind === "thread" ? "↳" : "•"}
                  </span>
                  <span>
                    <strong>{notification.title}</strong>
                    <p>{notification.bodyPreview}</p>
                    <small>{formatTime(notification.createdAt)}</small>
                  </span>
                </button>
              ))}
              {notifications.length === 0 && (
                <div className={styles.notificationEmpty}>No notifications yet.</div>
              )}
            </div>
          </section>
        )}

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
                  <strong>
                    {conversation.pinned && <span className={styles.pinGlyph}>◆</span>}
                    {conversationTitle(conversation)}
                  </strong>
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
                <button
                  className={activeConversation.pinned ? styles.controlActive : styles.controlButton}
                  onClick={() =>
                    void updateConversationSetting("pinned", !activeConversation.pinned)
                  }
                  aria-label={activeConversation.pinned ? "Unpin conversation" : "Pin conversation"}
                >
                  ◆
                </button>
                <button
                  className={activeConversation.muted ? styles.controlActive : styles.controlButton}
                  onClick={() =>
                    void updateConversationSetting("muted", !activeConversation.muted)
                  }
                  aria-label={activeConversation.muted ? "Unmute conversation" : "Mute conversation"}
                >
                  {activeConversation.muted ? "◒" : "◉"}
                </button>
                <Link href="/apps/meet" className={styles.meetButton}>⌁ Start Meet</Link>
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
                      {!message.deletedAt && message.attachments.length > 0 && (
                        <div className={styles.attachments}>
                          {message.attachments.map((attachment) => (
                            <a
                              key={attachment.id}
                              className={styles.attachmentCard}
                              href={
                                workspaceApiBase +
                                "/v1/chat/files/" +
                                encodeURIComponent(attachment.fileId ?? attachment.id)
                              }
                              target="_blank"
                              rel="noreferrer"
                            >
                              <span className={styles.attachmentIcon}>↧</span>
                              <span>
                                <strong>{attachment.name}</strong>
                                <small>{formatBytes(attachment.size)}</small>
                              </span>
                            </a>
                          ))}
                        </div>
                      )}
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

            <div className={styles.composerZone}>
              {typing.length > 0 && (
                <div className={styles.typingIndicator}>
                  <span>•••</span>
                  {typing.map((item) => item.displayName).join(", ")}
                  {typing.length === 1 ? " is typing" : " are typing"}
                </div>
              )}
              <form className={styles.composer} onSubmit={(event) => void sendMessage(event)}>
                {mainMentionSuggestions.length > 0 && (
                  <div className={styles.mentionMenu}>
                    {mainMentionSuggestions.map((member) => (
                      <button
                        type="button"
                        key={member.user.id}
                        onClick={() => insertMention(member, "main")}
                      >
                        <span className={styles.personAvatar}>
                          {member.user.displayName.slice(0, 2).toUpperCase()}
                        </span>
                        <span>
                          <strong>{member.user.displayName}</strong>
                          <small>{member.user.email}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {pendingFiles.length > 0 && (
                  <div className={styles.pendingFiles}>
                    {pendingFiles.map((file, index) => (
                      <span key={file.name + index}>
                        {file.name}
                        <button
                          type="button"
                          onClick={() =>
                            setPendingFiles((current) =>
                              current.filter((_, itemIndex) => itemIndex !== index)
                            )
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  value={composer}
                  onChange={(event) => {
                    setComposer(event.target.value);
                    noteTyping(event.target.value);
                  }}
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
                  <button
                    type="button"
                    className={styles.attachButton}
                    onClick={() => mainFileInputRef.current?.click()}
                    aria-label="Attach files"
                  >
                    ＋ File
                  </button>
                  <span className={styles.composerHint}>Use @ to mention · Shift + Enter for new line</span>
                  <button
                    type="submit"
                    disabled={sending || (!composer.trim() && pendingFiles.length === 0)}
                  >
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>
              </form>
            </div>
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
                {threadRoot.attachments.length > 0 && (
                  <div className={styles.attachments}>
                    {threadRoot.attachments.map((attachment) => (
                      <a
                        key={attachment.id}
                        className={styles.attachmentCard}
                        href={
                          workspaceApiBase +
                          "/v1/chat/files/" +
                          encodeURIComponent(attachment.fileId ?? attachment.id)
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className={styles.attachmentIcon}>↧</span>
                        <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></span>
                      </a>
                    ))}
                  </div>
                )}
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
                    {reply.attachments.length > 0 && (
                      <div className={styles.attachments}>
                        {reply.attachments.map((attachment) => (
                          <a
                            key={attachment.id}
                            className={styles.attachmentCard}
                            href={
                              workspaceApiBase +
                              "/v1/chat/files/" +
                              encodeURIComponent(attachment.fileId ?? attachment.id)
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            <span className={styles.attachmentIcon}>↧</span>
                            <span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size)}</small></span>
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
            <form
              className={styles.threadComposer}
              onSubmit={(event) => void sendMessage(event, threadRoot.id)}
            >
              {threadMentionSuggestions.length > 0 && (
                <div className={styles.mentionMenu}>
                  {threadMentionSuggestions.map((member) => (
                    <button
                      type="button"
                      key={member.user.id}
                      onClick={() => insertMention(member, "thread")}
                    >
                      <span className={styles.personAvatar}>
                        {member.user.displayName.slice(0, 2).toUpperCase()}
                      </span>
                      <span><strong>{member.user.displayName}</strong><small>{member.user.email}</small></span>
                    </button>
                  ))}
                </div>
              )}
              {threadFiles.length > 0 && (
                <div className={styles.pendingFiles}>
                  {threadFiles.map((file, index) => (
                    <span key={file.name + index}>
                      {file.name}
                      <button
                        type="button"
                        onClick={() =>
                          setThreadFiles((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index)
                          )
                        }
                      >×</button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                rows={2}
                value={threadComposer}
                onChange={(event) => {
                  setThreadComposer(event.target.value);
                  noteTyping(event.target.value);
                }}
                placeholder="Reply in thread"
              />
              <div className={styles.threadComposerActions}>
                <button
                  type="button"
                  className={styles.threadAttachButton}
                  onClick={() => threadFileInputRef.current?.click()}
                >
                  ＋ File
                </button>
                <button
                  type="submit"
                  disabled={sending || (!threadComposer.trim() && threadFiles.length === 0)}
                >
                  Reply
                </button>
              </div>
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
              <>
                <div className={styles.detailStats}>
                  <div><span>Type</span><strong>{activeConversation.kind}</strong></div>
                  <div><span>Members</span><strong>{activeConversation.memberCount}</strong></div>
                  <div><span>Unread</span><strong>{activeConversation.unreadCount}</strong></div>
                  <div><span>Notifications</span><strong>{activeConversation.muted ? "Muted" : "On"}</strong></div>
                </div>
                <div className={styles.memberPresenceList}>
                  {conversationMembers.map((member) => {
                    const person = directory.find((entry) => entry.user.id === member.userId);
                    const personPresence = presenceByUser.get(member.userId);
                    return (
                      <div key={member.userId}>
                        <span
                          className={styles.presenceDot}
                          data-status={personPresence?.status ?? "offline"}
                        />
                        <span>
                          <strong>{person?.user.displayName ?? "Workspace member"}</strong>
                          <small>{personPresence?.status ?? "offline"} · {member.role}</small>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </aside>
    </main>
  );
}
