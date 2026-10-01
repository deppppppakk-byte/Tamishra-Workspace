import { randomUUID } from "node:crypto";
import postgres from "postgres";

export type CaptionRunState = "running" | "stopped" | "error";

export type StoredCaptionState = {
  roomName: string;
  desiredState: CaptionRunState;
  agentName: string | null;
  dispatchId: string | null;
  model: string | null;
  language: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  updatedAt: string;
};

export type TranscriptSegment = {
  segmentId: string;
  participantIdentity: string;
  participantName?: string;
  trackSid?: string;
  text: string;
  isFinal: boolean;
  sourceTimestamp?: number;
  receivedAt?: string;
};

export type StoredMeetingNotes = {
  roomName: string;
  body: string;
  updatedByParticipantId: string | null;
  updatedByDisplayName: string | null;
  updatedAt: string;
};

export type StoredMeetingSummary = {
  id: string;
  roomName: string;
  summary: string;
  actionItems: string[];
  provider: string;
  createdByParticipantId: string;
  createdByDisplayName: string;
  createdAt: string;
};

export interface MeetingIntelligenceStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  getCaptionState(roomName: string): Promise<StoredCaptionState>;
  saveCaptionState(
    roomName: string,
    patch: Partial<Omit<StoredCaptionState, "roomName" | "updatedAt">>
  ): Promise<StoredCaptionState>;
  upsertTranscript(
    roomName: string,
    segments: TranscriptSegment[]
  ): Promise<number>;
  listTranscript(
    roomName: string,
    limit?: number
  ): Promise<TranscriptSegment[]>;
  getNotes(roomName: string): Promise<StoredMeetingNotes>;
  saveNotes(
    roomName: string,
    body: string,
    participantId: string,
    displayName: string
  ): Promise<StoredMeetingNotes>;
  saveSummary(
    input: Omit<StoredMeetingSummary, "id" | "createdAt">
  ): Promise<StoredMeetingSummary>;
  getLatestSummary(roomName: string): Promise<StoredMeetingSummary | null>;
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function defaultCaptionState(roomName: string): StoredCaptionState {
  return {
    roomName,
    desiredState: "stopped",
    agentName: null,
    dispatchId: null,
    model: null,
    language: null,
    lastHeartbeatAt: null,
    lastError: null,
    updatedAt: new Date().toISOString()
  };
}

function toCaption(row: Record<string, unknown>): StoredCaptionState {
  return {
    roomName: String(row.room_name),
    desiredState: String(row.desired_state) as CaptionRunState,
    agentName: row.agent_name ? String(row.agent_name) : null,
    dispatchId: row.dispatch_id ? String(row.dispatch_id) : null,
    model: row.model ? String(row.model) : null,
    language: row.language ? String(row.language) : null,
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    lastError: row.last_error ? String(row.last_error) : null,
    updatedAt: iso(row.updated_at) ?? new Date().toISOString()
  };
}

function toSegment(row: Record<string, unknown>): TranscriptSegment {
  return {
    segmentId: String(row.segment_id),
    participantIdentity: String(row.participant_identity),
    participantName: row.participant_name
      ? String(row.participant_name)
      : undefined,
    trackSid: row.track_sid ? String(row.track_sid) : undefined,
    text: String(row.text),
    isFinal: Boolean(row.is_final),
    sourceTimestamp:
      row.source_timestamp === null || row.source_timestamp === undefined
        ? undefined
        : Number(row.source_timestamp),
    receivedAt:
      iso(row.first_received_at) ?? new Date().toISOString()
  };
}

