import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type StoredMeetingStatus =
  | "scheduled"
  | "live"
  | "ended"
  | "cancelled";

export type StoredMeetingRole = "host" | "participant";

export type StoredAdmissionStatus = "waiting" | "admitted" | "denied";

export type StoredMeeting = {
  roomName: string;
  title: string;
  status: StoredMeetingStatus;
  joinCode: string;
  scheduledStartAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  waitingRoomEnabled: boolean;
  allowParticipantScreenShare: boolean;
  createdAt: string;
};

export type StoredParticipant = {
  id: string;
  roomName: string;
  displayName: string;
  role: StoredMeetingRole;
  accessKeyHash: string;
  admissionStatus: StoredAdmissionStatus;
  createdAt: string;
  lastSeenAt: string;
};

export interface MeetingStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  createMeeting(
    meeting: StoredMeeting,
    host: StoredParticipant
  ): Promise<void>;
  getMeeting(roomName: string): Promise<StoredMeeting | null>;
  findMeetingByJoinCode(code: string): Promise<StoredMeeting | null>;
  addParticipant(participant: StoredParticipant): Promise<void>;
  findParticipantByAccessHash(
    roomName: string,
    accessKeyHash: string
  ): Promise<StoredParticipant | null>;
  listParticipants(roomName: string): Promise<StoredParticipant[]>;
  updateParticipantPresence(
    roomName: string,
    participantId: string,
    displayName?: string
  ): Promise<void>;
  updateAdmission(
    roomName: string,
    participantId: string,
    status: "admitted" | "denied"
  ): Promise<StoredParticipant | null>;
  startMeeting(roomName: string): Promise<StoredMeeting | null>;
  endMeeting(roomName: string): Promise<StoredMeeting | null>;
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toMeeting(row: Record<string, unknown>): StoredMeeting {
  return {
    roomName: String(row.room_name),
    title: String(row.title),
    status: String(row.status) as StoredMeetingStatus,
    joinCode: String(row.join_code),
    scheduledStartAt: iso(row.scheduled_start_at),
    startedAt: iso(row.started_at),
    endedAt: iso(row.ended_at),
    waitingRoomEnabled: Boolean(row.waiting_room_enabled),
    allowParticipantScreenShare: Boolean(
      row.allow_participant_screen_share
    ),
    createdAt: iso(row.created_at) ?? new Date().toISOString()
  };
}

function toParticipant(
  row: Record<string, unknown>
): StoredParticipant {
  return {
    id: String(row.id),
    roomName: String(row.room_name),
    displayName: String(row.display_name),
    role: String(row.role) as StoredMeetingRole,
    accessKeyHash: String(row.access_key_hash),
    admissionStatus: String(
      row.admission_status
    ) as StoredAdmissionStatus,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    lastSeenAt: iso(row.last_seen_at) ?? new Date().toISOString()
  };
}

class MemoryMeetingStore implements MeetingStore {
  readonly kind = "ephemeral-memory" as const;
  private readonly meetings = new Map<string, StoredMeeting>();
  private readonly participants = new Map<string, StoredParticipant>();

  async ready() {}

  async createMeeting(
    meeting: StoredMeeting,
    host: StoredParticipant
  ) {
    this.meetings.set(meeting.roomName, meeting);
    this.participants.set(host.id, host);
  }

  async getMeeting(roomName: string) {
    return this.meetings.get(roomName) ?? null;
  }

  async findMeetingByJoinCode(code: string) {
    for (const meeting of this.meetings.values()) {
      if (meeting.joinCode === code) return meeting;
    }
    return null;
  }

  async addParticipant(participant: StoredParticipant) {
    this.participants.set(participant.id, participant);
  }

  async findParticipantByAccessHash(
    roomName: string,
    accessKeyHash: string
  ) {
    for (const participant of this.participants.values()) {
      if (
        participant.roomName === roomName &&
        participant.accessKeyHash === accessKeyHash
      ) {
        return participant;
      }
    }
    return null;
  }

