import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

export type BreakoutRoomStatus = "open" | "closed";

export type StoredBreakoutRoom = {
  parentRoomName: string;
  groupId: string;
  groupLabel: string;
  livekitRoomName: string;
  status: BreakoutRoomStatus;
  durationMinutes: number | null;
  openedAt: string;
  closedAt: string | null;
};

export type StoredBreakoutAssignment = {
  parentRoomName: string;
  participantId: string;
  displayName: string;
  groupId: string;
  livekitRoomName: string;
  assignedAt: string;
  returnedAt: string | null;
};

export type BreakoutPublishInput = {
  rooms: StoredBreakoutRoom[];
  assignments: StoredBreakoutAssignment[];
};

export interface MeetingBreakoutStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  publish(input: BreakoutPublishInput): Promise<void>;
  listRooms(parentRoomName: string): Promise<StoredBreakoutRoom[]>;
  listAssignments(parentRoomName: string): Promise<StoredBreakoutAssignment[]>;
  getAssignment(
    parentRoomName: string,
    participantId: string
  ): Promise<StoredBreakoutAssignment | null>;
  returnAll(parentRoomName: string): Promise<number>;
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toRoom(row: Record<string, unknown>): StoredBreakoutRoom {
  return {
    parentRoomName: String(row.parent_room_name),
    groupId: String(row.group_id),
    groupLabel: String(row.group_label),
    livekitRoomName: String(row.livekit_room_name),
    status: String(row.status) as BreakoutRoomStatus,
    durationMinutes:
      row.duration_minutes === null || row.duration_minutes === undefined
        ? null
        : Number(row.duration_minutes),
    openedAt: iso(row.opened_at) ?? new Date().toISOString(),
    closedAt: iso(row.closed_at)
  };
}

function toAssignment(
  row: Record<string, unknown>
): StoredBreakoutAssignment {
  return {
    parentRoomName: String(row.parent_room_name),
    participantId: String(row.participant_id),
    displayName: String(row.display_name),
    groupId: String(row.group_id),
    livekitRoomName: String(row.livekit_room_name),
    assignedAt: iso(row.assigned_at) ?? new Date().toISOString(),
    returnedAt: iso(row.returned_at)
  };
}

class MemoryMeetingBreakoutStore implements MeetingBreakoutStore {
  readonly kind = "ephemeral-memory" as const;
  private readonly rooms = new Map<string, StoredBreakoutRoom>();
  private readonly assignments = new Map<string, StoredBreakoutAssignment>();

  async ready() {}

  async publish(input: BreakoutPublishInput) {
    if (input.rooms.length === 0) return;
    const parent = input.rooms[0].parentRoomName;
    await this.returnAll(parent);

    for (const room of input.rooms) {
      this.rooms.set(room.parentRoomName + ":" + room.groupId, room);
    }

    for (const assignment of input.assignments) {
      this.assignments.set(
        assignment.parentRoomName + ":" + assignment.participantId,
        assignment
      );
    }
  }

  async listRooms(parentRoomName: string) {
    return Array.from(this.rooms.values())
      .filter(
        (room) =>
          room.parentRoomName === parentRoomName && room.status === "open"
      )
      .sort((a, b) => a.groupLabel.localeCompare(b.groupLabel));
  }

  async listAssignments(parentRoomName: string) {
    return Array.from(this.assignments.values())
      .filter(
        (assignment) =>
          assignment.parentRoomName === parentRoomName &&
          assignment.returnedAt === null
      )
      .sort((a, b) => {
        const group = a.groupId.localeCompare(b.groupId);
        return group || a.displayName.localeCompare(b.displayName);
      });
  }

  async getAssignment(parentRoomName: string, participantId: string) {
    const value = this.assignments.get(
      parentRoomName + ":" + participantId
    );
    return value?.returnedAt === null ? value : null;
  }

  async returnAll(parentRoomName: string) {
    const now = new Date().toISOString();
    let returned = 0;

    for (const assignment of this.assignments.values()) {
      if (
        assignment.parentRoomName === parentRoomName &&
        assignment.returnedAt === null
      ) {
        assignment.returnedAt = now;
        returned += 1;
      }
    }

    for (const room of this.rooms.values()) {
      if (
        room.parentRoomName === parentRoomName &&
        room.status === "open"
      ) {
        room.status = "closed";
        room.closedAt = now;
      }
    }

    return returned;
  }
}