function toNotes(row: Record<string, unknown> | undefined, roomName: string) {
  if (!row) {
    return {
      roomName,
      body: "",
      updatedByParticipantId: null,
      updatedByDisplayName: null,
      updatedAt: new Date(0).toISOString()
    } satisfies StoredMeetingNotes;
  }

  return {
    roomName: String(row.room_name),
    body: String(row.body ?? ""),
    updatedByParticipantId: row.updated_by_participant_id
      ? String(row.updated_by_participant_id)
      : null,
    updatedByDisplayName: row.updated_by_display_name
      ? String(row.updated_by_display_name)
      : null,
    updatedAt: iso(row.updated_at) ?? new Date().toISOString()
  } satisfies StoredMeetingNotes;
}

function toSummary(row: Record<string, unknown>): StoredMeetingSummary {
  const rawItems = row.action_items;
  const actionItems = Array.isArray(rawItems)
    ? rawItems.map(String)
    : typeof rawItems === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(rawItems);
            return Array.isArray(parsed) ? parsed.map(String) : [];
          } catch {
            return [];
          }
        })()
      : [];

  return {
    id: String(row.id),
    roomName: String(row.room_name),
    summary: String(row.summary),
    actionItems,
    provider: String(row.provider),
    createdByParticipantId: String(row.created_by_participant_id),
    createdByDisplayName: String(row.created_by_display_name),
    createdAt: iso(row.created_at) ?? new Date().toISOString()
  };
}

class MemoryMeetingIntelligenceStore implements MeetingIntelligenceStore {
  readonly kind = "ephemeral-memory" as const;
  private readonly captions = new Map<string, StoredCaptionState>();
  private readonly transcript = new Map<string, Map<string, TranscriptSegment>>();
  private readonly notes = new Map<string, StoredMeetingNotes>();
  private readonly summaries = new Map<string, StoredMeetingSummary[]>();

  async ready() {}

  async getCaptionState(roomName: string) {
    return this.captions.get(roomName) ?? defaultCaptionState(roomName);
  }

  async saveCaptionState(
    roomName: string,
    patch: Partial<Omit<StoredCaptionState, "roomName" | "updatedAt">>
  ) {
    const current = await this.getCaptionState(roomName);
    const next: StoredCaptionState = {
      ...current,
      ...patch,
      roomName,
      updatedAt: new Date().toISOString()
    };
    this.captions.set(roomName, next);
    return next;
  }

  async upsertTranscript(roomName: string, segments: TranscriptSegment[]) {
    let room = this.transcript.get(roomName);
    if (!room) {
      room = new Map();
      this.transcript.set(roomName, room);
    }

    let saved = 0;
    for (const segment of segments) {
      if (!segment.segmentId || !segment.participantIdentity || !segment.text) {
        continue;
      }
      const prior = room.get(segment.segmentId);
      room.set(segment.segmentId, {
        ...prior,
        ...segment,
        receivedAt: prior?.receivedAt ?? segment.receivedAt ?? new Date().toISOString()
      });
      saved += 1;
    }
    return saved;
  }

  async listTranscript(roomName: string, limit = 1000) {
    return Array.from(this.transcript.get(roomName)?.values() ?? [])
      .sort((a, b) =>
        String(a.receivedAt ?? "").localeCompare(String(b.receivedAt ?? ""))
      )
      .slice(-Math.max(1, Math.min(limit, 10_000)));
  }

  async getNotes(roomName: string) {
    return this.notes.get(roomName) ?? toNotes(undefined, roomName);
  }

  async saveNotes(
    roomName: string,
    body: string,
    participantId: string,
    displayName: string
  ) {
    const value: StoredMeetingNotes = {
      roomName,
      body,
      updatedByParticipantId: participantId,
      updatedByDisplayName: displayName,
      updatedAt: new Date().toISOString()
    };
    this.notes.set(roomName, value);
    return value;
  }

  async saveSummary(
    input: Omit<StoredMeetingSummary, "id" | "createdAt">
  ) {
    const value: StoredMeetingSummary = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString()
    };
    const room = this.summaries.get(input.roomName) ?? [];
    room.push(value);
    this.summaries.set(input.roomName, room);
    return value;
  }

  async getLatestSummary(roomName: string) {
    const room = this.summaries.get(roomName) ?? [];
    return room[room.length - 1] ?? null;
  }
}

