import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ChatAttachment,
  ChatConversation,
  ChatConversationKind,
  ChatEventType,
  ChatMemberRole,
  ChatMessage,
  ChatNotificationKind
} from "@tamishra/chat-core";
import { hasPermission, type WorkspacePermission } from "@tamishra/permissions";
import {
  listWorkspaceOrganizationMembers,
  resolveWorkspaceAuthorization
} from "./identity.js";
import { createChatStore } from "./chat-store.js";

type JsonObject = Record<string, unknown>;

const store = createChatStore();
const MAX_BODY_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EVENT_POLL_MS = 900;
const EVENT_PING_MS = 15_000;

function isChatConversationKind(value: unknown): value is ChatConversationKind {
  return value === "channel" || value === "group" || value === "direct";
}

function isChatMemberRole(value: unknown): value is ChatMemberRole {
  return value === "owner" || value === "moderator" || value === "member";
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: JsonObject,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

async function readBinary(request: IncomingMessage, maxBytes = MAX_FILE_BYTES) {
  const length = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > maxBytes) {
    throw Object.assign(new Error("file_too_large"), { status: 413 });
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw Object.assign(new Error("file_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  if (!size) {
    throw Object.assign(new Error("file_empty"), { status: 400 });
  }
  return Buffer.concat(chunks);
}

function applyCors(
  response: ServerResponse,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
}

function safeDownloadName(value: string) {
  return value.replace(/[\r\n"]/g, "_").slice(0, 255) || "attachment";
}

function eventData(event: unknown) {
  return JSON.stringify(event).replace(/[\u2028\u2029]/g, " ");
}

function mutationOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>
) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

function cleanText(value: unknown, max: number) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .trim()
    .slice(0, max);
}

function cleanMessageBody(value: unknown) {
  return String(value ?? "")
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .slice(0, 20_000);
}

function stringArray(value: unknown, maxItems: number, maxLength = 128) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .slice(0, maxItems)
        .map((item) => cleanText(item, maxLength))
        .filter(Boolean)
    )
  );
}

function attachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const name = cleanText(record.name, 255);
    const mimeType = cleanText(record.mimeType, 120) || "application/octet-stream";
    const size = Number(record.size ?? 0);
    if (!name || !Number.isFinite(size) || size < 0) return [];

    const attachment: ChatAttachment = {
      id: cleanText(record.id, 128) || "attachment-" + index,
      name,
      mimeType,
      size: Math.floor(size)
    };
    const fileId = cleanText(record.fileId, 160);
    if (fileId) attachment.fileId = fileId;
    return [attachment];
  });
}

function errorStatus(error: unknown) {
  return Number((error as { status?: number }).status ?? 500);
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.message : "chat_error";
}

