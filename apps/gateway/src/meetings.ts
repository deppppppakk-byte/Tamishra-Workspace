import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import {
  createMeetingStore,
  type StoredMeeting,
  type StoredParticipant
} from "./meeting-store.js";
import { createMeetingCollaborationStore } from "./meeting-collaboration-store.js";

type JsonObject = Record<string, unknown>;

const store = createMeetingStore();
const collaboration = createMeetingCollaborationStore();
const MAX_BODY_BYTES = 32_768;
const MAX_PARTICIPANTS = 100;
const joinAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const allowedReactions = new Set(["👍", "👏", "🎉", "❤️", "😂", "✅"]);

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
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

function rawAccessKey() {
  return randomBytes(32).toString("base64url");
}

function hashAccessKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function participantId() {
  return "p_" + randomBytes(12).toString("hex");
}

function roomName() {
  return "meet-" + Date.now().toString(36) + "-" + randomBytes(5).toString("hex");
}

function candidateJoinCode() {
  let code = "";
  const bytes = randomBytes(10);
  for (let index = 0; index < 10; index += 1) {
    code += joinAlphabet[bytes[index] % joinAlphabet.length];
  }
  return code;
}

async function joinCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = candidateJoinCode();
    if (!(await store.findMeetingByJoinCode(code))) return code;
  }
  throw new Error("Unable to generate unique meeting code.");
}

function normalizeCode(value: unknown) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
}

function cleanName(value: unknown, fallback: string) {
  return String(value ?? fallback).trim().slice(0, 100) || fallback;
}

function cleanTitle(value: unknown) {
  return String(value ?? "Tamishra Meeting").trim().slice(0, 160) || "Tamishra Meeting";
}

function cleanMessage(value: unknown) {
  return String(value ?? "").trim().slice(0, 2000);
}

