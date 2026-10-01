import { randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type RecordingStatus =
  | "starting"
  | "active"
  | "stopping"
  | "complete"
  | "failed"
  | "aborted";

export type StoredMeetingRecording = {
  id: string;
  roomName: string;
  egressId: string;
  status: RecordingStatus;
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

export type RecordingConsentValue = "accepted" | "declined";

export type StoredRecordingConsent = {
  roomName: string;
  participantId: string;
  displayName: string;
  consent: RecordingConsentValue;
  updatedAt: string;
};

export interface MeetingRecordingStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  createRecording(
    input: Omit<StoredMeetingRecording, "id" | "createdAt" | "updatedAt">
  ): Promise<StoredMeetingRecording>;
  updateRecording(
    roomName: string,
    egressId: string,
    patch: Partial<
      Pick<
        StoredMeetingRecording,
        | "status"
        | "location"
        | "endedAt"
        | "durationNs"
        | "sizeBytes"
        | "error"
      >
    >
  ): Promise<StoredMeetingRecording | null>;
  getActiveRecording(roomName: string): Promise<StoredMeetingRecording | null>;
  listRecordings(
    roomName: string,
    limit?: number
  ): Promise<StoredMeetingRecording[]>;
  setConsent(
    roomName: string,
    participantId: string,
    displayName: string,
    consent: RecordingConsentValue
  ): Promise<StoredRecordingConsent>;
  getConsent(
    roomName: string,
    participantId: string
  ): Promise<StoredRecordingConsent | null>;
  listConsents(roomName: string): Promise<StoredRecordingConsent[]>;
  resetConsents(roomName: string): Promise<void>;
}

function nowIso() {
  return new Date().toISOString();
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toRecording(
  row: Record<string, unknown>
): StoredMeetingRecording {
  return {
    id: String(row.id),
    roomName: String(row.room_name),
    egressId: String(row.egress_id),
    status: String(row.status) as RecordingStatus,
    filepath: String(row.filepath),
    location: row.location ? String(row.location) : null,
    startedAt: iso(row.started_at) ?? nowIso(),
    endedAt: iso(row.ended_at),
    durationNs:
      row.duration_ns === null || row.duration_ns === undefined
        ? null
        : String(row.duration_ns),
    sizeBytes:
      row.size_bytes === null || row.size_bytes === undefined
        ? null
        : String(row.size_bytes),
    error: row.error ? String(row.error) : null,
    createdAt: iso(row.created_at) ?? nowIso(),
    updatedAt: iso(row.updated_at) ?? nowIso()
  };
}

function toConsent(
  row: Record<string, unknown>
): StoredRecordingConsent {
  return {
    roomName: String(row.room_name),
    participantId: String(row.participant_id),
    displayName: String(row.display_name),
    consent: String(row.consent) as RecordingConsentValue,
    updatedAt: iso(row.updated_at) ?? nowIso()
  };
}

class MemoryMeetingRecordingStore implements MeetingRecordingStore {
  readonly kind = "ephemeral-memory" as const;
  private readonly recordings = new Map<string, StoredMeetingRecording>();
  private readonly consents = new Map<string, StoredRecordingConsent>();

  async ready() {}

  async createRecording(
    input: Omit<StoredMeetingRecording, "id" | "createdAt" | "updatedAt">
  ) {
    const now = nowIso();
    const recording: StoredMeetingRecording = {
      ...input,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now
    };
    this.recordings.set(recording.id, recording);
    return recording;
  }

  async updateRecording(
    roomName: string,
    egressId: string,
    patch: Partial<
      Pick<
        StoredMeetingRecording,
        | "status"
        | "location"
        | "endedAt"
        | "durationNs"
        | "sizeBytes"
        | "error"
      >
    >
  ) {
    const recording = Array.from(this.recordings.values()).find(
      (item) => item.roomName === roomName && item.egressId === egressId
    );
    if (!recording) return null;
    Object.assign(recording, patch, { updatedAt: nowIso() });
    return recording;
  }

  async getActiveRecording(roomName: string) {
    return (
      Array.from(this.recordings.values())
        .filter(
          (item) =>
            item.roomName === roomName &&
            ["starting", "active", "stopping"].includes(item.status)
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    );
  }

  async listRecordings(roomName: string, limit = 20) {
    return Array.from(this.recordings.values())
      .filter((item) => item.roomName === roomName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  }

  async setConsent(
    roomName: string,
    participantId: string,
    displayName: string,
    consent: RecordingConsentValue
  ) {
    const value: StoredRecordingConsent = {
      roomName,
      participantId,
      displayName,
      consent,
      updatedAt: nowIso()
    };
    this.consents.set(roomName + ":" + participantId, value);
    return value;
  }

  async getConsent(roomName: string, participantId: string) {
    return this.consents.get(roomName + ":" + participantId) ?? null;
  }

  async listConsents(roomName: string) {
    return Array.from(this.consents.values())
      .filter((item) => item.roomName === roomName)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async resetConsents(roomName: string) {
    const prefix = roomName + ":";
    for (const key of this.consents.keys()) {
      if (key.startsWith(prefix)) this.consents.delete(key);
    }
  }
}

class PostgresMeetingRecordingStore implements MeetingRecordingStore {
  readonly kind = "postgres" as const;
  private readonly sql: NeonQueryFunction<false, false>;
  private readyPromise: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon<false, false>(databaseUrl);
  }

  ready() {
    this.readyPromise ??= this.initialize();
    return this.readyPromise;
  }

  private async initialize() {
    await this.sql`
      create table if not exists workspace_meeting_recordings (
        id text primary key,
        room_name text not null
          references workspace_meetings(room_name) on delete cascade,
        egress_id text not null unique,
        status text not null,
        filepath text not null,
        location text,
        started_at timestamptz not null,
        ended_at timestamptz,
        duration_ns numeric,
        size_bytes numeric,
        error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create index if not exists workspace_meeting_recordings_room_idx
      on workspace_meeting_recordings(room_name, created_at desc)
    `;

    await this.sql`
      create table if not exists workspace_meeting_recording_consents (
        room_name text not null
          references workspace_meetings(room_name) on delete cascade,
        participant_id text not null
          references workspace_meeting_participants(id) on delete cascade,
        display_name text not null,
        consent text not null,
        updated_at timestamptz not null default now(),
        primary key(room_name, participant_id)
      )
    `;

    await this.sql`
      create index if not exists workspace_meeting_recording_consents_room_idx
      on workspace_meeting_recording_consents(room_name, updated_at desc)
    `;
  }

  async createRecording(
    input: Omit<StoredMeetingRecording, "id" | "createdAt" | "updatedAt">
  ) {
    await this.ready();
    const id = randomUUID();
    const rows = await this.sql`
      insert into workspace_meeting_recordings(
        id,
        room_name,
        egress_id,
        status,
        filepath,
        location,
        started_at,
        ended_at,
        duration_ns,
        size_bytes,
        error
      ) values (
        ${id},
        ${input.roomName},
        ${input.egressId},
        ${input.status},
        ${input.filepath},
        ${input.location},
        ${input.startedAt},
        ${input.endedAt},
        ${input.durationNs},
        ${input.sizeBytes},
        ${input.error}
      )
      returning *
    `;
    return toRecording(rows[0] as Record<string, unknown>);
  }

  async updateRecording(
    roomName: string,
    egressId: string,
    patch: Partial<
      Pick<
        StoredMeetingRecording,
        | "status"
        | "location"
        | "endedAt"
        | "durationNs"
        | "sizeBytes"
        | "error"
      >
    >
  ) {
    await this.ready();
    const currentRows = await this.sql`
      select *
      from workspace_meeting_recordings
      where room_name=${roomName} and egress_id=${egressId}
      limit 1
    `;
    if (!currentRows[0]) return null;

    const current = toRecording(
      currentRows[0] as Record<string, unknown>
    );

    const rows = await this.sql`
      update workspace_meeting_recordings
      set
        status=${patch.status ?? current.status},
        location=${patch.location ?? current.location},
        ended_at=${patch.endedAt ?? current.endedAt},
        duration_ns=${patch.durationNs ?? current.durationNs},
        size_bytes=${patch.sizeBytes ?? current.sizeBytes},
        error=${patch.error ?? current.error},
        updated_at=now()
      where room_name=${roomName} and egress_id=${egressId}
      returning *
    `;

    return rows[0]
      ? toRecording(rows[0] as Record<string, unknown>)
      : null;
  }

  async getActiveRecording(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      select *
      from workspace_meeting_recordings
      where room_name=${roomName}
        and status in ('starting','active','stopping')
      order by created_at desc
      limit 1
    `;
    return rows[0]
      ? toRecording(rows[0] as Record<string, unknown>)
      : null;
  }

  async listRecordings(roomName: string, limit = 20) {
    await this.ready();
    const safeLimit = Math.max(1, Math.min(limit, 100));
    const rows = await this.sql`
      select *
      from workspace_meeting_recordings
      where room_name=${roomName}
      order by created_at desc
      limit ${safeLimit}
    `;
    return rows.map((row) =>
      toRecording(row as Record<string, unknown>)
    );
  }

  async setConsent(
    roomName: string,
    participantId: string,
    displayName: string,
    consent: RecordingConsentValue
  ) {
    await this.ready();
    const rows = await this.sql`
      insert into workspace_meeting_recording_consents(
        room_name,
        participant_id,
        display_name,
        consent,
        updated_at
      ) values (
        ${roomName},
        ${participantId},
        ${displayName},
        ${consent},
        now()
      )
      on conflict(room_name, participant_id) do update set
        display_name=excluded.display_name,
        consent=excluded.consent,
        updated_at=now()
      returning *
    `;
    return toConsent(rows[0] as Record<string, unknown>);
  }

  async getConsent(roomName: string, participantId: string) {
    await this.ready();
    const rows = await this.sql`
      select *
      from workspace_meeting_recording_consents
      where room_name=${roomName} and participant_id=${participantId}
      limit 1
    `;
    return rows[0]
      ? toConsent(rows[0] as Record<string, unknown>)
      : null;
  }

  async listConsents(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      select *
      from workspace_meeting_recording_consents
      where room_name=${roomName}
      order by display_name asc
    `;
    return rows.map((row) =>
      toConsent(row as Record<string, unknown>)
    );
  }

  async resetConsents(roomName: string) {
    await this.ready();
    await this.sql`
      delete from workspace_meeting_recording_consents
      where room_name=${roomName}
    `;
  }
}

export function createMeetingRecordingStore(): MeetingRecordingStore {
  const databaseUrl =
    process.env.WORKSPACE_MEET_DATABASE_URL?.trim() ||
    process.env.WORKSPACE_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();

  return databaseUrl
    ? new PostgresMeetingRecordingStore(databaseUrl)
    : new MemoryMeetingRecordingStore();
}