function decodeSegment(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function membershipForOrganization(
  authorization: Awaited<ReturnType<typeof resolveWorkspaceAuthorization>>,
  organizationId: string
) {
  if (!authorization) return null;
  return authorization.memberships.find(
    ({ membership }) =>
      membership.organizationId === organizationId && !membership.disabled
  ) ?? null;
}

function requireWorkspacePermission(
  role: "owner" | "admin" | "member" | "guest",
  permission: WorkspacePermission
) {
  if (!hasPermission(role, permission)) {
    throw Object.assign(new Error("permission_denied"), { status: 403 });
  }
}

async function canManageConversation(
  conversationId: string,
  userId: string,
  workspaceRole: "owner" | "admin" | "member" | "guest"
) {
  if (hasPermission(workspaceRole, "chat.manage")) return true;
  const members = await store.listMembers(conversationId);
  const member = members.find((item) => item.userId === userId);
  return member?.role === "owner" || member?.role === "moderator";
}

async function emitChatEvent(input: {
  organizationId: string;
  conversationId?: string | null;
  actorId?: string | null;
  targetUserId?: string | null;
  type: ChatEventType;
  payload?: Record<string, unknown>;
}) {
  return store.appendEvent(input);
}

async function createMessageNotifications(
  conversation: ChatConversation,
  message: ChatMessage,
  currentUserId: string
) {
  const members = await store.listMembers(conversation.id);
  const memberIds = new Set(members.map((member) => member.userId));
  const targets = new Map<string, ChatNotificationKind>();

  for (const mentionedUserId of message.mentions) {
    if (mentionedUserId !== currentUserId && memberIds.has(mentionedUserId)) {
      targets.set(mentionedUserId, "mention");
    }
  }

  if (conversation.kind === "direct") {
    for (const member of members) {
      if (member.userId !== currentUserId && !targets.has(member.userId)) {
        targets.set(member.userId, "direct");
      }
    }
  }

  if (message.parentMessageId) {
    const parent = await store.getMessageForUser(
      message.parentMessageId,
      currentUserId
    );
    if (
      parent &&
      parent.authorId !== currentUserId &&
      memberIds.has(parent.authorId) &&
      !targets.has(parent.authorId)
    ) {
      targets.set(parent.authorId, "thread");
    }
  }

  const preview = (message.body.trim() || "Shared an attachment").slice(0, 220);
  for (const [userId, kind] of targets) {
    const title =
      kind === "mention"
        ? message.authorDisplayName + " mentioned you"
        : kind === "thread"
          ? message.authorDisplayName + " replied to your thread"
          : message.authorDisplayName + " sent you a message";
    const notification = await store.createNotification({
      organizationId: conversation.organizationId,
      userId,
      conversationId: conversation.id,
      messageId: message.id,
      kind,
      title,
      bodyPreview: preview
    });
    await emitChatEvent({
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
      actorId: currentUserId,
      targetUserId: userId,
      type: "notification.created",
      payload: { notificationId: notification.id, messageId: message.id, kind }
    });
  }
}

function startEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    organizationId: string;
    userId: string;
    afterId: string;
    origin: string | undefined;
    allowedOrigins: ReadonlySet<string>;
  }
) {
  let cursor = /^\d+$/.test(options.afterId) ? options.afterId : "0";
  let closed = false;
  let polling = false;

  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  applyCors(response, options.origin, options.allowedOrigins);
  response.flushHeaders();
  response.write("retry: 2500\n\n");

  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const events = await store.listEvents(
        options.organizationId,
        options.userId,
        cursor,
        100
      );
      for (const event of events) {
        cursor = event.id;
        response.write(
          "id: " + event.id + "\n" +
          "event: chat\n" +
          "data: " + eventData(event) + "\n\n"
        );
      }
    } catch (error) {
      console.error("Chat event stream polling failed", error);
      response.write("event: error\ndata: {\"error\":\"event_poll_failed\"}\n\n");
    } finally {
      polling = false;
    }
  };

  const pollTimer = setInterval(() => void poll(), EVENT_POLL_MS);
  const pingTimer = setInterval(() => {
    if (!closed) response.write(": ping\n\n");
  }, EVENT_PING_MS);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(pingTimer);
  };
  request.on("close", cleanup);
  response.on("close", cleanup);
  void poll();
}