class PostgresMeetingBreakoutStore implements MeetingBreakoutStore {
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
      create table if not exists workspace_meeting_breakout_rooms (
        parent_room_name text not null
          references workspace_meetings(room_name) on delete cascade,
        group_id text not null,
        group_label text not null,
        livekit_room_name text not null,
        status text not null default 'open',
        duration_minutes integer,
        opened_at timestamptz not null default now(),
        closed_at timestamptz,
        primary key(parent_room_name, group_id)
      )
    `;

    await this.sql`
      create table if not exists workspace_meeting_breakout_assignments (
        parent_room_name text not null
          references workspace_meetings(room_name) on delete cascade,
        participant_id text not null
          references workspace_meeting_participants(id) on delete cascade,
        display_name text not null,
        group_id text not null,
        livekit_room_name text not null,
        assigned_at timestamptz not null default now(),
        returned_at timestamptz,
        primary key(parent_room_name, participant_id)
      )
    `;

    await this.sql`
      create index if not exists workspace_meeting_breakout_rooms_status_idx
      on workspace_meeting_breakout_rooms(parent_room_name, status, opened_at)
    `;

    await this.sql`
      create index if not exists workspace_meeting_breakout_assignments_group_idx
      on workspace_meeting_breakout_assignments(parent_room_name, group_id, returned_at)
    `;
  }

  async publish(input: BreakoutPublishInput) {
    await this.ready();
    if (input.rooms.length === 0) return;
    const parent = input.rooms[0].parentRoomName;
    await this.returnAll(parent);

    for (const room of input.rooms) {
      await this.sql`
        insert into workspace_meeting_breakout_rooms(
          parent_room_name,
          group_id,
          group_label,
          livekit_room_name,
          status,
          duration_minutes,
          opened_at,
          closed_at
        ) values (
          ${room.parentRoomName},
          ${room.groupId},
          ${room.groupLabel},
          ${room.livekitRoomName},
          ${room.status},
          ${room.durationMinutes},
          ${room.openedAt},
          ${room.closedAt}
        )
        on conflict(parent_room_name, group_id) do update set
          group_label=excluded.group_label,
          livekit_room_name=excluded.livekit_room_name,
          status='open',
          duration_minutes=excluded.duration_minutes,
          opened_at=excluded.opened_at,
          closed_at=null
      `;
    }

    for (const assignment of input.assignments) {
      await this.sql`
        insert into workspace_meeting_breakout_assignments(
          parent_room_name,
          participant_id,
          display_name,
          group_id,
          livekit_room_name,
          assigned_at,
          returned_at
        ) values (
          ${assignment.parentRoomName},
          ${assignment.participantId},
          ${assignment.displayName},
          ${assignment.groupId},
          ${assignment.livekitRoomName},
          ${assignment.assignedAt},
          null
        )
        on conflict(parent_room_name, participant_id) do update set
          display_name=excluded.display_name,
          group_id=excluded.group_id,
          livekit_room_name=excluded.livekit_room_name,
          assigned_at=excluded.assigned_at,
          returned_at=null
      `;
    }
  }

  async listRooms(parentRoomName: string) {
    await this.ready();
    const rows = await this.sql`
      select *
      from workspace_meeting_breakout_rooms
      where parent_room_name=${parentRoomName}
        and status='open'
      order by group_label asc
    `;
    return rows.map((row) => toRoom(row as Record<string, unknown>));
  }

  async listAssignments(parentRoomName: string) {
    await this.ready();
    const rows = await this.sql`
      select *
      from workspace_meeting_breakout_assignments
      where parent_room_name=${parentRoomName}
        and returned_at is null
      order by group_id asc, display_name asc
    `;
    return rows.map((row) =>
      toAssignment(row as Record<string, unknown>)
    );
  }

  async getAssignment(parentRoomName: string, participantId: string) {
    await this.ready();
    const rows = await this.sql`
      select *
      from workspace_meeting_breakout_assignments
      where parent_room_name=${parentRoomName}
        and participant_id=${participantId}
        and returned_at is null
      limit 1
    `;
    return rows[0]
      ? toAssignment(rows[0] as Record<string, unknown>)
      : null;
  }

  async returnAll(parentRoomName: string) {
    await this.ready();
    const rows = await this.sql`
      update workspace_meeting_breakout_assignments
      set returned_at=now()
      where parent_room_name=${parentRoomName}
        and returned_at is null
      returning participant_id
    `;

    await this.sql`
      update workspace_meeting_breakout_rooms
      set status='closed', closed_at=now()
      where parent_room_name=${parentRoomName}
        and status='open'
    `;

    return rows.length;
  }
}

export function createMeetingBreakoutStore(): MeetingBreakoutStore {
  const databaseUrl =
    process.env.WORKSPACE_MEET_DATABASE_URL?.trim() ||
    process.env.WORKSPACE_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();

  return databaseUrl
    ? new PostgresMeetingBreakoutStore(databaseUrl)
    : new MemoryMeetingBreakoutStore();
}
