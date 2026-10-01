import {
  normalizeMeetingCode,
  type MeetingCreateInput,
  type MeetingJoinContext
} from "./index";

export type MeetingParticipant = {
  id: string;
  displayName: string;
  role: "host" | "cohost" | "participant";
  admissionStatus: "waiting" | "admitted" | "denied";
  createdAt: string;
  lastSeenAt: string;
  microphoneActive: boolean;
  cameraActive: boolean;
  screenShareActive: boolean;
};

export type MeetingAccess = {
  roomName: string;
  accessKey: string;
  role: "host" | "cohost" | "participant";
  displayName: string;
  joinCode?: string;
};

export type MeetingAttendance = {
  participantId: string;
  displayName: string;
  joinedAt: string;
  lastSeenAt: string;
  leftAt: string | null;
};

export type MeetingControls = {
  locked: boolean;
  chatEnabled: boolean;
  reactionsEnabled: boolean;
  handRaiseEnabled: boolean;
  participantMicrophoneEnabled: boolean;
  participantCameraEnabled: boolean;
  updatedAt: string;
};

export type MeetingMessage = {
  id: string;
  roomName: string;
  participantId: string;
  displayName: string;
  body: string;
  createdAt: string;
};

export type MeetingSignal = {
  participantId: string;
  displayName: string;
  handRaised: boolean;
  reaction: string | null;
  updatedAt: string;
};

