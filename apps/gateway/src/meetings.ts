import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  LiveKitAPI,
  RoomServiceClient,
  S3Upload,
  TrackSource
} from "livekit-server-sdk";
import {
  createMeetingStore,
  type StoredMeeting,
  type StoredParticipant
} from "./meeting-store.js";
import { createMeetingCollaborationStore } from "./meeting-collaboration-store.js";
import {
  createMeetingRecordingStore,
  type RecordingStatus,
  type StoredMeetingRecording
} from "./meeting-recording-store.js";
import { createMeetingBreakoutStore } from "./meeting-breakout-store.js";
import {
  createMeetingIntelligenceStore,
  type TranscriptSegment
} from "./meeting-intelligence-store.js";
import { generateMeetingSummary } from "./meeting-summary.js";

type JsonObject = Record<string, unknown>;

const store = createMeetingStore();
const collaboration = createMeetingCollaborationStore();
const recordings = createMeetingRecordingStore();
const breakouts = createMeetingBreakoutStore();
const intelligence = createMeetingIntelligenceStore();
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

async function readJson(
  request: IncomingMessage,
  maxBytes = MAX_BODY_BYTES
): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
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

function canModerate(
  participant: StoredParticipant | null
): participant is StoredParticipant {
  return Boolean(
    participant &&
      (participant.role === "host" || participant.role === "cohost")
  );
}

function isOwner(
  participant: StoredParticipant | null
): participant is StoredParticipant {
  return participant?.role === "host";
}

function recordingStorageConfig() {
  const bucket = process.env.WORKSPACE_MEET_RECORDING_BUCKET?.trim();
  const accessKey =
    process.env.WORKSPACE_MEET_RECORDING_ACCESS_KEY?.trim();
  const secret =
    process.env.WORKSPACE_MEET_RECORDING_SECRET?.trim();

  if (!bucket || !accessKey || !secret) return null;

  return {
    bucket,
    accessKey,
    secret,
    region:
      process.env.WORKSPACE_MEET_RECORDING_REGION?.trim() ?? "",
    endpoint:
      process.env.WORKSPACE_MEET_RECORDING_ENDPOINT?.trim() ?? "",
    forcePathStyle:
      process.env.WORKSPACE_MEET_RECORDING_FORCE_PATH_STYLE !== "false",
    prefix:
      process.env.WORKSPACE_MEET_RECORDING_PREFIX?.trim() ||
      "tamishra-meet"
  };
}

function recordingConfigured() {
  return Boolean(liveKitConfig() && recordingStorageConfig());
}

function egressClient() {
  const livekit = liveKitConfig();
  if (!livekit) return null;
  return new EgressClient(
    livekit.apiUrl,
    livekit.apiKey,
    livekit.apiSecret
  );
}

function recordingStatus(value: number): RecordingStatus {
  switch (value) {
    case 0:
      return "starting";
    case 1:
      return "active";
    case 2:
      return "stopping";
    case 3:
      return "complete";
    case 4:
      return "failed";
    case 5:
    case 6:
      return "aborted";
    default:
      return "failed";
  }
}

function recordingPublic(
  recording: StoredMeetingRecording | null,
  includeStorage = false
) {
  if (!recording) return null;
  return {
    id: recording.id,
    roomName: recording.roomName,
    egressId: recording.egressId,
    status: recording.status,
    filepath: includeStorage ? recording.filepath : "",
    location: includeStorage ? recording.location : null,
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
    durationNs: recording.durationNs,
    sizeBytes: recording.sizeBytes,
    error: recording.error,
    createdAt: recording.createdAt,
    updatedAt: recording.updatedAt
  };
}

async function syncActiveRecording(roomNameValue: string) {
  const active = await recordings.getActiveRecording(roomNameValue);
  if (!active) return null;

  const client = egressClient();
  if (!client) return active;

  try {
    const items = await client.listEgress({ roomName: roomNameValue });
    const info = items.find((item) => item.egressId === active.egressId);
    if (!info) return active;

    const file = info.fileResults[0];
    return (
      await recordings.updateRecording(
        roomNameValue,
        active.egressId,
        {
          status: recordingStatus(Number(info.status)),
          location: file?.location || active.location,
          durationNs:
            file?.duration === undefined
              ? active.durationNs
              : String(file.duration),
          sizeBytes:
            file?.size === undefined
              ? active.sizeBytes
              : String(file.size),
          error: info.error || active.error
        }
      )
    ) ?? active;
  } catch {
    return active;
  }
}

function safeRecordingPath(roomNameValue: string) {
  const config = recordingStorageConfig();
  const prefix = config?.prefix.replace(/^\/+|\/+$/g, "") || "tamishra-meet";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return prefix + "/" + roomNameValue + "/" + stamp + ".mp4";
}

function durationMs(start: string, end: string) {
  return Math.max(
    0,
    new Date(end).getTime() - new Date(start).getTime()
  );
}

function captionConfig() {
  const agentName =
    process.env.WORKSPACE_MEET_TRANSCRIBER_AGENT?.trim() || "";
  const workerSecret =
    process.env.WORKSPACE_MEET_TRANSCRIBER_SECRET?.trim() || "";
  const model =
    process.env.WORKSPACE_MEET_TRANSCRIBER_MODEL?.trim() ||
    "tamishra-default";
  const language =
    process.env.WORKSPACE_MEET_TRANSCRIBER_LANGUAGE?.trim() ||
    "multi";

  return {
    agentName,
    workerSecret,
    model,
    language,
    configured: Boolean(
      liveKitConfig() &&
        agentName &&
        workerSecret
    )
  };
}

function liveKitApi() {
  const livekit = liveKitConfig();
  if (!livekit) return null;
  return new LiveKitAPI({
    host: livekit.apiUrl,
    apiKey: livekit.apiKey,
    secret: livekit.apiSecret
  });
}

