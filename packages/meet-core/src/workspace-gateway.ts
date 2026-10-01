import {
  normalizeMeetingCode,
  type MeetingCreateInput,
  type MeetingJoinContext
} from "./index";

export type MeetingParticipant = {
  id: string;
  displayName: string;
  role: "host" | "participant";
  admissionStatus: "waiting" | "admitted" | "denied";
  createdAt: string;
  lastSeenAt: string;
};

export type MeetingAccess = {
  roomName: string;
  accessKey: string;
  role: "host" | "participant";
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

  async listAttendance(roomName: string, accessKey: string) {
    const url = new URL(
      this.url("/v1/meetings/" + encodeURIComponent(roomName) + "/attendance")
    );
    url.searchParams.set("accessKey", accessKey);
    const response = await fetch(url, { cache: "no-store" });
    const body = await parseResponse<{ attendance: MeetingAttendance[] }>(response);
    return body.attendance;
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
      role: "host" | "participant";
      allowParticipantScreenShare: boolean;
    }>(response);
  }
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