export async function handleChatRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/chat")) return false;

  try {
    await store.ready();
  } catch (error) {
    console.error("Chat store initialization failed", error);
    sendJson(response, 503, { error: "chat_store_unavailable" }, origin, allowedOrigins);
    return true;
  }

  const authorization = await resolveWorkspaceAuthorization(request);
  if (!authorization) {
    sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
    return true;
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    !mutationOriginAllowed(request, allowedOrigins)
  ) {
    sendJson(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  try {
    if (request.method === "GET" && url.pathname === "/v1/chat/events") {
      const organizationId = cleanText(url.searchParams.get("organizationId"), 128);
      const membership = membershipForOrganization(authorization, organizationId);
      if (!membership) {
        throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      }
      requireWorkspacePermission(membership.membership.role, "chat.read");
      const lastEventHeader = request.headers["last-event-id"];
      const lastEventId = Array.isArray(lastEventHeader)
        ? lastEventHeader[0]
        : lastEventHeader;
      const afterId =
        cleanText(url.searchParams.get("after"), 32) ||
        cleanText(lastEventId, 32) ||
        "0";
      startEventStream(request, response, {
        organizationId,
        userId: authorization.user.id,
        afterId,
        origin,
        allowedOrigins
      });
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/chat/notifications") {
      const organizationId = cleanText(url.searchParams.get("organizationId"), 128);
      const membership = membershipForOrganization(authorization, organizationId);
      if (!membership) {
        throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      }
      requireWorkspacePermission(membership.membership.role, "chat.read");
      const notifications = await store.listNotifications(
        organizationId,
        authorization.user.id,
        75
      );
      sendJson(response, 200, { notifications }, origin, allowedOrigins);
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/chat/notifications/read-all"
    ) {
      const body = await readJson(request);
      const organizationId = cleanText(body.organizationId, 128);
      const membership = membershipForOrganization(authorization, organizationId);
      if (!membership) {
        throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      }
      const updated = await store.markAllNotificationsRead(
        organizationId,
        authorization.user.id
      );
      sendJson(response, 200, { updated }, origin, allowedOrigins);
      return true;
    }

    const notificationReadMatch = url.pathname.match(
      /^\/v1\/chat\/notifications\/([^/]+)\/read$/
    );
    if (notificationReadMatch && request.method === "POST") {
      const notificationId = decodeSegment(notificationReadMatch[1]);
      const updated = await store.markNotificationRead(
        notificationId,
        authorization.user.id
      );
      sendJson(response, updated ? 200 : 404, { updated }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/presence") {
      const body = await readJson(request);
      const organizationId = cleanText(body.organizationId, 128);
      const membership = membershipForOrganization(authorization, organizationId);
      if (!membership) {
        throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      }
      requireWorkspacePermission(membership.membership.role, "chat.read");
      const presence = await store.heartbeatPresence(
        organizationId,
        authorization.user.id,
        authorization.user.displayName
      );
      await emitChatEvent({
        organizationId,
        actorId: authorization.user.id,
        type: "presence.changed",
        payload: { userId: authorization.user.id }
      });
      sendJson(response, 200, { presence }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/chat/presence") {
      const organizationId = cleanText(url.searchParams.get("organizationId"), 128);
      const membership = membershipForOrganization(authorization, organizationId);
      if (!membership) {
        throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      }
      requireWorkspacePermission(membership.membership.role, "chat.read");
      const presence = await store.listPresence(organizationId);
      sendJson(response, 200, { presence }, origin, allowedOrigins);
      return true;
    }

    const fileDownloadMatch = url.pathname.match(/^\/v1\/chat\/files\/([^/]+)$/);
    if (fileDownloadMatch && request.method === "GET") {
      const fileId = decodeSegment(fileDownloadMatch[1]);
      const file = await store.getFileForUser(fileId, authorization.user.id);
      if (!file) throw Object.assign(new Error("file_not_found"), { status: 404 });

      const contentType = /^[a-z0-9!#  try {
    if (request.method === "GET" && url.pathname === "/v1/chat/conversations") {^_.+-]+\/[a-z0-9!#  try {
    if (request.method === "GET" && url.pathname === "/v1/chat/conversations") {^_.+-]+$/i.test(
        file.mimeType
      )
        ? file.mimeType
        : "application/octet-stream";
      response.statusCode = 200;
      response.setHeader("content-type", contentType);
      response.setHeader("content-length", String(file.bytes.byteLength));
      response.setHeader(
        "content-disposition",
        'attachment; filename="' + safeDownloadName(file.name) + '"'
      );
      response.setHeader("cache-control", "private, max-age=300");
      response.setHeader("x-content-type-options", "nosniff");
      applyCors(response, origin, allowedOrigins);
      response.end(file.bytes);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/chat/conversations") {
      const organizationId = cleanText(url.searchParams.get("organizationId"), 128);
      const membership = membershipForOrganization(authorization, organizationId);
      if (!membership) throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      requireWorkspacePermission(membership.membership.role, "chat.read");

      const conversations = await store.listConversations(
        organizationId,
        authorization.user.id
      );
      sendJson(
        response,
        200,
        { persistence: store.kind, conversations },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/conversations") {
      const body = await readJson(request);
      const organizationId = cleanText(body.organizationId, 128);
      const membership = membershipForOrganization(authorization, organizationId);
      if (!membership) throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      requireWorkspacePermission(membership.membership.role, "chat.send");

      if (!isChatConversationKind(body.kind)) {
        throw Object.assign(new Error("invalid_conversation_kind"), { status: 400 });
      }

      let name = cleanText(body.name, 120);
      const topic = cleanText(body.topic, 500);
      if (body.kind === "channel" && name.length < 2) {
        throw Object.assign(new Error("channel_name_required"), { status: 400 });
      }

      const organizationMembers = await listWorkspaceOrganizationMembers(organizationId);
      const allowedMemberIds = new Set(organizationMembers.map(({ user }) => user.id));
      let requestedMemberIds = stringArray(body.memberIds, 100, 128)
        .filter((userId) => userId !== authorization.user.id);

      if (requestedMemberIds.some((userId) => !allowedMemberIds.has(userId))) {
        throw Object.assign(new Error("conversation_member_outside_organization"), { status: 400 });
      }
      if (body.kind === "direct" && requestedMemberIds.length !== 1) {
        throw Object.assign(new Error("direct_message_requires_one_member"), { status: 400 });
      }
      if (body.kind === "group" && requestedMemberIds.length < 1) {
        throw Object.assign(new Error("group_requires_members"), { status: 400 });
      }

      if (body.kind === "channel" && requestedMemberIds.length === 0) {
        requestedMemberIds = organizationMembers
          .map(({ user }) => user.id)
          .filter((userId) => userId !== authorization.user.id)
          .slice(0, 100);
      }

      if (body.kind === "direct") {
        const other = organizationMembers.find(
          ({ user }) => user.id === requestedMemberIds[0]
        )?.user;
        if (other) {
          name = [authorization.user.displayName, other.displayName]
            .sort((left, right) => left.localeCompare(right))
            .join(" · ")
            .slice(0, 120);
        }
      }

      const conversation = await store.createConversation({
        organizationId,
        kind: body.kind,
        name,
        topic,
        createdBy: authorization.user.id,
        memberIds: requestedMemberIds
      });
      await emitChatEvent({
        organizationId,
        conversationId: conversation.id,
        actorId: authorization.user.id,
        type: "conversation.created",
        payload: { conversationId: conversation.id, kind: conversation.kind }
      });

      sendJson(response, 201, { conversation }, origin, allowedOrigins);
      return true;
    }

    const conversationMembersMatch = url.pathname.match(
      /^\/v1\/chat\/conversations\/([^/]+)\/members$/
    );
    if (conversationMembersMatch && request.method === "GET") {
      const conversationId = decodeSegment(conversationMembersMatch[1]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      const membership = membershipForOrganization(authorization, conversation.organizationId);
      if (!membership) throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      requireWorkspacePermission(membership.membership.role, "chat.read");

      const members = await store.listMembers(conversationId);
      sendJson(response, 200, { members }, origin, allowedOrigins);
      return true;
    }

    if (conversationMembersMatch && request.method === "POST") {
      const conversationId = decodeSegment(conversationMembersMatch[1]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      const membership = membershipForOrganization(authorization, conversation.organizationId);
      if (!membership) throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      if (!(await canManageConversation(
        conversationId,
        authorization.user.id,
        membership.membership.role
      ))) {
        throw Object.assign(new Error("permission_denied"), { status: 403 });
      }

      const body = await readJson(request);
      const userId = cleanText(body.userId, 128);
      const role: ChatMemberRole = isChatMemberRole(body.role) ? body.role : "member";
      if (!userId) throw Object.assign(new Error("user_id_required"), { status: 400 });
      const organizationMembers = await listWorkspaceOrganizationMembers(
        conversation.organizationId
      );
      if (!organizationMembers.some(({ user }) => user.id === userId)) {
        throw Object.assign(new Error("conversation_member_outside_organization"), { status: 400 });
      }
      const member = await store.addMember(conversationId, userId, role);
      await emitChatEvent({
        organizationId: conversation.organizationId,
        conversationId,
        actorId: authorization.user.id,
        type: "member.changed",
        payload: { action: "added", userId, role }
      });
      sendJson(response, 201, { member }, origin, allowedOrigins);
      return true;
    }

    const removeMemberMatch = url.pathname.match(
      /^\/v1\/chat\/conversations\/([^/]+)\/members\/([^/]+)$/
    );
    if (removeMemberMatch && request.method === "DELETE") {
      const conversationId = decodeSegment(removeMemberMatch[1]);
      const targetUserId = decodeSegment(removeMemberMatch[2]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      const membership = membershipForOrganization(authorization, conversation.organizationId);
      if (!membership) throw Object.assign(new Error("organization_access_denied"), { status: 403 });

      const selfLeave = targetUserId === authorization.user.id;
      if (
        !selfLeave &&
        !(await canManageConversation(
          conversationId,
          authorization.user.id,
          membership.membership.role
        ))
      ) {
        throw Object.assign(new Error("permission_denied"), { status: 403 });
      }

      const removed = await store.removeMember(conversationId, targetUserId);
      if (removed) {
        await emitChatEvent({
          organizationId: conversation.organizationId,
          conversationId,
          actorId: authorization.user.id,
          type: "member.changed",
          payload: { action: "removed", userId: targetUserId }
        });
      }
      sendJson(response, removed ? 200 : 404, { removed }, origin, allowedOrigins);
      return true;
    }

    const conversationSettingsMatch = url.pathname.match(
      /^\/v1\/chat\/conversations\/([^/]+)\/settings$/
    );
    if (conversationSettingsMatch && request.method === "PATCH") {
      const conversationId = decodeSegment(conversationSettingsMatch[1]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) {
        throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      }
      const body = await readJson(request);
      const settings = {
        ...(typeof body.muted === "boolean" ? { muted: body.muted } : {}),
        ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {})
      };
      if (!Object.keys(settings).length) {
        throw Object.assign(new Error("settings_required"), { status: 400 });
      }
      const member = await store.updateMemberSettings(
        conversationId,
        authorization.user.id,
        settings
      );
      if (!member) {
        throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      }
      await emitChatEvent({
        organizationId: conversation.organizationId,
        conversationId,
        actorId: authorization.user.id,
        targetUserId: authorization.user.id,
        type: "settings.changed",
        payload: settings
      });
      sendJson(response, 200, { member }, origin, allowedOrigins);
      return true;
    }

    const conversationFileMatch = url.pathname.match(
      /^\/v1\/chat\/conversations\/([^/]+)\/files$/
    );
    if (conversationFileMatch && request.method === "POST") {
      const conversationId = decodeSegment(conversationFileMatch[1]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) {
        throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      }
      const membership = membershipForOrganization(
        authorization,
        conversation.organizationId
      );
      if (!membership) {
        throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      }
      requireWorkspacePermission(membership.membership.role, "chat.send");

      const name = cleanText(url.searchParams.get("name"), 255);
      if (!name) throw Object.assign(new Error("file_name_required"), { status: 400 });
      const rawContentType = Array.isArray(request.headers["content-type"])
        ? request.headers["content-type"][0]
        : request.headers["content-type"];
      const mimeType =
        cleanText(String(rawContentType ?? "").split(";")[0], 120) ||
        "application/octet-stream";
      const bytes = await readBinary(request);
      const attachment = await store.createFile({
        organizationId: conversation.organizationId,
        conversationId,
        uploaderId: authorization.user.id,
        name,
        mimeType,
        bytes
      });
      sendJson(response, 201, { attachment }, origin, allowedOrigins);
      return true;
    }

    const conversationTypingMatch = url.pathname.match(
      /^\/v1\/chat\/conversations\/([^/]+)\/typing$/
    );
    if (conversationTypingMatch && request.method === "GET") {
      const conversationId = decodeSegment(conversationTypingMatch[1]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) {
        throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      }
      const typing = (await store.listTyping(conversationId)).filter(
        (item) => item.userId !== authorization.user.id
      );
      sendJson(response, 200, { typing }, origin, allowedOrigins);
      return true;
    }

    if (conversationTypingMatch && request.method === "POST") {
      const conversationId = decodeSegment(conversationTypingMatch[1]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) {
        throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      }
      const body = await readJson(request);
      const active = body.active === true;
      const typing = await store.setTyping(
        conversationId,
        authorization.user.id,
        authorization.user.displayName,
        active
      );
      await emitChatEvent({
        organizationId: conversation.organizationId,
        conversationId,
        actorId: authorization.user.id,
        type: "typing.changed",
        payload: { userId: authorization.user.id, active }
      });
      sendJson(response, 200, { typing }, origin, allowedOrigins);
      return true;
    }

    const conversationMessagesMatch = url.pathname.match(
      /^\/v1\/chat\/conversations\/([^/]+)\/messages$/
    );
    if (conversationMessagesMatch && request.method === "GET") {
      const conversationId = decodeSegment(conversationMessagesMatch[1]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      const membership = membershipForOrganization(authorization, conversation.organizationId);
      if (!membership) throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      requireWorkspacePermission(membership.membership.role, "chat.read");

      const before = cleanText(url.searchParams.get("before"), 128) || null;
      const rawLimit = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.floor(rawLimit))) : 50;
      const messages = await store.listMessages(conversationId, authorization.user.id, {
        before,
        limit
      });
      sendJson(response, 200, { messages }, origin, allowedOrigins);
      return true;
    }

    if (conversationMessagesMatch && request.method === "POST") {
      const conversationId = decodeSegment(conversationMessagesMatch[1]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      const membership = membershipForOrganization(authorization, conversation.organizationId);
      if (!membership) throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      requireWorkspacePermission(membership.membership.role, "chat.send");

      const body = await readJson(request);
      const messageBody = cleanMessageBody(body.body);
      const messageAttachments = attachments(body.attachments);
      if (!messageBody.trim() && !messageAttachments.length) {
        throw Object.assign(new Error("message_content_required"), { status: 400 });
      }

      const message = await store.createMessage({
        conversationId,
        authorId: authorization.user.id,
        authorDisplayName: authorization.user.displayName,
        body: messageBody,
        parentMessageId: cleanText(body.parentMessageId, 128) || null,
        mentions: stringArray(body.mentions, 50, 128),
        attachments: messageAttachments
      });

      sendJson(response, 201, { message }, origin, allowedOrigins);
      return true;
    }

    const readMatch = url.pathname.match(
      /^\/v1\/chat\/conversations\/([^/]+)\/read$/
    );
    if (readMatch && request.method === "POST") {
      const conversationId = decodeSegment(readMatch[1]);
      const conversation = await store.getConversationForUser(
        conversationId,
        authorization.user.id
      );
      if (!conversation) throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      const body = await readJson(request);
      const member = await store.setRead(
        conversationId,
        authorization.user.id,
        cleanText(body.messageId, 128) || null
      );
      sendJson(response, 200, { member }, origin, allowedOrigins);
      return true;
    }

    const messageMatch = url.pathname.match(/^\/v1\/chat\/messages\/([^/]+)$/);
    if (messageMatch && request.method === "PATCH") {
      const messageId = decodeSegment(messageMatch[1]);
      const body = await readJson(request);
      const messageBody = cleanMessageBody(body.body);
      if (!messageBody.trim()) {
        throw Object.assign(new Error("message_content_required"), { status: 400 });
      }
      const message = await store.updateMessage(
        messageId,
        authorization.user.id,
        messageBody
      );
      if (!message) throw Object.assign(new Error("message_not_editable"), { status: 404 });
      sendJson(response, 200, { message }, origin, allowedOrigins);
      return true;
    }

    if (messageMatch && request.method === "DELETE") {
      const messageId = decodeSegment(messageMatch[1]);
      const message = await store.getMessageForUser(messageId, authorization.user.id);
      if (!message) throw Object.assign(new Error("message_not_found"), { status: 404 });
      const conversation = await store.getConversationForUser(
        message.conversationId,
        authorization.user.id
      );
      if (!conversation) throw Object.assign(new Error("conversation_not_found"), { status: 404 });
      const membership = membershipForOrganization(authorization, conversation.organizationId);
      if (!membership) throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      const allowModeration = hasPermission(membership.membership.role, "chat.manage");
      const deleted = await store.deleteMessage(
        messageId,
        authorization.user.id,
        allowModeration
      );
      sendJson(response, deleted ? 200 : 404, { deleted }, origin, allowedOrigins);
      return true;
    }

    const reactionMatch = url.pathname.match(
      /^\/v1\/chat\/messages\/([^/]+)\/reactions(?:\/([^/]+))?$/
    );
    if (reactionMatch && request.method === "POST" && !reactionMatch[2]) {
      const messageId = decodeSegment(reactionMatch[1]);
      const visibleMessage = await store.getMessageForUser(messageId, authorization.user.id);
      if (!visibleMessage) throw Object.assign(new Error("message_not_found"), { status: 404 });
      const body = await readJson(request);
      const emoji = cleanText(body.emoji, 32);
      if (!emoji) throw Object.assign(new Error("emoji_required"), { status: 400 });
      const reacted = await store.addReaction(messageId, authorization.user.id, emoji);
      sendJson(response, reacted ? 200 : 404, { reacted }, origin, allowedOrigins);
      return true;
    }

    if (reactionMatch && request.method === "DELETE" && reactionMatch[2]) {
      const messageId = decodeSegment(reactionMatch[1]);
      const visibleMessage = await store.getMessageForUser(messageId, authorization.user.id);
      if (!visibleMessage) throw Object.assign(new Error("message_not_found"), { status: 404 });
      const emoji = decodeSegment(reactionMatch[2]).slice(0, 32);
      const removed = await store.removeReaction(messageId, authorization.user.id, emoji);
      sendJson(response, removed ? 200 : 404, { removed }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/chat/search") {
      const organizationId = cleanText(url.searchParams.get("organizationId"), 128);
      const membership = membershipForOrganization(authorization, organizationId);
      if (!membership) throw Object.assign(new Error("organization_access_denied"), { status: 403 });
      requireWorkspacePermission(membership.membership.role, "chat.read");
      const query = cleanText(url.searchParams.get("q"), 200);
      if (query.length < 2) {
        sendJson(response, 200, { results: [] }, origin, allowedOrigins);
        return true;
      }
      const results = await store.searchMessages(
        organizationId,
        authorization.user.id,
        query
      );
      sendJson(response, 200, { results }, origin, allowedOrigins);
      return true;
    }

    sendJson(response, 404, { error: "not_found" }, origin, allowedOrigins);
    return true;
  } catch (error) {
    sendJson(
      response,
      errorStatus(error),
      { error: errorCode(error) },
      origin,
      allowedOrigins
    );
    return true;
  }
}