async function startCaptionAgent(
  roomNameValue: string,
  model?: string,
  language?: string
) {
  const config = captionConfig();
  const api = liveKitApi();

  if (!api || !config.configured) {
    throw Object.assign(
      new Error("transcription_not_configured"),
      { status: 503 }
    );
  }

  const existing = await api.agentDispatch.listDispatch(roomNameValue);
  const match = existing.find(
    (item) => item.agentName === config.agentName
  );
  if (match) return match;

  return api.agentDispatch.createDispatch(
    roomNameValue,
    config.agentName,
    {
      metadata: JSON.stringify({
        roomName: roomNameValue,
        model: model || config.model,
        language: language || config.language,
        transcriptEndpoint:
          "/v1/meetings/" +
          encodeURIComponent(roomNameValue) +
          "/transcript-worker"
      })
    }
  );
}

async function stopCaptionAgent(
  roomNameValue: string,
  dispatchId?: string | null
) {
  const config = captionConfig();
  const api = liveKitApi();
  if (!api || !config.agentName) return false;

  if (dispatchId) {
    await api.agentDispatch.deleteDispatch(dispatchId, roomNameValue);
    return true;
  }

  const dispatches = await api.agentDispatch.listDispatch(roomNameValue);
  const matches = dispatches.filter(
    (item) => item.agentName === config.agentName
  );

  await Promise.all(
    matches.map((item) =>
      api.agentDispatch.deleteDispatch(item.id, roomNameValue)
    )
  );
  return matches.length > 0;
}

function workerAuthorized(request: IncomingMessage) {
  const expected = captionConfig().workerSecret;
  const actual = String(
    request.headers["x-tamishra-worker-secret"] ?? ""
  );

  if (!expected || !actual) return false;

  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);

  return (
    expectedBytes.length === actualBytes.length &&
    timingSafeEqual(expectedBytes, actualBytes)
  );
}

function breakoutMediaRoomName(
  parentRoomName: string,
  groupId: string
) {
  const parent = parentRoomName
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 80);
  const group = groupId
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .slice(0, 40);
  return parent + "--breakout--" + group;
}