function normalizeReaction(value: unknown) {
  const reaction = String(value ?? "").trim();
  return allowedReactions.has(reaction) ? reaction : null;
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

async function findAccess(roomNameValue: string, key: string | null | undefined) {
  if (!key) return null;
  return store.findParticipantByAccessHash(
    roomNameValue,
    hashAccessKey(key)
  );
}

function publicContext(
  meeting: StoredMeeting,
  participant: StoredParticipant
) {
  return {
    roomName: meeting.roomName,
    participantId: participant.id,
    title: meeting.title,
    status: meeting.status,
    role: participant.role,
    admissionStatus: participant.admissionStatus,
    waitingRoomEnabled: meeting.waitingRoomEnabled,
    allowParticipantScreenShare: meeting.allowParticipantScreenShare,
    scheduledStartAt: meeting.scheduledStartAt,
    startedAt: meeting.startedAt,
    endedAt: meeting.endedAt,
    canEnter:
      meeting.status === "live" &&
      participant.admissionStatus === "admitted",
    persistence: store.kind,
    ephemeralStore: store.kind === "ephemeral-memory"
  };
}

function liveKitConfig() {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return null;
  const apiUrl = url
    .replace(/^wss:/i, "https:")
    .replace(/^ws:/i, "http:");
  return { url, apiUrl, apiKey, apiSecret };
}

async function removeFromLiveKit(roomNameValue: string, identity: string) {
  const livekit = liveKitConfig();
  if (!livekit) return false;
  const rooms = new RoomServiceClient(
    livekit.apiUrl,
    livekit.apiKey,
    livekit.apiSecret
  );
  await rooms.removeParticipant(roomNameValue, identity, {
    revokeTokenTs: BigInt(Date.now())
  });
  return true;
}

function meetingFromPath(pathname: string) {
  const match = pathname.match(/^\/v1\/meetings\/([^/]+)(?:\/(.+))?$/);
  if (!match) return null;

  return {
    roomName: decodeURIComponent(match[1]),
    action: match[2] ?? ""
  };
}

function statusFromError(error: unknown) {
  return Number((error as { status?: number }).status ?? 500);
}

export async function handleMeetingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (
    !url.pathname.startsWith("/v1/meet") &&
    !url.pathname.startsWith("/v1/meetings")
  ) {
    return false;
  }

  try {
    await store.ready();
    await collaboration.ready();
  } catch (error) {
    console.error("Workspace meeting store initialization failed", error);
    sendJson(
      response,
      503,
      { error: "meeting_store_unavailable" },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/meet/capabilities") {
    sendJson(
      response,
      200,
      {
        service: "tamishra-workspace-meet",
        nativeWorkspaceRuntime: true,
        persistence: store.kind,
        mediaProvider: "livekit",
        mediaConfigured: Boolean(liveKitConfig()),
        capabilities: {
          privateCodes: true,
          waitingRoom: true,
          audio: true,
          video: true,
          screenShare: true,
          chat: true,
          participantControls: true,
          scheduledMeetings: true,
          hostLifecycle: true,
          durableMeetings: store.kind === "postgres",
          persistentChat: true,
          reactions: true,
          handRaise: true,
          roomLock: true,
          participantRemoval: true,
          auditLog: true
        }
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/meetings") {
    try {
      const body = await readJson(request);
      const mode = body.mode === "scheduled" ? "scheduled" : "instant";
      const scheduledStartAt =
        mode === "scheduled" && body.scheduledStartAt
          ? new Date(String(body.scheduledStartAt))
          : null;

      if (scheduledStartAt && Number.isNaN(scheduledStartAt.getTime())) {
        sendJson(
          response,
          400,
          { error: "invalid_schedule" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const room = roomName();
      const code = await joinCode();
      const hostId = participantId();
      const hostKey = rawAccessKey();
      const now = new Date().toISOString();

      const meeting: StoredMeeting = {
        roomName: room,
        title: cleanTitle(body.title),
        status: mode === "instant" ? "live" : "scheduled",
        joinCode: code,
        scheduledStartAt: scheduledStartAt?.toISOString() ?? null,
        startedAt: mode === "instant" ? now : null,
        endedAt: null,
        waitingRoomEnabled: body.waitingRoomEnabled !== false,
        allowParticipantScreenShare: body.allowParticipantScreenShare !== false,
        createdAt: now
      };

      const host: StoredParticipant = {
        id: hostId,
        roomName: room,
        displayName: cleanName(body.displayName, "Host"),
        role: "host",
        accessKeyHash: hashAccessKey(hostKey),
        admissionStatus: "admitted",
        createdAt: now,
        lastSeenAt: now
      };

      await store.createMeeting(meeting, host);
      await collaboration.ensureRoom(meeting.roomName);
      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: host.id,
        actorDisplayName: host.displayName,
        eventType: "meeting_created",
        targetParticipantId: null,
        metadata: {
          mode,
          waitingRoomEnabled: meeting.waitingRoomEnabled,
          allowParticipantScreenShare: meeting.allowParticipantScreenShare
        }
      });

      sendJson(
        response,
        201,
        {
          meeting: publicContext(meeting, host),
          joinCode: code,
          accessKey: hostKey
        },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error
              ? error.message
              : "meeting_create_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && url.pathname === "/v1/meetings/join") {
    try {
      const body = await readJson(request);
      const code = normalizeCode(body.code);

      if (code.length !== 10) {
        sendJson(
          response,
          400,
          { error: "invalid_meeting_code" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const meeting = await store.findMeetingByJoinCode(code);

      if (!meeting) {
        sendJson(
          response,
          404,
          { error: "meeting_not_found" },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (meeting.status === "ended" || meeting.status === "cancelled") {
        sendJson(
          response,
          410,
          { error: "meeting_closed" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const controls = await collaboration.getControls(meeting.roomName);
      if (controls.locked) {
        sendJson(
          response,
          423,
          { error: "meeting_locked" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const currentParticipants = await store.listParticipants(
        meeting.roomName
      );
      const participantCount = currentParticipants.filter(
        (participant) => participant.role === "participant"
      ).length;

      if (participantCount >= MAX_PARTICIPANTS) {
        sendJson(
          response,
          403,
          { error: "meeting_capacity_reached" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const id = participantId();
      const key = rawAccessKey();
      const now = new Date().toISOString();

      const participant: StoredParticipant = {
        id,
        roomName: meeting.roomName,
        displayName: cleanName(body.displayName, "Participant"),
        role: "participant",
        accessKeyHash: hashAccessKey(key),
        admissionStatus: meeting.waitingRoomEnabled
          ? "waiting"
          : "admitted",
        createdAt: now,
        lastSeenAt: now
      };

      await store.addParticipant(participant);
      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: participant.id,
        actorDisplayName: participant.displayName,
        eventType: "join_requested",
        targetParticipantId: null,
        metadata: {
          admissionStatus: participant.admissionStatus
        }
      });

      sendJson(
        response,
        200,
        {
          meeting: publicContext(meeting, participant),
          accessKey: key
        },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error
              ? error.message
              : "meeting_join_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  const parsed = meetingFromPath(url.pathname);
  if (!parsed) return false;

  const meeting = await store.getMeeting(parsed.roomName);

  if (!meeting) {
    sendJson(
      response,
      404,
      { error: "meeting_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && parsed.action === "context") {
    const participant = await findAccess(
      meeting.roomName,
      url.searchParams.get("accessKey")
    );

    if (!participant) {
      sendJson(
        response,
        401,
        { error: "invalid_meeting_access" },
        origin,
        allowedOrigins
      );
      return true;
    }

    await store.updateParticipantPresence(
      meeting.roomName,
      participant.id
    );

    sendJson(
      response,
      200,
      { meeting: publicContext(meeting, participant) },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && parsed.action === "participants") {
    const host = await findAccess(
      meeting.roomName,
      url.searchParams.get("accessKey")
    );

    if (!host || host.role !== "host") {
      sendJson(
        response,
        403,
        { error: "host_access_required" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const participants = await store.listParticipants(meeting.roomName);

    sendJson(
      response,
      200,
      {
        participants: participants.map((participant) => ({
          id: participant.id,
          displayName: participant.displayName,
          role: participant.role,
          admissionStatus: participant.admissionStatus,
          createdAt: participant.createdAt,
          lastSeenAt: participant.lastSeenAt
        }))
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && parsed.action === "collaboration") {
    const participant = await findAccess(
      meeting.roomName,
      url.searchParams.get("accessKey")
    );

    if (!participant) {
      sendJson(
        response,
        401,
        { error: "invalid_meeting_access" },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      participant.admissionStatus !== "admitted" ||
      meeting.status !== "live"
    ) {
      sendJson(
        response,
        403,
        { error: "meeting_collaboration_unavailable" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const [controls, messages, signals] = await Promise.all([
      collaboration.getControls(meeting.roomName),
      collaboration.listMessages(meeting.roomName, 120),
      collaboration.listSignals(meeting.roomName)
    ]);

    sendJson(
      response,
      200,
      { controls, messages, signals },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "POST" && parsed.action === "chat") {
    try {
      const body = await readJson(request);
      const participant = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (
        !participant ||
        participant.admissionStatus !== "admitted" ||
        meeting.status !== "live"
      ) {
        sendJson(
          response,
          403,
          { error: "meeting_chat_unavailable" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const controls = await collaboration.getControls(meeting.roomName);
      if (!controls.chatEnabled) {
        sendJson(
          response,
          403,
          { error: "meeting_chat_disabled" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const messageText = cleanMessage(body.message);
      if (!messageText) {
        sendJson(
          response,
          400,
          { error: "message_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const message = await collaboration.addMessage(
        meeting.roomName,
        participant.id,
        participant.displayName,
        messageText
      );

      sendJson(
        response,
        201,
        { message },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error ? error.message : "meeting_chat_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "signal") {
    try {
      const body = await readJson(request);
      const participant = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (
        !participant ||
        participant.admissionStatus !== "admitted" ||
        meeting.status !== "live"
      ) {
        sendJson(
          response,
          403,
          { error: "meeting_signal_unavailable" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const controls = await collaboration.getControls(meeting.roomName);
      const handRaised =
        controls.handRaiseEnabled && body.handRaised === true;
      const reaction = controls.reactionsEnabled
        ? normalizeReaction(body.reaction)
        : null;

      const signal = await collaboration.setSignal(
        meeting.roomName,
        participant.id,
        participant.displayName,
        handRaised,
        reaction
      );

      sendJson(
        response,
        200,
        { signal },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error ? error.message : "meeting_signal_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "controls") {
    try {
      const body = await readJson(request);
      const host = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!host || host.role !== "host") {
        sendJson(
          response,
          403,
          { error: "host_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const patch: {
        locked?: boolean;
        chatEnabled?: boolean;
        reactionsEnabled?: boolean;
        handRaiseEnabled?: boolean;
      } = {};

      if (typeof body.locked === "boolean") patch.locked = body.locked;
      if (typeof body.chatEnabled === "boolean") {
        patch.chatEnabled = body.chatEnabled;
      }
      if (typeof body.reactionsEnabled === "boolean") {
        patch.reactionsEnabled = body.reactionsEnabled;
      }
      if (typeof body.handRaiseEnabled === "boolean") {
        patch.handRaiseEnabled = body.handRaiseEnabled;
      }

      const controls = await collaboration.updateControls(
        meeting.roomName,
        patch
      );

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: host.id,
        actorDisplayName: host.displayName,
        eventType: "controls_updated",
        targetParticipantId: null,
        metadata: patch
      });

      sendJson(
        response,
        200,
        { controls },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error ? error.message : "controls_update_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "moderate") {
    try {
      const body = await readJson(request);
      const host = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!host || host.role !== "host") {
        sendJson(
          response,
          403,
          { error: "host_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const targetId = String(body.participantId ?? "");
      const participants = await store.listParticipants(meeting.roomName);
      const target = participants.find(
        (participant) =>
          participant.id === targetId && participant.role !== "host"
      );

      if (!target) {
        sendJson(
          response,
          404,
          { error: "participant_not_found" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const action = String(body.action ?? "");

      if (action === "clear-hand") {
        const signal = await collaboration.setSignal(
          meeting.roomName,
          target.id,
          target.displayName,
          false,
          null
        );

        await collaboration.appendAudit({
          roomName: meeting.roomName,
          actorParticipantId: host.id,
          actorDisplayName: host.displayName,
          eventType: "hand_raise_cleared",
          targetParticipantId: target.id,
          metadata: {}
        });

        sendJson(
          response,
          200,
          { ok: true, signal },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (action !== "remove") {
        sendJson(
          response,
          400,
          { error: "invalid_moderation_action" },
          origin,
          allowedOrigins
        );
        return true;
      }

      await store.updateAdmission(
        meeting.roomName,
        target.id,
        "denied"
      );
      await store.leaveAttendance(meeting.roomName, target.id);
      await collaboration.setSignal(
        meeting.roomName,
        target.id,
        target.displayName,
        false,
        null
      );

      let disconnected = false;
      try {
        disconnected = await removeFromLiveKit(
          meeting.roomName,
          target.id
        );
      } catch (error) {
        console.warn("Unable to remove LiveKit participant", error);
      }

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: host.id,
        actorDisplayName: host.displayName,
        eventType: "participant_removed",
        targetParticipantId: target.id,
        metadata: { disconnected }
      });

      sendJson(
        response,
        200,
        {
          ok: true,
          participantId: target.id,
          disconnected
        },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error ? error.message : "moderation_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "GET" && parsed.action === "audit") {
    const host = await findAccess(
      meeting.roomName,
      url.searchParams.get("accessKey")
    );

    if (!host || host.role !== "host") {
      sendJson(
        response,
        403,
        { error: "host_access_required" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const audit = await collaboration.listAudit(meeting.roomName, 150);
    sendJson(
      response,
      200,
      { audit },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && parsed.action === "attendance") {
    const host = await findAccess(
      meeting.roomName,
      url.searchParams.get("accessKey")
    );

    if (!host || host.role !== "host") {
      sendJson(
        response,
        403,
        { error: "host_access_required" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const attendance = await store.listAttendance(meeting.roomName);

    sendJson(
      response,
      200,
      {
        attendance: attendance.map((entry) => ({
          participantId: entry.participantId,
          displayName: entry.displayName,
          joinedAt: entry.joinedAt,
          lastSeenAt: entry.lastSeenAt,
          leftAt: entry.leftAt
        }))
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "POST" && parsed.action === "heartbeat") {
    try {
      const body = await readJson(request);
      const participant = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!participant) {
        sendJson(
          response,
          401,
          { error: "invalid_meeting_access" },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (
        meeting.status !== "live" ||
        participant.admissionStatus !== "admitted"
      ) {
        sendJson(
          response,
          409,
          { error: "meeting_not_enterable" },
          origin,
          allowedOrigins
        );
        return true;
      }

      await store.updateParticipantPresence(
        meeting.roomName,
        participant.id
      );
      const attendance = await store.heartbeatAttendance(
        meeting.roomName,
        participant.id
      );

      sendJson(
        response,
        200,
        { ok: true, attendance },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error
              ? error.message
              : "attendance_heartbeat_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "leave") {
    try {
      const body = await readJson(request);
      const participant = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!participant) {
        sendJson(
          response,
          401,
          { error: "invalid_meeting_access" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const attendance = await store.leaveAttendance(
        meeting.roomName,
        participant.id
      );

      sendJson(
        response,
        200,
        { ok: true, attendance },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error ? error.message : "attendance_leave_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "admission") {
    try {
      const body = await readJson(request);
      const host = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!host || host.role !== "host") {
        sendJson(
          response,
          403,
          { error: "host_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const status =
        body.status === "denied"
          ? "denied"
          : body.status === "admitted"
            ? "admitted"
            : null;

      if (!status) {
        sendJson(
          response,
          400,
          { error: "invalid_admission_status" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const target = await store.updateAdmission(
        meeting.roomName,
        String(body.participantId ?? ""),
        status
      );

      if (!target) {
        sendJson(
          response,
          404,
          { error: "participant_not_found" },
          origin,
          allowedOrigins
        );
        return true;
      }

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: host.id,
        actorDisplayName: host.displayName,
        eventType:
          target.admissionStatus === "admitted"
            ? "participant_admitted"
            : "participant_denied",
        targetParticipantId: target.id,
        metadata: {}
      });

      sendJson(
        response,
        200,
        {
          participant: {
            id: target.id,
            displayName: target.displayName,
            admissionStatus: target.admissionStatus
          }
        },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error
              ? error.message
              : "admission_update_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "lifecycle") {
    try {
      const body = await readJson(request);
      const host = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!host || host.role !== "host") {
        sendJson(
          response,
          403,
          { error: "host_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const action = String(body.action ?? "");
      const updated =
        action === "start"
          ? await store.startMeeting(meeting.roomName)
          : action === "end"
            ? await store.endMeeting(meeting.roomName)
            : null;

      if (!updated) {
        sendJson(
          response,
          action === "start" || action === "end" ? 404 : 400,
          {
            error:
              action === "start" || action === "end"
                ? "meeting_not_found"
                : "invalid_lifecycle_action"
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: host.id,
        actorDisplayName: host.displayName,
        eventType:
          action === "start" ? "meeting_started" : "meeting_ended",
        targetParticipantId: null,
        metadata: {}
      });

      sendJson(
        response,
        200,
        { meeting: publicContext(updated, host) },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error
              ? error.message
              : "meeting_lifecycle_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "token") {
    try {
      const body = await readJson(request);
      const participant = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!participant) {
        sendJson(
          response,
          401,
          { error: "invalid_meeting_access" },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (meeting.status !== "live") {
        sendJson(
          response,
          409,
          { error: "meeting_not_live" },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (participant.admissionStatus !== "admitted") {
        sendJson(
          response,
          403,
          {
            error: "waiting_for_admission",
            admissionStatus: participant.admissionStatus
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      const livekit = liveKitConfig();

      if (!livekit) {
        sendJson(
          response,
          503,
          { error: "livekit_not_configured" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const displayName = cleanName(
        body.displayName,
        participant.displayName
      );

      await store.updateParticipantPresence(
        meeting.roomName,
        participant.id,
        displayName
      );

      const token = new AccessToken(
        livekit.apiKey,
        livekit.apiSecret,
        {
          identity: participant.id,
          name: displayName,
          ttl: "2h"
        }
      );

      const canShareScreen =
        participant.role === "host" ||
        meeting.allowParticipantScreenShare;

      const publishSources =
        participant.role === "host"
          ? undefined
          : [
              TrackSource.MICROPHONE,
              TrackSource.CAMERA,
              ...(canShareScreen
                ? [
                    TrackSource.SCREEN_SHARE,
                    TrackSource.SCREEN_SHARE_AUDIO
                  ]
                : [])
            ];

      token.addGrant({
        roomJoin: true,
        room: meeting.roomName,
        canPublish: true,
        canPublishSources: publishSources,
        canSubscribe: true,
        canPublishData: true,
        roomAdmin: participant.role === "host"
      });

      sendJson(
        response,
        200,
        {
          token: await token.toJwt(),
          url: livekit.url,
          role: participant.role,
          allowParticipantScreenShare: canShareScreen
        },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        statusFromError(error),
        {
          error:
            error instanceof Error
              ? error.message
              : "meeting_token_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  return false;
}