  async listParticipants(roomName: string) {
    return Array.from(this.participants.values())
      .filter((participant) => participant.roomName === roomName)
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === "host" ? -1 : 1;
        return left.createdAt.localeCompare(right.createdAt);
      });
  }

  async updateParticipantPresence(
    roomName: string,
    participantId: string,
    displayName?: string
  ) {
    const participant = this.participants.get(participantId);
    if (!participant || participant.roomName !== roomName) return;
    if (displayName) participant.displayName = displayName;
    participant.lastSeenAt = new Date().toISOString();
  }

  async updateAdmission(
    roomName: string,
    participantId: string,
    status: "admitted" | "denied"
  ) {
    const participant = this.participants.get(participantId);
    if (
      !participant ||
      participant.roomName !== roomName ||
      participant.role === "host"
    ) {
      return null;
    }
    participant.admissionStatus = status;
    participant.lastSeenAt = new Date().toISOString();
    return participant;
  }

  async startMeeting(roomName: string) {
    const meeting = this.meetings.get(roomName);
    if (!meeting) return null;
    meeting.status = "live";
    meeting.startedAt ??= new Date().toISOString();
    meeting.endedAt = null;
    return meeting;
  }

  async endMeeting(roomName: string) {
    const meeting = this.meetings.get(roomName);
    if (!meeting) return null;
    meeting.status = "ended";
    meeting.endedAt = new Date().toISOString();
    return meeting;
  }
}