async function ensureBreakoutMediaRoom(
  name: string,
  parentRoomName: string,
  groupId: string,
  groupLabel: string
) {
  const rooms = roomServiceClient();
  if (!rooms) {
    throw Object.assign(
      new Error("livekit_not_configured"),
      { status: 503 }
    );
  }

  try {
    await rooms.createRoom({
      name,
      emptyTimeout: 600,
      departureTimeout: 120,
      metadata: JSON.stringify({
        parentRoomName,
        groupId,
        groupLabel,
        kind: "tamishra-breakout"
      })
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    if (!/already exists|exists/i.test(message)) throw error;
  }
}

function roomServiceClient() {
  const livekit = liveKitConfig();
  if (!livekit) return null;
  return new RoomServiceClient(
    livekit.apiUrl,
    livekit.apiKey,
    livekit.apiSecret
  );
}

function participantPublishSources(
  meeting: StoredMeeting,
  controls: Awaited<ReturnType<typeof collaboration.getControls>>,
  role: StoredParticipant["role"]
) {
  if (role === "host" || role === "cohost") return undefined;

  const sources: TrackSource[] = [];
  if (controls.participantMicrophoneEnabled) {
    sources.push(TrackSource.MICROPHONE);
  }
  if (controls.participantCameraEnabled) {
    sources.push(TrackSource.CAMERA);
  }
  if (meeting.allowParticipantScreenShare) {
    sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  }
  return sources;
}

async function applyLiveKitPermissions(
  meeting: StoredMeeting,
  participant: StoredParticipant,
  controls: Awaited<ReturnType<typeof collaboration.getControls>>
) {
  const rooms = roomServiceClient();
  if (!rooms) return false;

  await rooms.updateParticipant(meeting.roomName, participant.id, {
    permission: {
      canSubscribe: true,
      canPublish: true,
      canPublishData: true,
      canPublishSources: participantPublishSources(
        meeting,
        controls,
        participant.role
      )
    }
  });
  return true;
}

async function muteParticipantSource(
  roomNameValue: string,
  identity: string,
  source: TrackSource
) {
  const rooms = roomServiceClient();
  if (!rooms) return 0;

  const info = await rooms.getParticipant(roomNameValue, identity);
  const tracks = info.tracks.filter(
    (track) => track.source === source && !track.muted
  );

  await Promise.all(
    tracks.map((track) =>
      rooms.mutePublishedTrack(roomNameValue, identity, track.sid, true)
    )
  );

  return tracks.length;
}

async function liveMediaStates(roomNameValue: string) {
  const rooms = roomServiceClient();
  if (!rooms) return new Map<string, {
    microphoneActive: boolean;
    cameraActive: boolean;
    screenShareActive: boolean;
  }>();

  try {
    const liveParticipants = await rooms.listParticipants(roomNameValue);
    return new Map(
      liveParticipants.map((participant) => {
        const active = (source: TrackSource) =>
          participant.tracks.some(
            (track) => track.source === source && !track.muted
          );
        return [
          participant.identity,
          {
            microphoneActive: active(TrackSource.MICROPHONE),
            cameraActive: active(TrackSource.CAMERA),
            screenShareActive:
              active(TrackSource.SCREEN_SHARE) ||
              active(TrackSource.SCREEN_SHARE_AUDIO)
          }
        ] as const;
      })
    );
  } catch {
    return new Map();
  }
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

async function closeLiveKitRoom(roomNameValue: string) {
  const livekit = liveKitConfig();
  if (!livekit) return false;
  const rooms = new RoomServiceClient(
    livekit.apiUrl,
    livekit.apiKey,
    livekit.apiSecret
  );
  await rooms.deleteRoom(roomNameValue);
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
    await recordings.ready();
    await breakouts.ready();
    await intelligence.ready();
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
        recordingConfigured: recordingConfigured(),
        transcriptionConfigured: captionConfig().configured,
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
          auditLog: true,
          cohost: true,
          serverMediaModeration: true,
          participantMediaPolicies: true,
          recording: true,
          recordingConsent: true,
          meetingHistory: true,
          attendanceReports: true,
          breakoutRooms: true,
          liveCaptions: true,
          transcript: true,
          sharedNotes: true,
          meetingSummary: true
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

  if (request.method === "POST" && url.pathname === "/v1/meetings/history") {
    try {
      const body = await readJson(request);
      const rawEntries = Array.isArray(body.entries) ? body.entries : [];
      const entries = rawEntries
        .slice(0, 50)
        .map((value) =>
          value && typeof value === "object"
            ? value as Record<string, unknown>
            : {}
        );

      const history = (
        await Promise.all(
          entries.map(async (entry) => {
            const roomNameValue = String(entry.roomName ?? "").trim();
            const accessKey = String(entry.accessKey ?? "").trim();
            if (!roomNameValue || !accessKey) return null;

            const [meeting, participant] = await Promise.all([
              store.getMeeting(roomNameValue),
              findAccess(roomNameValue, accessKey)
            ]);

            if (!meeting || !participant) return null;

            const [participants, attendance, roomRecordings] =
              await Promise.all([
                store.listParticipants(roomNameValue),
                store.listAttendance(roomNameValue),
                recordings.listRecordings(roomNameValue, 20)
              ]);

            return {
              roomName: meeting.roomName,
              title: meeting.title,
              status: meeting.status,
              role: participant.role,
              createdAt: meeting.createdAt,
              scheduledStartAt: meeting.scheduledStartAt,
              startedAt: meeting.startedAt,
              endedAt: meeting.endedAt,
              joinCode:
                participant.role === "host" ? meeting.joinCode : null,
              participantCount: participants.filter(
                (item) => item.admissionStatus === "admitted"
              ).length,
              attendanceCount: attendance.length,
              recordingCount: roomRecordings.length
            };
          })
        )
      )
        .filter(Boolean)
        .sort((left, right) =>
          String(right!.createdAt).localeCompare(String(left!.createdAt))
        );

      sendJson(
        response,
        200,
        { history },
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
              : "meeting_history_failed"
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

    if (!canModerate(host)) {
      sendJson(
        response,
        403,
        { error: "moderator_access_required" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const [participants, mediaStates] = await Promise.all([
      store.listParticipants(meeting.roomName),
      liveMediaStates(meeting.roomName)
    ]);

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
          lastSeenAt: participant.lastSeenAt,
          ...(mediaStates.get(participant.id) ?? {
            microphoneActive: false,
            cameraActive: false,
            screenShareActive: false
          })
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
        participantMicrophoneEnabled?: boolean;
        participantCameraEnabled?: boolean;
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
      if (typeof body.participantMicrophoneEnabled === "boolean") {
        patch.participantMicrophoneEnabled =
          body.participantMicrophoneEnabled;
      }
      if (typeof body.participantCameraEnabled === "boolean") {
        patch.participantCameraEnabled =
          body.participantCameraEnabled;
      }

      const previousControls = await collaboration.getControls(
        meeting.roomName
      );
      const controls = await collaboration.updateControls(
        meeting.roomName,
        patch
      );

      const mediaPolicyChanged =
        previousControls.participantMicrophoneEnabled !==
          controls.participantMicrophoneEnabled ||
        previousControls.participantCameraEnabled !==
          controls.participantCameraEnabled;

      if (mediaPolicyChanged) {
        const participants = await store.listParticipants(meeting.roomName);
        const policyTargets = participants.filter(
          (participant) =>
            participant.role === "participant" &&
            participant.admissionStatus === "admitted"
        );

        await Promise.all(
          policyTargets.map(async (participant) => {
            try {
              await applyLiveKitPermissions(
                meeting,
                participant,
                controls
              );

              if (!controls.participantMicrophoneEnabled) {
                await muteParticipantSource(
                  meeting.roomName,
                  participant.id,
                  TrackSource.MICROPHONE
                );
              }

              if (!controls.participantCameraEnabled) {
                await muteParticipantSource(
                  meeting.roomName,
                  participant.id,
                  TrackSource.CAMERA
                );
              }
            } catch {
              // Offline participants receive this policy when they reconnect.
            }
          })
        );
      }

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

  if (request.method === "POST" && parsed.action === "role") {
    try {
      const body = await readJson(request);
      const host = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!isOwner(host)) {
        sendJson(
          response,
          403,
          { error: "host_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const role =
        body.role === "cohost"
          ? "cohost"
          : body.role === "participant"
            ? "participant"
            : null;

      if (!role) {
        sendJson(
          response,
          400,
          { error: "invalid_meeting_role" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const target = await store.updateParticipantRole(
        meeting.roomName,
        String(body.participantId ?? ""),
        role
      );

      if (!target || target.admissionStatus !== "admitted") {
        sendJson(
          response,
          404,
          { error: "participant_not_found" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const controls = await collaboration.getControls(meeting.roomName);
      let permissionsUpdated = false;
      try {
        permissionsUpdated = await applyLiveKitPermissions(
          meeting,
          target,
          controls
        );
      } catch {
        // Role still persists if participant is currently offline.
      }

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: host.id,
        actorDisplayName: host.displayName,
        eventType:
          role === "cohost" ? "cohost_promoted" : "cohost_demoted",
        targetParticipantId: target.id,
        metadata: { permissionsUpdated }
      });

      sendJson(
        response,
        200,
        {
          participant: {
            id: target.id,
            displayName: target.displayName,
            role: target.role,
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
            error instanceof Error ? error.message : "role_update_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "media") {
    try {
      const body = await readJson(request);
      const moderator = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!canModerate(moderator)) {
        sendJson(
          response,
          403,
          { error: "moderator_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const action = String(body.action ?? "");
      const participants = await store.listParticipants(meeting.roomName);

      if (action === "mute-all-mics" || action === "stop-all-cameras") {
        const source =
          action === "mute-all-mics"
            ? TrackSource.MICROPHONE
            : TrackSource.CAMERA;
        const targets = participants.filter(
          (participant) =>
            participant.role === "participant" &&
            participant.admissionStatus === "admitted"
        );

        let affectedTracks = 0;
        await Promise.all(
          targets.map(async (target) => {
            try {
              affectedTracks += await muteParticipantSource(
                meeting.roomName,
                target.id,
                source
              );
            } catch {
              // Ignore disconnected participants.
            }
          })
        );

        await collaboration.appendAudit({
          roomName: meeting.roomName,
          actorParticipantId: moderator!.id,
          actorDisplayName: moderator!.displayName,
          eventType: action.replaceAll("-", "_"),
          targetParticipantId: null,
          metadata: {
            participantCount: targets.length,
            affectedTracks
          }
        });

        sendJson(
          response,
          200,
          { ok: true, affectedTracks },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (action !== "mute-mic" && action !== "stop-camera") {
        sendJson(
          response,
          400,
          { error: "invalid_media_action" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const targetId = String(body.participantId ?? "");
      const target = participants.find(
        (participant) => participant.id === targetId
      );

      const canTarget =
        target &&
        target.role !== "host" &&
        (
          moderator!.role === "host" ||
          target.role === "participant"
        );

      if (!canTarget || !target) {
        sendJson(
          response,
          403,
          { error: "participant_media_control_not_allowed" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const source =
        action === "mute-mic"
          ? TrackSource.MICROPHONE
          : TrackSource.CAMERA;

      let affectedTracks = 0;
      try {
        affectedTracks = await muteParticipantSource(
          meeting.roomName,
          target.id,
          source
        );
      } catch {
        // Participant may not currently publish that source.
      }

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: moderator!.id,
        actorDisplayName: moderator!.displayName,
        eventType:
          action === "mute-mic"
            ? "participant_microphone_muted"
            : "participant_camera_stopped",
        targetParticipantId: target.id,
        metadata: { affectedTracks }
      });

      sendJson(
        response,
        200,
        {
          ok: true,
          participantId: target.id,
          affectedTracks
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
            error instanceof Error ? error.message : "media_control_failed"
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

      if (!canModerate(host)) {
        sendJson(
          response,
          403,
          { error: "moderator_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const targetId = String(body.participantId ?? "");
      const participants = await store.listParticipants(meeting.roomName);
      const target = participants.find(
        (participant) =>
          participant.id === targetId &&
          participant.role !== "host" &&
          (
            host.role === "host" ||
            participant.role === "participant"
          )
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

      const previousRole = target.role;
      if (target.role === "cohost" && host.role === "host") {
        await store.updateParticipantRole(
          meeting.roomName,
          target.id,
          "participant"
        );
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
        metadata: { disconnected, previousRole }
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

    if (!canModerate(host)) {
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

  if (request.method === "GET" && parsed.action === "breakouts") {
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

    let [rooms, assignments] = await Promise.all([
      breakouts.listRooms(meeting.roomName),
      breakouts.listAssignments(meeting.roomName)
    ]);

    const now = Date.now();
    const expired = rooms.some((room) => {
      if (!room.durationMinutes) return false;
      return (
        new Date(room.openedAt).getTime() +
          room.durationMinutes * 60_000 <=
        now
      );
    });

    if (expired) {
      const openRooms = [...rooms];
      await breakouts.returnAll(meeting.roomName);
      const roomService = roomServiceClient();
      if (roomService) {
        await Promise.all(
          openRooms.map((room) =>
            roomService
              .deleteRoom(room.livekitRoomName)
              .catch(() => undefined)
          )
        );
      }
      rooms = [];
      assignments = [];
    }

    const moderator = canModerate(participant);
    const visibleAssignments = moderator
      ? assignments
      : assignments.filter(
          (item) => item.participantId === participant.id
        );

    sendJson(
      response,
      200,
      {
        rooms: moderator ? rooms : [],
        assignments: visibleAssignments
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "POST" && parsed.action === "breakouts") {
    try {
      const body = await readJson(request, 98_304);
      const moderator = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!canModerate(moderator)) {
        sendJson(
          response,
          403,
          { error: "moderator_access_required" },
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

      const action = String(body.action ?? "");

      if (action === "return-all") {
        const openRooms = await breakouts.listRooms(meeting.roomName);
        const returned = await breakouts.returnAll(meeting.roomName);
        const rooms = roomServiceClient();

        if (rooms) {
          await Promise.all(
            openRooms.map((room) =>
              rooms
                .deleteRoom(room.livekitRoomName)
                .catch(() => undefined)
            )
          );
        }

        await collaboration.appendAudit({
          roomName: meeting.roomName,
          actorParticipantId: moderator.id,
          actorDisplayName: moderator.displayName,
          eventType: "breakouts_returned",
          targetParticipantId: null,
          metadata: {
            returned,
            roomCount: openRooms.length
          }
        });

        sendJson(
          response,
          200,
          { ok: true, returned },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (action !== "publish" || !Array.isArray(body.assignments)) {
        sendJson(
          response,
          400,
          { error: "invalid_breakout_action" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const requested = body.assignments
        .slice(0, MAX_PARTICIPANTS)
        .map((item) =>
          item && typeof item === "object"
            ? item as Record<string, unknown>
            : {}
        );

      const participants = await store.listParticipants(meeting.roomName);
      const allowed = new Map(
        participants
          .filter(
            (item) =>
              item.role === "participant" &&
              item.admissionStatus === "admitted"
          )
          .map((item) => [item.id, item])
      );

      const groupMap = new Map<
        string,
        { id: string; label: string; mediaRoom: string }
      >();
      const assignments: Array<{
        parentRoomName: string;
        participantId: string;
        displayName: string;
        groupId: string;
        livekitRoomName: string;
        assignedAt: string;
        returnedAt: null;
      }> = [];

      const nowIso = new Date().toISOString();
      for (const item of requested) {
        const participantIdValue = String(item.participantId ?? "").trim();
        const participant = allowed.get(participantIdValue);
        if (!participant) continue;

        const groupId = String(item.groupId ?? "")
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .slice(0, 40);
        const groupLabel = cleanName(
          item.groupLabel,
          groupId || "Breakout"
        ).slice(0, 80);

        if (!groupId) continue;

        if (!groupMap.has(groupId)) {
          if (groupMap.size >= 20) break;
          groupMap.set(groupId, {
            id: groupId,
            label: groupLabel,
            mediaRoom: breakoutMediaRoomName(
              meeting.roomName,
              groupId
            )
          });
        }

        const group = groupMap.get(groupId)!;
        assignments.push({
          parentRoomName: meeting.roomName,
          participantId: participant.id,
          displayName: participant.displayName,
          groupId: group.id,
          livekitRoomName: group.mediaRoom,
          assignedAt: nowIso,
          returnedAt: null
        });
      }

      if (assignments.length === 0 || groupMap.size === 0) {
        sendJson(
          response,
          400,
          { error: "breakout_assignments_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const durationMinutesRaw = Number(body.durationMinutes ?? 10);
      const durationMinutes = Number.isFinite(durationMinutesRaw)
        ? Math.max(1, Math.min(Math.round(durationMinutesRaw), 120))
        : 10;

      const rooms = Array.from(groupMap.values()).map((group) => ({
        parentRoomName: meeting.roomName,
        groupId: group.id,
        groupLabel: group.label,
        livekitRoomName: group.mediaRoom,
        status: "open" as const,
        durationMinutes,
        openedAt: nowIso,
        closedAt: null
      }));

      for (const room of rooms) {
        await ensureBreakoutMediaRoom(
          room.livekitRoomName,
          meeting.roomName,
          room.groupId,
          room.groupLabel
        );
      }

      await breakouts.publish({
        rooms,
        assignments
      });

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: moderator.id,
        actorDisplayName: moderator.displayName,
        eventType: "breakouts_published",
        targetParticipantId: null,
        metadata: {
          roomCount: rooms.length,
          assignmentCount: assignments.length,
          durationMinutes
        }
      });

      sendJson(
        response,
        201,
        {
          ok: true,
          rooms,
          assignments,
          durationMinutes
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
              : "breakout_operation_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (
    request.method === "POST" &&
    parsed.action === "breakout-token"
  ) {
    try {
      const body = await readJson(request);
      const participant = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (
        !participant ||
        participant.admissionStatus !== "admitted" ||
        participant.role !== "participant" ||
        meeting.status !== "live"
      ) {
        sendJson(
          response,
          403,
          { error: "breakout_access_unavailable" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const assignment = await breakouts.getAssignment(
        meeting.roomName,
        participant.id
      );

      if (!assignment) {
        sendJson(
          response,
          404,
          { error: "breakout_assignment_not_found" },
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

      const controls = await collaboration.getControls(meeting.roomName);
      const token = new AccessToken(
        livekit.apiKey,
        livekit.apiSecret,
        {
          identity: participant.id,
          name: participant.displayName,
          ttl: "2h"
        }
      );

      token.addGrant({
        roomJoin: true,
        room: assignment.livekitRoomName,
        canPublish: true,
        canPublishSources: participantPublishSources(
          meeting,
          controls,
          participant.role
        ),
        canSubscribe: true,
        canPublishData: true
      });

      sendJson(
        response,
        200,
        {
          token: await token.toJwt(),
          url: livekit.url,
          mediaRoom: assignment.livekitRoomName,
          groupId: assignment.groupId,
          groupLabel:
            (
              await breakouts.listRooms(meeting.roomName)
            ).find((room) => room.groupId === assignment.groupId)
              ?.groupLabel ?? assignment.groupId
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
              : "breakout_token_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "GET" && parsed.action === "captions") {
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

    const state = await intelligence.getCaptionState(meeting.roomName);

    sendJson(
      response,
      200,
      {
        configured: captionConfig().configured,
        state
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "POST" && parsed.action === "captions") {
    try {
      const body = await readJson(request);
      const moderator = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!canModerate(moderator)) {
        sendJson(
          response,
          403,
          { error: "moderator_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const action = String(body.action ?? "");
      if (action === "start") {
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

        const config = captionConfig();
        const model =
          String(body.model ?? config.model).trim().slice(0, 120) ||
          config.model;
        const language =
          String(body.language ?? config.language).trim().slice(0, 40) ||
          config.language;

        try {
          const dispatch = await startCaptionAgent(
            meeting.roomName,
            model,
            language
          );

          const state = await intelligence.saveCaptionState(
            meeting.roomName,
            {
              desiredState: "running",
              agentName: config.agentName,
              dispatchId: dispatch.id,
              model,
              language,
              lastHeartbeatAt: null,
              lastError: null
            }
          );

          await collaboration.appendAudit({
            roomName: meeting.roomName,
            actorParticipantId: moderator.id,
            actorDisplayName: moderator.displayName,
            eventType: "captions_started",
            targetParticipantId: null,
            metadata: {
              agentName: config.agentName,
              model,
              language
            }
          });

          sendJson(
            response,
            200,
            { configured: true, state },
            origin,
            allowedOrigins
          );
          return true;
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "caption_agent_start_failed";
          await intelligence.saveCaptionState(
            meeting.roomName,
            {
              desiredState: "error",
              lastError: message
            }
          );
          throw error;
        }
      }

      if (action === "stop") {
        const current = await intelligence.getCaptionState(
          meeting.roomName
        );

        await stopCaptionAgent(
          meeting.roomName,
          current.dispatchId
        ).catch(() => false);

        const state = await intelligence.saveCaptionState(
          meeting.roomName,
          {
            desiredState: "stopped",
            dispatchId: null,
            lastError: null
          }
        );

        await collaboration.appendAudit({
          roomName: meeting.roomName,
          actorParticipantId: moderator.id,
          actorDisplayName: moderator.displayName,
          eventType: "captions_stopped",
          targetParticipantId: null,
          metadata: {}
        });

        sendJson(
          response,
          200,
          {
            configured: captionConfig().configured,
            state
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      sendJson(
        response,
        400,
        { error: "invalid_caption_action" },
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
              : "caption_control_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "GET" && parsed.action === "transcript") {
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

    const requestedLimit = Number(
      url.searchParams.get("limit") ?? 500
    );
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.round(requestedLimit), 5000))
      : 500;
    const segments = await intelligence.listTranscript(
      meeting.roomName,
      limit
    );

    sendJson(
      response,
      200,
      { segments },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (
    request.method === "POST" &&
    parsed.action === "transcript-worker"
  ) {
    try {
      if (!workerAuthorized(request)) {
        sendJson(
          response,
          401,
          { error: "invalid_worker_secret" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const body = await readJson(request, 1_048_576);
      const rawSegments = Array.isArray(body.segments)
        ? body.segments.slice(0, 100)
        : [];

      const segments: TranscriptSegment[] = rawSegments
        .map((item) =>
          item && typeof item === "object"
            ? item as Record<string, unknown>
            : {}
        )
        .map((item) => ({
          segmentId: String(item.segmentId ?? "").slice(0, 200),
          participantIdentity: String(
            item.participantIdentity ?? ""
          ).slice(0, 255),
          participantName: item.participantName
            ? String(item.participantName).slice(0, 255)
            : undefined,
          trackSid: item.trackSid
            ? String(item.trackSid).slice(0, 255)
            : undefined,
          text: String(item.text ?? "").slice(0, 8000),
          isFinal: Boolean(item.isFinal),
          sourceTimestamp:
            item.sourceTimestamp === undefined
              ? undefined
              : Number(item.sourceTimestamp),
          receivedAt: new Date().toISOString()
        }))
        .filter(
          (item) =>
            item.segmentId &&
            item.participantIdentity &&
            item.text
        );

      const saved = await intelligence.upsertTranscript(
        meeting.roomName,
        segments
      );

      const state = await intelligence.saveCaptionState(
        meeting.roomName,
        {
          desiredState: "running",
          lastHeartbeatAt: new Date().toISOString(),
          lastError: null
        }
      );

      sendJson(
        response,
        200,
        { ok: true, saved, state },
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
              : "transcript_ingest_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "GET" && parsed.action === "notes") {
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

    const notes = await intelligence.getNotes(meeting.roomName);
    sendJson(
      response,
      200,
      { notes },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "POST" && parsed.action === "notes") {
    try {
      const body = await readJson(request, 65_536);
      const moderator = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!canModerate(moderator)) {
        sendJson(
          response,
          403,
          { error: "moderator_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const noteBody = String(body.body ?? "").slice(0, 50_000);
      const notes = await intelligence.saveNotes(
        meeting.roomName,
        noteBody,
        moderator.id,
        moderator.displayName
      );

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: moderator.id,
        actorDisplayName: moderator.displayName,
        eventType: "meeting_notes_updated",
        targetParticipantId: null,
        metadata: {
          length: noteBody.length
        }
      });

      sendJson(
        response,
        200,
        { notes },
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
              : "meeting_notes_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "GET" && parsed.action === "summary") {
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

    const summary = await intelligence.getLatestSummary(
      meeting.roomName
    );

    sendJson(
      response,
      200,
      { summary },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "POST" && parsed.action === "summary") {
    try {
      const body = await readJson(request);
      const moderator = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!canModerate(moderator)) {
        sendJson(
          response,
          403,
          { error: "moderator_access_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const [segments, notes] = await Promise.all([
        intelligence.listTranscript(meeting.roomName, 5000),
        intelligence.getNotes(meeting.roomName)
      ]);

      const generated = await generateMeetingSummary({
        roomName: meeting.roomName,
        title: meeting.title,
        segments,
        notes: notes.body
      });

      const summary = await intelligence.saveSummary({
        roomName: meeting.roomName,
        summary: generated.summary,
        actionItems: generated.actionItems,
        provider: generated.provider,
        createdByParticipantId: moderator.id,
        createdByDisplayName: moderator.displayName
      });

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: moderator.id,
        actorDisplayName: moderator.displayName,
        eventType: "meeting_summary_generated",
        targetParticipantId: null,
        metadata: {
          provider: summary.provider,
          transcriptSegments: segments.length,
          actionItems: summary.actionItems.length
        }
      });

      sendJson(
        response,
        201,
        { summary },
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
              : "meeting_summary_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "GET" && parsed.action === "attendance") {
    const host = await findAccess(
      meeting.roomName,
      url.searchParams.get("accessKey")
    );

    if (!canModerate(host)) {
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

  if (request.method === "GET" && parsed.action === "recording") {
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

    const [active, consent, consents, roomRecordings] =
      await Promise.all([
        syncActiveRecording(meeting.roomName),
        recordings.getConsent(meeting.roomName, participant.id),
        canModerate(participant)
          ? recordings.listConsents(meeting.roomName)
          : Promise.resolve([]),
        canModerate(participant)
          ? recordings.listRecordings(meeting.roomName, 20)
          : Promise.resolve([])
      ]);

    const activeForResponse =
      active &&
      ["starting", "active", "stopping"].includes(active.status)
        ? active
        : null;
    const moderator = canModerate(participant);

    sendJson(
      response,
      200,
      {
        configured: recordingConfigured(),
        active: recordingPublic(activeForResponse, moderator),
        consent,
        consents,
        recordings: roomRecordings.map((item) =>
          recordingPublic(item, true)
        )
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (
    request.method === "POST" &&
    parsed.action === "recording-consent"
  ) {
    try {
      const body = await readJson(request);
      const participant = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (
        !participant ||
        participant.admissionStatus !== "admitted"
      ) {
        sendJson(
          response,
          403,
          { error: "recording_consent_unavailable" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const consent =
        body.consent === "accepted"
          ? "accepted"
          : body.consent === "declined"
            ? "declined"
            : null;

      if (!consent) {
        sendJson(
          response,
          400,
          { error: "invalid_recording_consent" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const saved = await recordings.setConsent(
        meeting.roomName,
        participant.id,
        participant.displayName,
        consent
      );

      let recordingStopped = false;
      if (consent === "declined") {
        const active = await recordings.getActiveRecording(
          meeting.roomName
        );
        const client = egressClient();

        if (active && client) {
          try {
            const info = await client.stopEgress(active.egressId);
            const file = info.fileResults[0];
            await recordings.updateRecording(
              meeting.roomName,
              active.egressId,
              {
                status: recordingStatus(Number(info.status)),
                location: file?.location || active.location,
                endedAt: new Date().toISOString(),
                durationNs:
                  file?.duration === undefined
                    ? active.durationNs
                    : String(file.duration),
                sizeBytes:
                  file?.size === undefined
                    ? active.sizeBytes
                    : String(file.size),
                error: info.error || null
              }
            );
            recordingStopped = true;
            await recordings.resetConsents(meeting.roomName);
          } catch (error) {
            console.warn(
              "Unable to stop recording after consent withdrawal",
              error
            );
          }
        }
      }

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: participant.id,
        actorDisplayName: participant.displayName,
        eventType:
          consent === "accepted"
            ? "recording_consent_accepted"
            : "recording_consent_declined",
        targetParticipantId: participant.id,
        metadata: { recordingStopped }
      });

      sendJson(
        response,
        200,
        { consent: saved, recordingStopped },
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
              : "recording_consent_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && parsed.action === "recording") {
    try {
      const body = await readJson(request);
      const host = await findAccess(
        meeting.roomName,
        String(body.accessKey ?? "")
      );

      if (!isOwner(host)) {
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

      if (action === "start") {
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

        const storage = recordingStorageConfig();
        const client = egressClient();
        if (!storage || !client) {
          sendJson(
            response,
            503,
            { error: "recording_not_configured" },
            origin,
            allowedOrigins
          );
          return true;
        }

        const existing = await syncActiveRecording(meeting.roomName);
        if (existing) {
          sendJson(
            response,
            409,
            {
              error: "recording_already_active",
              recording: recordingPublic(existing)
            },
            origin,
            allowedOrigins
          );
          return true;
        }

        const [participants, consents] = await Promise.all([
          store.listParticipants(meeting.roomName),
          recordings.listConsents(meeting.roomName)
        ]);
        const required = participants.filter(
          (item) =>
            item.role !== "host" &&
            item.admissionStatus === "admitted"
        );
        const consentByParticipant = new Map(
          consents.map((item) => [item.participantId, item])
        );
        const pending = required.filter(
          (item) =>
            consentByParticipant.get(item.id)?.consent !== "accepted"
        );
        const declined = pending.filter(
          (item) =>
            consentByParticipant.get(item.id)?.consent === "declined"
        );

        if (pending.length > 0) {
          sendJson(
            response,
            409,
            {
              error: "recording_consent_required",
              pending: pending.map((item) => ({
                participantId: item.id,
                displayName: item.displayName
              })),
              declined: declined.map((item) => ({
                participantId: item.id,
                displayName: item.displayName
              }))
            },
            origin,
            allowedOrigins
          );
          return true;
        }

        const filepath = safeRecordingPath(meeting.roomName);
        const output = new EncodedFileOutput({
          filepath,
          output: {
            case: "s3",
            value: new S3Upload({
              accessKey: storage.accessKey,
              secret: storage.secret,
              region: storage.region,
              endpoint: storage.endpoint,
              bucket: storage.bucket,
              forcePathStyle: storage.forcePathStyle,
              contentDisposition: "attachment"
            })
          }
        });

        const info = await client.startRoomCompositeEgress(
          meeting.roomName,
          { file: output },
          { layout: "grid" }
        );

        const saved = await recordings.createRecording({
          roomName: meeting.roomName,
          egressId: info.egressId,
          status: recordingStatus(Number(info.status)),
          filepath,
          location: info.fileResults[0]?.location || null,
          startedAt: new Date().toISOString(),
          endedAt: null,
          durationNs: null,
          sizeBytes: null,
          error: info.error || null
        });

        await collaboration.appendAudit({
          roomName: meeting.roomName,
          actorParticipantId: host.id,
          actorDisplayName: host.displayName,
          eventType: "recording_started",
          targetParticipantId: null,
          metadata: { egressId: info.egressId }
        });

        sendJson(
          response,
          201,
          { recording: recordingPublic(saved) },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (action === "stop") {
        const active = await recordings.getActiveRecording(
          meeting.roomName
        );
        if (!active) {
          sendJson(
            response,
            409,
            { error: "recording_not_active" },
            origin,
            allowedOrigins
          );
          return true;
        }

        const client = egressClient();
        if (!client) {
          sendJson(
            response,
            503,
            { error: "livekit_not_configured" },
            origin,
            allowedOrigins
          );
          return true;
        }

        await recordings.updateRecording(
          meeting.roomName,
          active.egressId,
          { status: "stopping" }
        );

        const info = await client.stopEgress(active.egressId);
        const file = info.fileResults[0];
        const saved = await recordings.updateRecording(
          meeting.roomName,
          active.egressId,
          {
            status: recordingStatus(Number(info.status)),
            location: file?.location || active.location,
            endedAt: new Date().toISOString(),
            durationNs:
              file?.duration === undefined
                ? active.durationNs
                : String(file.duration),
            sizeBytes:
              file?.size === undefined
                ? active.sizeBytes
                : String(file.size),
            error: info.error || null
          }
        );

        await recordings.resetConsents(meeting.roomName);

        await collaboration.appendAudit({
          roomName: meeting.roomName,
          actorParticipantId: host.id,
          actorDisplayName: host.displayName,
          eventType: "recording_stopped",
          targetParticipantId: null,
          metadata: {
            egressId: active.egressId,
            status: saved?.status ?? "complete"
          }
        });

        sendJson(
          response,
          200,
          { recording: recordingPublic(saved ?? active) },
          origin,
          allowedOrigins
        );
        return true;
      }

      sendJson(
        response,
        400,
        { error: "invalid_recording_action" },
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
              : "recording_control_failed"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "GET" && parsed.action === "report/attendance") {
    const moderator = await findAccess(
      meeting.roomName,
      url.searchParams.get("accessKey")
    );

    if (!canModerate(moderator)) {
      sendJson(
        response,
        403,
        { error: "moderator_access_required" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const attendance = await store.listAttendance(meeting.roomName);
    const now = new Date().toISOString();
    const rows = attendance.map((entry) => {
      const effectiveEnd =
        entry.leftAt ??
        (meeting.status === "ended"
          ? meeting.endedAt ?? entry.lastSeenAt
          : entry.lastSeenAt);

      return {
        participantId: entry.participantId,
        displayName: entry.displayName,
        joinedAt: entry.joinedAt,
        lastSeenAt: entry.lastSeenAt,
        leftAt: entry.leftAt,
        durationMs: durationMs(
          entry.joinedAt,
          effectiveEnd ?? now
        )
      };
    });

    const meetingStart =
      meeting.startedAt ??
      meeting.scheduledStartAt ??
      meeting.createdAt;
    const meetingEnd =
      meeting.endedAt ??
      (meeting.status === "live" ? now : meetingStart);

    sendJson(
      response,
      200,
      {
        report: {
          roomName: meeting.roomName,
          title: meeting.title,
          status: meeting.status,
          startedAt: meeting.startedAt,
          endedAt: meeting.endedAt,
          meetingDurationMs: durationMs(meetingStart, meetingEnd),
          participantCount: rows.length,
          totalAttendanceMs: rows.reduce(
            (sum, row) => sum + row.durationMs,
            0
          ),
          rows
        }
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

      if (!canModerate(host)) {
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

      const targetId = String(body.participantId ?? "");
      const participants = await store.listParticipants(meeting.roomName);
      const existingTarget = participants.find(
        (participant) => participant.id === targetId
      );

      if (
        !existingTarget ||
        existingTarget.role === "host" ||
        (
          host.role === "cohost" &&
          existingTarget.role === "cohost"
        )
      ) {
        sendJson(
          response,
          403,
          { error: "participant_admission_not_allowed" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const target = await store.updateAdmission(
        meeting.roomName,
        targetId,
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

      let mediaRoomClosed = false;
      let recordingStopped = false;
      let breakoutsClosed = 0;
      let captionsStopped = false;
      if (action === "end") {
        const openBreakoutRooms = await breakouts.listRooms(
          meeting.roomName
        );
        breakoutsClosed = await breakouts.returnAll(
          meeting.roomName
        );
        const rooms = roomServiceClient();
        if (rooms) {
          await Promise.all(
            openBreakoutRooms.map((room) =>
              rooms
                .deleteRoom(room.livekitRoomName)
                .catch(() => undefined)
            )
          );
        }

        const captionState = await intelligence.getCaptionState(
          meeting.roomName
        );
        if (captionState.desiredState === "running") {
          captionsStopped = await stopCaptionAgent(
            meeting.roomName,
            captionState.dispatchId
          ).catch(() => false);
          await intelligence.saveCaptionState(
            meeting.roomName,
            {
              desiredState: "stopped",
              dispatchId: null
            }
          );
        }
        const activeRecording = await recordings.getActiveRecording(
          meeting.roomName
        );
        if (activeRecording) {
          const client = egressClient();
          if (client) {
            try {
              const info = await client.stopEgress(activeRecording.egressId);
              const file = info.fileResults[0];
              await recordings.updateRecording(
                meeting.roomName,
                activeRecording.egressId,
                {
                  status: recordingStatus(Number(info.status)),
                  location:
                    file?.location || activeRecording.location,
                  endedAt: new Date().toISOString(),
                  durationNs:
                    file?.duration === undefined
                      ? activeRecording.durationNs
                      : String(file.duration),
                  sizeBytes:
                    file?.size === undefined
                      ? activeRecording.sizeBytes
                      : String(file.size),
                  error: info.error || null
                }
              );
              recordingStopped = true;
            } catch (error) {
              console.warn("Unable to stop meeting recording", error);
            }
          }
          await recordings.resetConsents(meeting.roomName);
        }

        try {
          mediaRoomClosed = await closeLiveKitRoom(meeting.roomName);
        } catch (error) {
          console.warn("Unable to close LiveKit room", error);
        }
      }

      await collaboration.appendAudit({
        roomName: meeting.roomName,
        actorParticipantId: host.id,
        actorDisplayName: host.displayName,
        eventType:
          action === "start" ? "meeting_started" : "meeting_ended",
        targetParticipantId: null,
        metadata:
          action === "end"
            ? {
                mediaRoomClosed,
                recordingStopped,
                breakoutsClosed,
                captionsStopped
              }
            : {}
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

      const activeRecording = await syncActiveRecording(meeting.roomName);
      if (activeRecording && participant.role !== "host") {
        const consent = await recordings.getConsent(
          meeting.roomName,
          participant.id
        );
        if (consent?.consent !== "accepted") {
          sendJson(
            response,
            409,
            {
              error: "recording_consent_required",
              recording: recordingPublic(activeRecording),
              consent: consent?.consent ?? null
            },
            origin,
            allowedOrigins
          );
          return true;
        }
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

      const controls = await collaboration.getControls(meeting.roomName);
      const canShareScreen =
        participant.role === "host" ||
        participant.role === "cohost" ||
        meeting.allowParticipantScreenShare;

      const publishSources = participantPublishSources(
        meeting,
        controls,
        participant.role
      );

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
          allowParticipantScreenShare: canShareScreen,
          participantMicrophoneEnabled:
            controls.participantMicrophoneEnabled,
          participantCameraEnabled:
            controls.participantCameraEnabled
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
