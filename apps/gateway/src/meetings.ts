import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AccessToken } from "livekit-server-sdk";

type MeetingStatus = "scheduled" | "live" | "ended" | "cancelled";
type MeetingRole = "host" | "participant";
type AdmissionStatus = "waiting" | "admitted" | "denied";

type ParticipantRecord = {
  id: string;
  displayName: string;
  role: MeetingRole;
  accessKey: string;
  admissionStatus: AdmissionStatus;
  createdAt: string;
  lastSeenAt: string;
};

type MeetingRecord = {
  roomName: string;
  title: string;
  status: MeetingStatus;
  joinCode: string;
  scheduledStartAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  waitingRoomEnabled: boolean;
  allowParticipantScreenShare: boolean;
  createdAt: string;
  hostParticipantId: string;
  participants: Map<string, ParticipantRecord>;
};

type JsonObject = Record<string, unknown>;

const meetings = new Map<string, MeetingRecord>();
const roomByJoinCode = new Map<string, string>();

const MAX_BODY_BYTES = 32_768;
const joinAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function sendJson(
  response: ServerResponse,
  status: number,
  body: JsonObject,
  origin: string | undefined,
  allowedOrigin: string
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (origin && origin === allowedOrigin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

function accessKey() {
  return randomBytes(32).toString("base64url");
}

function participantId() {
  return "p_" + randomBytes(12).toString("hex");
}

function roomName() {
  return "meet-" + Date.now().toString(36) + "-" + randomBytes(5).toString("hex");
}

function joinCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let code = "";
    const bytes = randomBytes(10);
    for (let index = 0; index < 10; index += 1) {
      code += joinAlphabet[bytes[index] % joinAlphabet.length];
    }
    if (!roomByJoinCode.has(code)) return code;
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

function findAccess(
  meeting: MeetingRecord,
  key: string | null | undefined
) {
  if (!key) return null;
  for (const participant of meeting.participants.values()) {
    if (participant.accessKey === key) return participant;
  }
  return null;
}

function publicContext(meeting: MeetingRecord, participant: ParticipantRecord) {
  participant.lastSeenAt = new Date().toISOString();
  return {
    roomName: meeting.roomName,
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
    ephemeralStore: true
  };
}

function liveKitConfig() {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

function meetingFromPath(pathname: string) {
  const match = pathname.match(/^\/v1\/meetings\/([^/]+)(?:\/(.+))?$/);
  if (!match) return null;
  return {
    roomName: decodeURIComponent(match[1]),
    action: match[2] ?? ""
  };
}

export async function handleMeetingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigin: string
) {
  if (request.method === "GET" && url.pathname === "/v1/meet/capabilities") {
    sendJson(response, 200, {
      service: "tamishra-workspace-meet",
      nativeWorkspaceRuntime: true,
      persistence: "ephemeral-memory",
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
        hostLifecycle: true
      }
    }, origin, allowedOrigin);
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
        sendJson(response, 400, { error: "invalid_schedule" }, origin, allowedOrigin);
        return true;
      }

      const room = roomName();
      const code = joinCode();
      const hostId = participantId();
      const hostKey = accessKey();
      const now = new Date().toISOString();

      const host: ParticipantRecord = {
        id: hostId,
        displayName: cleanName(body.displayName, "Host"),
        role: "host",
        accessKey: hostKey,
        admissionStatus: "admitted",
        createdAt: now,
        lastSeenAt: now
      };

      const meeting: MeetingRecord = {
        roomName: room,
        title: cleanTitle(body.title),
        status: mode === "instant" ? "live" : "scheduled",
        joinCode: code,
        scheduledStartAt: scheduledStartAt?.toISOString() ?? null,
        startedAt: mode === "instant" ? now : null,
        endedAt: null,
        waitingRoomEnabled: body.waitingRoomEnabled !== false,
        allowParticipantScreenShare: body.allowParticipantScreenShare !== false,
        createdAt: now,
        hostParticipantId: hostId,
        participants: new Map([[hostId, host]])
      };

      meetings.set(room, meeting);
      roomByJoinCode.set(code, room);

      sendJson(response, 201, {
        meeting: publicContext(meeting, host),
        joinCode: code,
        accessKey: hostKey
      }, origin, allowedOrigin);
      return true;
    } catch (error) {
      const status = Number((error as { status?: number }).status ?? 500);
      sendJson(response, status, {
        error: error instanceof Error ? error.message : "meeting_create_failed"
      }, origin, allowedOrigin);
      return true;
    }
  }

  if (request.method === "POST" && url.pathname === "/v1/meetings/join") {
    try {
      const body = await readJson(request);
      const code = normalizeCode(body.code);
      if (code.length !== 10) {
        sendJson(response, 400, { error: "invalid_meeting_code" }, origin, allowedOrigin);
        return true;
      }

      const room = roomByJoinCode.get(code);
      const meeting = room ? meetings.get(room) : undefined;
      if (!meeting) {
        sendJson(response, 404, { error: "meeting_not_found" }, origin, allowedOrigin);
        return true;
      }
      if (meeting.status === "ended" || meeting.status === "cancelled") {
        sendJson(response, 410, { error: "meeting_closed" }, origin, allowedOrigin);
        return true;
      }

      const id = participantId();
      const key = accessKey();
      const now = new Date().toISOString();
      const participant: ParticipantRecord = {
        id,
        displayName: cleanName(body.displayName, "Participant"),
        role: "participant",
        accessKey: key,
        admissionStatus: meeting.waitingRoomEnabled ? "waiting" : "admitted",
        createdAt: now,
        lastSeenAt: now
      };
      meeting.participants.set(id, participant);

      sendJson(response, 200, {
        meeting: publicContext(meeting, participant),
        accessKey: key
      }, origin, allowedOrigin);
      return true;
    } catch (error) {
      const status = Number((error as { status?: number }).status ?? 500);
      sendJson(response, status, {
        error: error instanceof Error ? error.message : "meeting_join_failed"
      }, origin, allowedOrigin);
      return true;
    }
  }

  const parsed = meetingFromPath(url.pathname);
  if (!parsed) return false;

  const meeting = meetings.get(parsed.roomName);
  if (!meeting) {
    sendJson(response, 404, { error: "meeting_not_found" }, origin, allowedOrigin);
    return true;
  }

  if (request.method === "GET" && parsed.action === "context") {
    const participant = findAccess(meeting, url.searchParams.get("accessKey"));
    if (!participant) {
      sendJson(response, 401, { error: "invalid_meeting_access" }, origin, allowedOrigin);
      return true;
    }
    sendJson(response, 200, {
      meeting: publicContext(meeting, participant)
    }, origin, allowedOrigin);
    return true;
  }

  if (request.method === "GET" && parsed.action === "participants") {
    const host = findAccess(meeting, url.searchParams.get("accessKey"));
    if (!host || host.role !== "host") {
      sendJson(response, 403, { error: "host_access_required" }, origin, allowedOrigin);
      return true;
    }
    sendJson(response, 200, {
      participants: Array.from(meeting.participants.values()).map((participant) => ({
        id: participant.id,
        displayName: participant.displayName,
        role: participant.role,
        admissionStatus: participant.admissionStatus,
        createdAt: participant.createdAt,
        lastSeenAt: participant.lastSeenAt
      }))
    }, origin, allowedOrigin);
    return true;
  }

  if (request.method === "POST" && parsed.action === "admission") {
    try {
      const body = await readJson(request);
      const host = findAccess(meeting, String(body.accessKey ?? ""));
      if (!host || host.role !== "host") {
        sendJson(response, 403, { error: "host_access_required" }, origin, allowedOrigin);
        return true;
      }
      const target = meeting.participants.get(String(body.participantId ?? ""));
      if (!target || target.role === "host") {
        sendJson(response, 404, { error: "participant_not_found" }, origin, allowedOrigin);
        return true;
      }
      const status =
        body.status === "denied" ? "denied" :
        body.status === "admitted" ? "admitted" : null;
      if (!status) {
        sendJson(response, 400, { error: "invalid_admission_status" }, origin, allowedOrigin);
        return true;
      }
      target.admissionStatus = status;
      sendJson(response, 200, {
        participant: {
          id: target.id,
          displayName: target.displayName,
          admissionStatus: target.admissionStatus
        }
      }, origin, allowedOrigin);
      return true;
    } catch (error) {
      const status = Number((error as { status?: number }).status ?? 500);
      sendJson(response, status, {
        error: error instanceof Error ? error.message : "admission_update_failed"
      }, origin, allowedOrigin);
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "lifecycle") {
    try {
      const body = await readJson(request);
      const host = findAccess(meeting, String(body.accessKey ?? ""));
      if (!host || host.role !== "host") {
        sendJson(response, 403, { error: "host_access_required" }, origin, allowedOrigin);
        return true;
      }
      const action = String(body.action ?? "");
      if (action === "start") {
        meeting.status = "live";
        meeting.startedAt ??= new Date().toISOString();
      } else if (action === "end") {
        meeting.status = "ended";
        meeting.endedAt = new Date().toISOString();
      } else {
        sendJson(response, 400, { error: "invalid_lifecycle_action" }, origin, allowedOrigin);
        return true;
      }
      sendJson(response, 200, {
        meeting: publicContext(meeting, host)
      }, origin, allowedOrigin);
      return true;
    } catch (error) {
      const status = Number((error as { status?: number }).status ?? 500);
      sendJson(response, status, {
        error: error instanceof Error ? error.message : "meeting_lifecycle_failed"
      }, origin, allowedOrigin);
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "token") {
    try {
      const body = await readJson(request);
      const participant = findAccess(meeting, String(body.accessKey ?? ""));
      if (!participant) {
        sendJson(response, 401, { error: "invalid_meeting_access" }, origin, allowedOrigin);
        return true;
      }
      if (meeting.status !== "live") {
        sendJson(response, 409, { error: "meeting_not_live" }, origin, allowedOrigin);
        return true;
      }
      if (participant.admissionStatus !== "admitted") {
        sendJson(response, 403, {
          error: "waiting_for_admission",
          admissionStatus: participant.admissionStatus
        }, origin, allowedOrigin);
        return true;
      }

      const livekit = liveKitConfig();
      if (!livekit) {
        sendJson(response, 503, { error: "livekit_not_configured" }, origin, allowedOrigin);
        return true;
      }

      const displayName = cleanName(body.displayName, participant.displayName);
      participant.displayName = displayName;
      participant.lastSeenAt = new Date().toISOString();

      const token = new AccessToken(
        livekit.apiKey,
        livekit.apiSecret,
        {
          identity: participant.id,
          name: displayName,
          ttl: "2h"
        }
      );
      token.addGrant({
        roomJoin: true,
        room: meeting.roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true
      });

      sendJson(response, 200, {
        token: await token.toJwt(),
        url: livekit.url,
        role: participant.role,
        allowParticipantScreenShare:
          participant.role === "host" || meeting.allowParticipantScreenShare
      }, origin, allowedOrigin);
      return true;
    } catch (error) {
      const status = Number((error as { status?: number }).status ?? 500);
      sendJson(response, status, {
        error: error instanceof Error ? error.message : "meeting_token_failed"
      }, origin, allowedOrigin);
      return true;
    }
  }

  return false;
}