class PostgresMeetingStore implements MeetingStore {
  readonly kind = "postgres" as const;
  private readonly sql: NeonQueryFunction<false, false>;
  private readyPromise: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = neon<false, false>(databaseUrl);
  }

  ready() {
    if (!this.readyPromise) {
      this.readyPromise = this.initialize();
    }
    return this.readyPromise;
  }

  private async initialize() {
    await this.sql`
      create table if not exists workspace_meetings (
        room_name text primary key,
        title text not null,
        status text not null,
        join_code varchar(10) not null unique,
        scheduled_start_at timestamptz,
        started_at timestamptz,
        ended_at timestamptz,
        waiting_room_enabled boolean not null default true,
        allow_participant_screen_share boolean not null default true,
        created_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create table if not exists workspace_meeting_participants (
        id text primary key,
        room_name text not null references workspace_meetings(room_name) on delete cascade,
        display_name text not null,
        role text not null,
        access_key_hash text not null unique,
        admission_status text not null,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create index if not exists workspace_meeting_participants_room_idx
      on workspace_meeting_participants(room_name, created_at)
    `;

    await this.sql`
      create index if not exists workspace_meetings_status_idx
      on workspace_meetings(status, created_at desc)
    `;
  }

  async createMeeting(
    meeting: StoredMeeting,
    host: StoredParticipant
  ) {
    await this.ready();

    await this.sql`
      insert into workspace_meetings (
        room_name,
        title,
        status,
        join_code,
        scheduled_start_at,
        started_at,
        ended_at,
        waiting_room_enabled,
        allow_participant_screen_share,
        created_at
      ) values (
        ${meeting.roomName},
        ${meeting.title},
        ${meeting.status},
        ${meeting.joinCode},
        ${meeting.scheduledStartAt},
        ${meeting.startedAt},
        ${meeting.endedAt},
        ${meeting.waitingRoomEnabled},
        ${meeting.allowParticipantScreenShare},
        ${meeting.createdAt}
      )
    `;

    try {
      await this.addParticipant(host);
    } catch (error) {
      await this.sql`
        delete from workspace_meetings
        where room_name=${meeting.roomName}
      `;
      throw error;
    }
  }

  async getMeeting(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      select
        room_name,
        title,
        status,
        join_code,
        scheduled_start_at,
        started_at,
        ended_at,
        waiting_room_enabled,
        allow_participant_screen_share,
        created_at
      from workspace_meetings
      where room_name=${roomName}
      limit 1
    `;
    return rows[0] ? toMeeting(rows[0] as Record<string, unknown>) : null;
  }

  async findMeetingByJoinCode(code: string) {
    await this.ready();
    const rows = await this.sql`
      select
        room_name,
        title,
        status,
        join_code,
        scheduled_start_at,
        started_at,
        ended_at,
        waiting_room_enabled,
        allow_participant_screen_share,
        created_at
      from workspace_meetings
      where upper(join_code)=upper(${code})
      limit 1
    `;
    return rows[0] ? toMeeting(rows[0] as Record<string, unknown>) : null;
  }

  async addParticipant(participant: StoredParticipant) {
    await this.ready();
    await this.sql`
      insert into workspace_meeting_participants (
        id,
        room_name,
        display_name,
        role,
        access_key_hash,
        admission_status,
        created_at,
        last_seen_at
      ) values (
        ${participant.id},
        ${participant.roomName},
        ${participant.displayName},
        ${participant.role},
        ${participant.accessKeyHash},
        ${participant.admissionStatus},
        ${participant.createdAt},
        ${participant.lastSeenAt}
      )
    `;
  }

  async findParticipantByAccessHash(
    roomName: string,
    accessKeyHash: string
  ) {
    await this.ready();
    const rows = await this.sql`
      select
        id,
        room_name,
        display_name,
        role,
        access_key_hash,
        admission_status,
        created_at,
        last_seen_at
      from workspace_meeting_participants
      where room_name=${roomName}
        and access_key_hash=${accessKeyHash}
      limit 1
    `;
    return rows[0]
      ? toParticipant(rows[0] as Record<string, unknown>)
      : null;
  }

  async listParticipants(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      select
        id,
        room_name,
        display_name,
        role,
        access_key_hash,
        admission_status,
        created_at,
        last_seen_at
      from workspace_meeting_participants
      where room_name=${roomName}
      order by
        case when role='host' then 0 else 1 end,
        created_at asc
    `;
    return rows.map((row) =>
      toParticipant(row as Record<string, unknown>)
    );
  }

  async updateParticipantPresence(
    roomName: string,
    participantId: string,
    displayName?: string
  ) {
    await this.ready();
    if (displayName) {
      await this.sql`
        update workspace_meeting_participants
        set display_name=${displayName}, last_seen_at=now()
        where room_name=${roomName} and id=${participantId}
      `;
      return;
    }
    await this.sql`
      update workspace_meeting_participants
      set last_seen_at=now()
      where room_name=${roomName} and id=${participantId}
    `;
  }

  async updateAdmission(
    roomName: string,
    participantId: string,
    status: "admitted" | "denied"
  ) {
    await this.ready();
    const rows = await this.sql`
      update workspace_meeting_participants
      set admission_status=${status}, last_seen_at=now()
      where room_name=${roomName}
        and id=${participantId}
        and role <> 'host'
      returning
        id,
        room_name,
        display_name,
        role,
        access_key_hash,
        admission_status,
        created_at,
        last_seen_at
    `;
    return rows[0]
      ? toParticipant(rows[0] as Record<string, unknown>)
      : null;
  }

  async startMeeting(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      update workspace_meetings
      set
        status='live',
        started_at=coalesce(started_at, now()),
        ended_at=null
      where room_name=${roomName}
      returning
        room_name,
        title,
        status,
        join_code,
        scheduled_start_at,
        started_at,
        ended_at,
        waiting_room_enabled,
        allow_participant_screen_share,
        created_at
    `;
    return rows[0] ? toMeeting(rows[0] as Record<string, unknown>) : null;
  }

  async endMeeting(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      update workspace_meetings
      set status='ended', ended_at=now()
      where room_name=${roomName}
      returning
        room_name,
        title,
        status,
        join_code,
        scheduled_start_at,
        started_at,
        ended_at,
        waiting_room_enabled,
        allow_participant_screen_share,
        created_at
    `;
    return rows[0] ? toMeeting(rows[0] as Record<string, unknown>) : null;
  }
}

export function createMeetingStore(): MeetingStore {
  const databaseUrl =
    process.env.WORKSPACE_MEET_DATABASE_URL?.trim() ||
    process.env.WORKSPACE_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();

  if (databaseUrl) {
    return new PostgresMeetingStore(databaseUrl);
  }

  return new MemoryMeetingStore();
}