export type MeetingRecording = {
  id: string;
  roomName: string;
  egressId: string;
  status:
    | "starting"
    | "active"
    | "stopping"
    | "complete"
    | "failed"
    | "aborted";
  filepath: string;
  location: string | null;
  startedAt: string;
  endedAt: string | null;
  durationNs: string | null;
  sizeBytes: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MeetingRecordingConsent = {
  roomName: string;
  participantId: string;
  displayName: string;
  consent: "accepted" | "declined";
  updatedAt: string;
};

export type MeetingRecordingState = {
  configured: boolean;
  active: MeetingRecording | null;
  consent: MeetingRecordingConsent | null;
  consents: MeetingRecordingConsent[];
  recordings: MeetingRecording[];
};

export type MeetingHistoryItem = {
  roomName: string;
  title: string;
  status: "scheduled" | "live" | "ended" | "cancelled";
  role: "host" | "cohost" | "participant";
  createdAt: string;
  scheduledStartAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  joinCode: string | null;
  participantCount: number;
  attendanceCount: number;
  recordingCount: number;
};

export type MeetingAttendanceReport = {
  roomName: string;
  title: string;
  status: "scheduled" | "live" | "ended" | "cancelled";
  startedAt: string | null;
  endedAt: string | null;
  meetingDurationMs: number;
  participantCount: number;
  totalAttendanceMs: number;
  rows: Array<{
    participantId: string;
    displayName: string;
    joinedAt: string;
    lastSeenAt: string;
    leftAt: string | null;
    durationMs: number;
  }>;
};

export type MeetingBreakoutRoom = {
  parentRoomName: string;
  groupId: string;
  groupLabel: string;
  livekitRoomName: string;
  status: "open" | "closed";
  durationMinutes: number | null;
  openedAt: string;
  closedAt: string | null;
};

export type MeetingBreakoutAssignment = {
  parentRoomName: string;
  participantId: string;
  displayName: string;
  groupId: string;
  livekitRoomName: string;
  assignedAt: string;
  returnedAt: string | null;
};

export type MeetingBreakoutState = {
  rooms: MeetingBreakoutRoom[];
  assignments: MeetingBreakoutAssignment[];
};

export type MeetingCaptionState = {
  roomName: string;
  desiredState: "running" | "stopped" | "error";
  agentName: string | null;
  dispatchId: string | null;
  model: string | null;
  language: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type MeetingCaptionStatus = {
  configured: boolean;
  state: MeetingCaptionState;
};

export type MeetingTranscriptSegment = {
  segmentId: string;
  participantIdentity: string;
  participantName?: string;
  trackSid?: string;
  text: string;
  isFinal: boolean;
  sourceTimestamp?: number;
  receivedAt?: string;
};

export type MeetingNotes = {
  roomName: string;
  body: string;
  updatedByParticipantId: string | null;
  updatedByDisplayName: string | null;
  updatedAt: string;
};

export type MeetingSummary = {
  id: string;
  roomName: string;
  summary: string;
  actionItems: string[];
  provider: string;
  createdByParticipantId: string;
  createdByDisplayName: string;
  createdAt: string;
};

export type MeetingAuditEvent = {
  id: string;
  roomName: string;
  actorParticipantId: string | null;
  actorDisplayName: string;
  eventType: string;
  targetParticipantId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

function normalizedOrigin(value: string) {
  return value.trim().replace(/\/$/, "");
}

async function parseResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = new Error(String(body.error ?? "Meeting request failed."));
    Object.assign(error, { status: response.status, body });
    throw error;
  }
  return body as T;
}

export class WorkspaceMeetingGateway {
  readonly origin: string;

  constructor(origin: string) {
    const value = normalizedOrigin(origin);
    if (!value) throw new Error("Workspace meeting gateway origin is required.");
    this.origin = value;
  }

  private url(path: string) {
    return this.origin + path;
  }

  async capabilities() {
    const response = await fetch(this.url("/v1/meet/capabilities"), {
      cache: "no-store"
    });
    return parseResponse<{
      service: string;
      nativeWorkspaceRuntime: boolean;
      persistence: string;
      mediaProvider: string;
      mediaConfigured: boolean;
      recordingConfigured: boolean;
      transcriptionConfigured: boolean;
      capabilities: Record<string, boolean>;
    }>(response);
  }

  async createMeeting(
    input: MeetingCreateInput & { displayName: string }
  ) {
    const response = await fetch(this.url("/v1/meetings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    return parseResponse<{
      meeting: MeetingJoinContext;
      joinCode: string;
      accessKey: string;
    }>(response);
  }

  async joinMeeting(code: string, displayName: string) {
    const response = await fetch(this.url("/v1/meetings/join"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: normalizeMeetingCode(code),
        displayName
      })
    });
    return parseResponse<{
      meeting: MeetingJoinContext;
      accessKey: string;
    }>(response);
  }

  async listHistory(
    entries: Array<Pick<MeetingAccess, "roomName" | "accessKey">>
  ) {
    const response = await fetch(this.url("/v1/meetings/history"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries })
    });
    const body = await parseResponse<{ history: MeetingHistoryItem[] }>(
      response
    );
    return body.history;
  }

  async getContext(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/context")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    const body = await parseResponse<{ meeting: MeetingJoinContext }>(response);
    return body.meeting;
  }

  async listParticipants(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/participants")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    const body = await parseResponse<{ participants: MeetingParticipant[] }>(response);
    return body.participants;
  }

  async getCollaboration(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/collaboration")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    return parseResponse<{
      controls: MeetingControls;
      messages: MeetingMessage[];
      signals: MeetingSignal[];
    }>(response);
  }

  async sendMessage(roomName: string, accessKey: string, message: string) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/chat"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, message })
      }
    );
    return parseResponse<{ message: MeetingMessage }>(response);
  }

  async setSignal(
    roomName: string,
    accessKey: string,
    input: { handRaised: boolean; reaction?: string | null }
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/signal"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, ...input })
      }
    );
    return parseResponse<{ signal: MeetingSignal }>(response);
  }

  async updateControls(
    roomName: string,
    accessKey: string,
    patch: Partial<Pick<
      MeetingControls,
      | "locked"
      | "chatEnabled"
      | "reactionsEnabled"
      | "handRaiseEnabled"
      | "participantMicrophoneEnabled"
      | "participantCameraEnabled"
    >>
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/controls"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, ...patch })
      }
    );
    return parseResponse<{ controls: MeetingControls }>(response);
  }

  async setRole(
    roomName: string,
    accessKey: string,
    participantId: string,
    role: "cohost" | "participant"
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/role"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, participantId, role })
      }
    );
    return parseResponse<{
      participant: Pick<
        MeetingParticipant,
        "id" | "displayName" | "role" | "admissionStatus"
      >;
    }>(response);
  }

  async controlMedia(
    roomName: string,
    accessKey: string,
    action:
      | "mute-mic"
      | "stop-camera"
      | "mute-all-mics"
      | "stop-all-cameras",
    participantId?: string
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/media"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, participantId, action })
      }
    );
    return parseResponse<{
      ok: true;
      participantId?: string;
      affectedTracks: number;
    }>(response);
  }

  async moderate(
    roomName: string,
    accessKey: string,
    participantId: string,
    action: "remove" | "clear-hand"
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/moderate"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, participantId, action })
      }
    );
    return parseResponse<{ ok: true; participantId?: string }>(response);
  }

  async listAudit(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/audit")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    const body = await parseResponse<{ audit: MeetingAuditEvent[] }>(response);
    return body.audit;
  }

  async getBreakouts(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/breakouts")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    return parseResponse<MeetingBreakoutState>(response);
  }

  async publishBreakouts(
    roomName: string,
    accessKey: string,
    assignments: Array<{
      participantId: string;
      groupId: string;
      groupLabel: string;
    }>,
    durationMinutes: number
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/breakouts"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessKey,
          action: "publish",
          assignments,
          durationMinutes
        })
      }
    );
    return parseResponse<{
      ok: true;
      rooms: MeetingBreakoutRoom[];
      assignments: MeetingBreakoutAssignment[];
      durationMinutes: number;
    }>(response);
  }

  async returnAllBreakouts(roomName: string, accessKey: string) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/breakouts"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessKey,
          action: "return-all"
        })
      }
    );
    return parseResponse<{ ok: true; returned: number }>(response);
  }

  async issueBreakoutToken(roomName: string, accessKey: string) {
    const response = await fetch(
      this.url(
        "/v1/meetings/" +
          encodeURIComponent(roomName) +
          "/breakout-token"
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey })
      }
    );
    return parseResponse<{
      token: string;
      url: string;
      mediaRoom: string;
      groupId: string;
      groupLabel: string;
    }>(response);
  }

  async getCaptionStatus(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/captions")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    return parseResponse<MeetingCaptionStatus>(response);
  }

  async controlCaptions(
    roomName: string,
    accessKey: string,
    action: "start" | "stop",
    options?: { model?: string; language?: string }
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/captions"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessKey,
          action,
          model: options?.model,
          language: options?.language
        })
      }
    );
    return parseResponse<MeetingCaptionStatus>(response);
  }

  async getTranscript(
    roomName: string,
    accessKey: string,
    limit = 500
  ) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/transcript")
    );
    url.searchParams.set("accessKey", accessKey);
    url.searchParams.set("limit", String(limit));
    const response = await fetch(url, { cache: "no-store" });
    const body = await parseResponse<{
      segments: MeetingTranscriptSegment[];
    }>(response);
    return body.segments;
  }

  async getNotes(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/notes")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    const body = await parseResponse<{ notes: MeetingNotes }>(response);
    return body.notes;
  }

  async saveNotes(roomName: string, accessKey: string, body: string) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/notes"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, body })
      }
    );
    const result = await parseResponse<{ notes: MeetingNotes }>(response);
    return result.notes;
  }

  async getSummary(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/summary")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    const body = await parseResponse<{ summary: MeetingSummary | null }>(
      response
    );
    return body.summary;
  }

  async generateSummary(roomName: string, accessKey: string) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/summary"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey })
      }
    );
    const body = await parseResponse<{ summary: MeetingSummary }>(response);
    return body.summary;
  }

  async listAttendance(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/attendance")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    const body = await parseResponse<{ attendance: MeetingAttendance[] }>(response);
    return body.attendance;
  }

  async getRecordingState(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/recording")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    return parseResponse<MeetingRecordingState>(response);
  }

  async setRecordingConsent(
    roomName: string,
    accessKey: string,
    consent: "accepted" | "declined"
  ) {
    const response = await fetch(
      this.url(
        "/v1/meetings/" +
          encodeURIComponent(roomName) +
          "/recording-consent"
      ),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, consent })
      }
    );
    return parseResponse<{ consent: MeetingRecordingConsent }>(response);
  }

  async controlRecording(
    roomName: string,
    accessKey: string,
    action: "start" | "stop"
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/recording"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, action })
      }
    );
    return parseResponse<{ recording: MeetingRecording }>(response);
  }

  async getAttendanceReport(roomName: string, accessKey: string) {
    const url = new URL(
      this.url(
        "/v1/meetings/" +
          encodeURIComponent(roomName) +
          "/report/attendance"
      )
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    const body = await parseResponse<{ report: MeetingAttendanceReport }>(
      response
    );
    return body.report;
  }

  async heartbeat(roomName: string, accessKey: string) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/heartbeat"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey }),
        keepalive: true
      }
    );
    return parseResponse<{ ok: true; attendance: MeetingAttendance | null }>(
      response
    );
  }

  async leave(roomName: string, accessKey: string) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/leave"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey }),
        keepalive: true
      }
    );
    return parseResponse<{ ok: true; attendance: MeetingAttendance | null }>(
      response
    );
  }

  async setAdmission(
    roomName: string,
    accessKey: string,
    participantId: string,
    status: "admitted" | "denied"
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/admission"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, participantId, status })
      }
    );
    return parseResponse<{
      participant: Pick<MeetingParticipant, "id" | "displayName" | "admissionStatus">;
    }>(response);
  }

  async setLifecycle(
    roomName: string,
    accessKey: string,
    action: "start" | "end"
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/lifecycle"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, action })
      }
    );
    const body = await parseResponse<{ meeting: MeetingJoinContext }>(response);
    return body.meeting;
  }

  async issueToken(
    roomName: string,
    accessKey: string,
    displayName: string
  ) {
    const response = await fetch(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/token"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessKey, displayName })
      }
    );
    return parseResponse<{
      token: string;
      url: string;
      role: "host" | "cohost" | "participant";
      allowParticipantScreenShare: boolean;
      participantMicrophoneEnabled: boolean;
      participantCameraEnabled: boolean;
    }>(response);
  }
}

export function listMeetingAccesses(): MeetingAccess[] {
  if (typeof window === "undefined") return [];

  const prefix = "tamishra-workspace-meet:";
  const results: MeetingAccess[] = [];

  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;

    const raw = localStorage.getItem(key);
    if (!raw) continue;

    try {
      const parsed = JSON.parse(raw) as MeetingAccess;
      if (
        parsed.roomName &&
        parsed.accessKey &&
        parsed.displayName
      ) {
        results.push(parsed);
      }
    } catch {
      // Ignore invalid historical entries.
    }
  }

  return results;
}

export function meetingAccessStorageKey(roomName: string) {
  return "tamishra-workspace-meet:" + roomName;
}

export function saveMeetingAccess(access: MeetingAccess) {
  if (typeof window === "undefined") return;
  localStorage.setItem(
    meetingAccessStorageKey(access.roomName),
    JSON.stringify(access)
  );
}

export function loadMeetingAccess(roomName: string): MeetingAccess | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(meetingAccessStorageKey(roomName));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MeetingAccess;
    if (
      parsed.roomName !== roomName ||
      !parsed.accessKey ||
      !parsed.displayName
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