class PostgresMeetingIntelligenceStore implements MeetingIntelligenceStore {
  readonly kind = "postgres" as const;
  private readonly sql: ReturnType<typeof postgres>;
  private readyPromise: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5, prepare: false });
  }

  ready() {
    this.readyPromise ??= this.initialize();
    return this.readyPromise;
  }

  private async initialize() {
    await this.sql`
      create table if not exists workspace_meeting_caption_state (
        room_name text primary key
          references workspace_meetings(room_name) on delete cascade,
        desired_state text not null default 'stopped',
        agent_name text,
        dispatch_id text,
        model text,
        language text,
        last_heartbeat_at timestamptz,
        last_error text,
        updated_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create table if not exists workspace_meeting_transcript_segments (
        room_name text not null
          references workspace_meetings(room_name) on delete cascade,
        segment_id text not null,
        participant_identity text not null,
        participant_name text,
        track_sid text,
        text text not null,
        is_final boolean not null default false,
        source_timestamp bigint,
        first_received_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key(room_name, segment_id)
      )
    `;

    await this.sql`
      create index if not exists workspace_meeting_transcript_room_idx
      on workspace_meeting_transcript_segments(room_name, first_received_at)
    `;

    await this.sql`
      create table if not exists workspace_meeting_notes (
        room_name text primary key
          references workspace_meetings(room_name) on delete cascade,
        body text not null default '',
        updated_by_participant_id text,
        updated_by_display_name text,
        updated_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create table if not exists workspace_meeting_summaries (
        id text primary key,
        room_name text not null
          references workspace_meetings(room_name) on delete cascade,
        summary text not null,
        action_items jsonb not null default '[]'::jsonb,
        provider text not null,
        created_by_participant_id text not null,
        created_by_display_name text not null,
        created_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create index if not exists workspace_meeting_summaries_room_idx
      on workspace_meeting_summaries(room_name, created_at desc)
    `;
  }

  async getCaptionState(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      select *
      from workspace_meeting_caption_state
      where room_name=${roomName}
      limit 1
    `;
    return rows[0]
      ? toCaption(rows[0] as Record<string, unknown>)
      : defaultCaptionState(roomName);
  }

  async saveCaptionState(
    roomName: string,
    patch: Partial<Omit<StoredCaptionState, "roomName" | "updatedAt">>
  ) {
    await this.ready();
    const current = await this.getCaptionState(roomName);
    const next = { ...current, ...patch };

    const rows = await this.sql`
      insert into workspace_meeting_caption_state(
        room_name,
        desired_state,
        agent_name,
        dispatch_id,
        model,
        language,
        last_heartbeat_at,
        last_error,
        updated_at
      ) values (
        ${roomName},
        ${next.desiredState},
        ${next.agentName},
        ${next.dispatchId},
        ${next.model},
        ${next.language},
        ${next.lastHeartbeatAt},
        ${next.lastError},
        now()
      )
      on conflict(room_name) do update set
        desired_state=excluded.desired_state,
        agent_name=excluded.agent_name,
        dispatch_id=excluded.dispatch_id,
        model=excluded.model,
        language=excluded.language,
        last_heartbeat_at=excluded.last_heartbeat_at,
        last_error=excluded.last_error,
        updated_at=now()
      returning *
    `;

    return toCaption(rows[0] as Record<string, unknown>);
  }

  async upsertTranscript(roomName: string, segments: TranscriptSegment[]) {
    await this.ready();
    let saved = 0;

    for (const segment of segments.slice(0, 200)) {
      const id = String(segment.segmentId || "").slice(0, 200);
      const identity = String(segment.participantIdentity || "").slice(0, 255);
      const text = String(segment.text || "").slice(0, 8000);
      if (!id || !identity || !text) continue;

      await this.sql`
        insert into workspace_meeting_transcript_segments(
          room_name,
          segment_id,
          participant_identity,
          participant_name,
          track_sid,
          text,
          is_final,
          source_timestamp,
          first_received_at,
          updated_at
        ) values (
          ${roomName},
          ${id},
          ${identity},
          ${segment.participantName?.slice(0, 255) ?? null},
          ${segment.trackSid?.slice(0, 255) ?? null},
          ${text},
          ${Boolean(segment.isFinal)},
          ${segment.sourceTimestamp ?? null},
          ${segment.receivedAt ?? new Date().toISOString()},
          now()
        )
        on conflict(room_name, segment_id) do update set
          participant_identity=excluded.participant_identity,
          participant_name=coalesce(
            excluded.participant_name,
            workspace_meeting_transcript_segments.participant_name
          ),
          track_sid=coalesce(
            excluded.track_sid,
            workspace_meeting_transcript_segments.track_sid
          ),
          text=excluded.text,
          is_final=excluded.is_final,
          source_timestamp=coalesce(
            excluded.source_timestamp,
            workspace_meeting_transcript_segments.source_timestamp
          ),
          updated_at=now()
      `;
      saved += 1;
    }

    return saved;
  }

  async listTranscript(roomName: string, limit = 1000) {
    await this.ready();
    const safeLimit = Math.max(1, Math.min(limit, 10_000));
    const rows = await this.sql`
      select *
      from workspace_meeting_transcript_segments
      where room_name=${roomName}
      order by first_received_at desc
      limit ${safeLimit}
    `;

    return rows
      .map((row) => toSegment(row as Record<string, unknown>))
      .reverse();
  }

  async getNotes(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      select *
      from workspace_meeting_notes
      where room_name=${roomName}
      limit 1
    `;
    return toNotes(
      rows[0] as Record<string, unknown> | undefined,
      roomName
    );
  }

  async saveNotes(
    roomName: string,
    body: string,
    participantId: string,
    displayName: string
  ) {
    await this.ready();
    const rows = await this.sql`
      insert into workspace_meeting_notes(
        room_name,
        body,
        updated_by_participant_id,
        updated_by_display_name,
        updated_at
      ) values (
        ${roomName},
        ${body},
        ${participantId},
        ${displayName},
        now()
      )
      on conflict(room_name) do update set
        body=excluded.body,
        updated_by_participant_id=excluded.updated_by_participant_id,
        updated_by_display_name=excluded.updated_by_display_name,
        updated_at=now()
      returning *
    `;
    return toNotes(rows[0] as Record<string, unknown>, roomName);
  }

  async saveSummary(
    input: Omit<StoredMeetingSummary, "id" | "createdAt">
  ) {
    await this.ready();
    const id = randomUUID();
    const rows = await this.sql`
      insert into workspace_meeting_summaries(
        id,
        room_name,
        summary,
        action_items,
        provider,
        created_by_participant_id,
        created_by_display_name
      ) values (
        ${id},
        ${input.roomName},
        ${input.summary},
        ${JSON.stringify(input.actionItems)}::jsonb,
        ${input.provider},
        ${input.createdByParticipantId},
        ${input.createdByDisplayName}
      )
      returning *
    `;
    return toSummary(rows[0] as Record<string, unknown>);
  }

  async getLatestSummary(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      select *
      from workspace_meeting_summaries
      where room_name=${roomName}
      order by created_at desc
      limit 1
    `;
    return rows[0]
      ? toSummary(rows[0] as Record<string, unknown>)
      : null;
  }
}

export function createMeetingIntelligenceStore(): MeetingIntelligenceStore {
  const databaseUrl =
    process.env.WORKSPACE_MEET_DATABASE_URL?.trim() ||
    process.env.WORKSPACE_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();

  return databaseUrl
    ? new PostgresMeetingIntelligenceStore(databaseUrl)
    : new MemoryMeetingIntelligenceStore();
}
