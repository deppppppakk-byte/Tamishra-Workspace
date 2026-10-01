import postgres from "postgres";

export type StoredMeetingStatus =
  | "scheduled"
  | "live"
  | "ended"
  | "cancelled";

export type StoredMeetingRole = "host" | "cohost" | "participant";

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

export type StoredAttendance = {
  roomName: string;
  participantId: string;
  displayName: string;
  joinedAt: string;
  lastSeenAt: string;
  leftAt: string | null;
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
  updateParticipantRole(
    roomName: string,
    participantId: string,
    role: "cohost" | "participant"
  ): Promise<StoredParticipant | null>;
  heartbeatAttendance(
    roomName: string,
    participantId: string
  ): Promise<StoredAttendance | null>;
  leaveAttendance(
    roomName: string,
    participantId: string
  ): Promise<StoredAttendance | null>;
  listAttendance(roomName: string): Promise<StoredAttendance[]>;
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

function toAttendance(
  row: Record<string, unknown>
): StoredAttendance {
  return {
    roomName: String(row.room_name),
    participantId: String(row.participant_id),
    displayName: String(row.display_name),
    joinedAt: iso(row.joined_at) ?? new Date().toISOString(),
    lastSeenAt: iso(row.last_seen_at) ?? new Date().toISOString(),
    leftAt: iso(row.left_at)
  };
}

class MemoryMeetingStore implements MeetingStore {
  readonly kind = "ephemeral-memory" as const;
  private readonly meetings = new Map<string, StoredMeeting>();
  private readonly participants = new Map<string, StoredParticipant>();
  private readonly attendance = new Map<string, StoredAttendance>();

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
        const rank = { host: 0, cohost: 1, participant: 2 } as const;
        if (left.role !== right.role) return rank[left.role] - rank[right.role];
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

  async updateParticipantRole(
    roomName: string,
    participantId: string,
    role: "cohost" | "participant"
  ) {
    const participant = this.participants.get(participantId);
    if (
      !participant ||
      participant.roomName !== roomName ||
      participant.role === "host" ||
      participant.admissionStatus !== "admitted"
    ) {
      return null;
    }
    participant.role = role;
    participant.lastSeenAt = new Date().toISOString();
    return participant;
  }

  async heartbeatAttendance(
    roomName: string,
    participantId: string
  ) {
    const participant = this.participants.get(participantId);
    if (!participant || participant.roomName !== roomName) return null;

    const key = roomName + ":" + participantId;
    const now = new Date().toISOString();
    const existing = this.attendance.get(key);

    if (existing) {
      existing.displayName = participant.displayName;
      existing.lastSeenAt = now;
      existing.leftAt = null;
      return existing;
    }

    const attendance: StoredAttendance = {
      roomName,
      participantId,
      displayName: participant.displayName,
      joinedAt: now,
      lastSeenAt: now,
      leftAt: null
    };
    this.attendance.set(key, attendance);
    return attendance;
  }

  async leaveAttendance(
    roomName: string,
    participantId: string
  ) {
    const key = roomName + ":" + participantId;
    const existing = this.attendance.get(key);
    if (!existing) return null;
    const now = new Date().toISOString();
    existing.lastSeenAt = now;
    existing.leftAt = now;
    return existing;
  }

  async listAttendance(roomName: string) {
    return Array.from(this.attendance.values())
      .filter((entry) => entry.roomName === roomName)
      .sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));
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
  private readonly sql: ReturnType<typeof postgres>;
  private readyPromise: Promise<void> | null = null;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 5, prepare: false });
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
      create table if not exists workspace_meeting_attendance (
        room_name text not null references workspace_meetings(room_name) on delete cascade,
        participant_id text not null references workspace_meeting_participants(id) on delete cascade,
        display_name text not null,
        joined_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now(),
        left_at timestamptz,
        primary key(room_name, participant_id)
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
        case
          when role='host' then 0
          when role='cohost' then 1
          else 2
        end,
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

  async updateParticipantRole(
    roomName: string,
    participantId: string,
    role: "cohost" | "participant"
  ) {
    await this.ready();
    const rows = await this.sql`
      update workspace_meeting_participants
      set role=${role}, last_seen_at=now()
      where room_name=${roomName}
        and id=${participantId}
        and role <> 'host'
        and admission_status='admitted'
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

  async heartbeatAttendance(
    roomName: string,
    participantId: string
  ) {
    await this.ready();
    const rows = await this.sql`
      insert into workspace_meeting_attendance (
        room_name,
        participant_id,
        display_name,
        joined_at,
        last_seen_at,
        left_at
      )
      select
        p.room_name,
        p.id,
        p.display_name,
        now(),
        now(),
        null
      from workspace_meeting_participants p
      where p.room_name=${roomName} and p.id=${participantId}
      on conflict(room_name, participant_id) do update set
        display_name=excluded.display_name,
        last_seen_at=now(),
        left_at=null
      returning
        room_name,
        participant_id,
        display_name,
        joined_at,
        last_seen_at,
        left_at
    `;
    return rows[0]
      ? toAttendance(rows[0] as Record<string, unknown>)
      : null;
  }

  async leaveAttendance(
    roomName: string,
    participantId: string
  ) {
    await this.ready();
    const rows = await this.sql`
      update workspace_meeting_attendance
      set last_seen_at=now(), left_at=now()
      where room_name=${roomName} and participant_id=${participantId}
      returning
        room_name,
        participant_id,
        display_name,
        joined_at,
        last_seen_at,
        left_at
    `;
    return rows[0]
      ? toAttendance(rows[0] as Record<string, unknown>)
      : null;
  }

  async listAttendance(roomName: string) {
    await this.ready();
    const rows = await this.sql`
      select
        room_name,
        participant_id,
        display_name,
        joined_at,
        last_seen_at,
        left_at
      from workspace_meeting_attendance
      where room_name=${roomName}
      order by joined_at asc
    `;
    return rows.map((row) =>
      toAttendance(row as Record<string, unknown>)
    );
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
