import { randomUUID } from "node:crypto";
import postgres from "postgres";

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

export interface MeetingCollaborationStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;
  ensureRoom(roomName: string): Promise<void>;
  getControls(roomName: string): Promise<MeetingControls>;
  updateControls(
    roomName: string,
    patch: Partial<Pick<
      MeetingControls,
      | "locked"
      | "chatEnabled"
      | "reactionsEnabled"
      | "handRaiseEnabled"
      | "participantMicrophoneEnabled"
      | "participantCameraEnabled"
    >>
  ): Promise<MeetingControls>;
  addMessage(
    roomName: string,
    participantId: string,
    displayName: string,
    body: string
  ): Promise<MeetingMessage>;
  listMessages(roomName: string, limit?: number): Promise<MeetingMessage[]>;
  setSignal(
    roomName: string,
    participantId: string,
    displayName: string,
    handRaised: boolean,
    reaction: string | null
  ): Promise<MeetingSignal>;
  listSignals(roomName: string): Promise<MeetingSignal[]>;
  appendAudit(input: Omit<MeetingAuditEvent, "id" | "createdAt">): Promise<void>;
  listAudit(roomName: string, limit?: number): Promise<MeetingAuditEvent[]>;
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toControls(row: Record<string, unknown>): MeetingControls {
  return {
    locked: Boolean(row.locked),
    chatEnabled: row.chat_enabled !== false,
    reactionsEnabled: row.reactions_enabled !== false,
    handRaiseEnabled: row.hand_raise_enabled !== false,
    participantMicrophoneEnabled:
      row.participant_microphone_enabled !== false,
    participantCameraEnabled:
      row.participant_camera_enabled !== false,
    updatedAt: row.updated_at
      ? new Date(String(row.updated_at)).toISOString()
      : nowIso()
  };
}

function toMessage(row: Record<string, unknown>): MeetingMessage {
  return {
    id: String(row.id),
    roomName: String(row.room_name),
    participantId: String(row.participant_id),
    displayName: String(row.display_name),
    body: String(row.body),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

function toSignal(row: Record<string, unknown>): MeetingSignal {
  return {
    participantId: String(row.participant_id),
    displayName: String(row.display_name),
    handRaised: Boolean(row.hand_raised),
    reaction: row.reaction ? String(row.reaction) : null,
    updatedAt: new Date(String(row.updated_at)).toISOString()
  };
}

function toAudit(row: Record<string, unknown>): MeetingAuditEvent {
  return {
    id: String(row.id),
    roomName: String(row.room_name),
    actorParticipantId: row.actor_participant_id
      ? String(row.actor_participant_id)
      : null,
    actorDisplayName: String(row.actor_display_name ?? "System"),
    eventType: String(row.event_type),
    targetParticipantId: row.target_participant_id
      ? String(row.target_participant_id)
      : null,
    metadata: parseJsonObject(row.metadata),
    createdAt: new Date(String(row.created_at)).toISOString()
  };
}

class MemoryMeetingCollaborationStore
  implements MeetingCollaborationStore {
  readonly kind = "ephemeral-memory" as const;
  private readonly controls = new Map<string, MeetingControls>();
  private readonly messages = new Map<string, MeetingMessage[]>();
  private readonly signals = new Map<string, MeetingSignal>();
  private readonly audit = new Map<string, MeetingAuditEvent[]>();

  async ready() {}

  async ensureRoom(roomName: string) {
    if (!this.controls.has(roomName)) {
      this.controls.set(roomName, {
        locked: false,
        chatEnabled: true,
        reactionsEnabled: true,
        handRaiseEnabled: true,
        participantMicrophoneEnabled: true,
        participantCameraEnabled: true,
        updatedAt: nowIso()
      });
    }
  }

  async getControls(roomName: string) {
    await this.ensureRoom(roomName);
    return this.controls.get(roomName)!;
  }

  async updateControls(
    roomName: string,
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
    const current = await this.getControls(roomName);
    const next = {
      ...current,
      ...patch,
      updatedAt: nowIso()
    };
    this.controls.set(roomName, next);
    return next;
  }

  async addMessage(
    roomName: string,
    participantId: string,
    displayName: string,
    body: string
  ) {
    const message: MeetingMessage = {
      id: randomUUID(),
      roomName,
      participantId,
      displayName,
      body,
      createdAt: nowIso()
    };
    const list = this.messages.get(roomName) ?? [];
    list.push(message);
    if (list.length > 500) list.splice(0, list.length - 500);
    this.messages.set(roomName, list);
    return message;
  }

  async listMessages(roomName: string, limit = 100) {
    const list = this.messages.get(roomName) ?? [];
    return list.slice(Math.max(0, list.length - Math.max(1, limit)));
  }

  async setSignal(
    roomName: string,
    participantId: string,
    displayName: string,
    handRaised: boolean,
    reaction: string | null
  ) {
    const signal: MeetingSignal = {
      participantId,
      displayName,
      handRaised,
      reaction,
      updatedAt: nowIso()
    };
    this.signals.set(roomName + ":" + participantId, signal);
    return signal;
  }

  async listSignals(roomName: string) {
    const prefix = roomName + ":";
    const reactionCutoff = Date.now() - 8_000;
    return Array.from(this.signals.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, signal]) => ({
        ...signal,
        reaction:
          signal.reaction &&
          new Date(signal.updatedAt).getTime() >= reactionCutoff
            ? signal.reaction
            : null
      }))
      .filter((signal) => signal.handRaised || signal.reaction)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async appendAudit(input: Omit<MeetingAuditEvent, "id" | "createdAt">) {
    const list = this.audit.get(input.roomName) ?? [];
    list.push({
      ...input,
      id: randomUUID(),
      createdAt: nowIso()
    });
    if (list.length > 1000) list.splice(0, list.length - 1000);
    this.audit.set(input.roomName, list);
  }

  async listAudit(roomName: string, limit = 100) {
    const list = this.audit.get(roomName) ?? [];
    return list
      .slice(Math.max(0, list.length - Math.max(1, limit)))
      .reverse();
  }
}

class PostgresMeetingCollaborationStore
  implements MeetingCollaborationStore {
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
      create table if not exists workspace_meeting_controls (
        room_name text primary key
          references workspace_meetings(room_name) on delete cascade,
        locked boolean not null default false,
        chat_enabled boolean not null default true,
        reactions_enabled boolean not null default true,
        hand_raise_enabled boolean not null default true,
        participant_microphone_enabled boolean not null default true,
        participant_camera_enabled boolean not null default true,
        updated_at timestamptz not null default now()
      )
    `;

    await this.sql`
      alter table workspace_meeting_controls
      add column if not exists participant_microphone_enabled
        boolean not null default true
    `;

    await this.sql`
      alter table workspace_meeting_controls
      add column if not exists participant_camera_enabled
        boolean not null default true
    `;

    await this.sql`
      create table if not exists workspace_meeting_messages (
        id text primary key,
        room_name text not null
          references workspace_meetings(room_name) on delete cascade,
        participant_id text not null
          references workspace_meeting_participants(id) on delete cascade,
        display_name text not null,
        body text not null,
        created_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create index if not exists workspace_meeting_messages_room_idx
      on workspace_meeting_messages(room_name, created_at desc)
    `;

    await this.sql`
      create table if not exists workspace_meeting_signals (
        room_name text not null
          references workspace_meetings(room_name) on delete cascade,
        participant_id text not null
          references workspace_meeting_participants(id) on delete cascade,
        display_name text not null,
        hand_raised boolean not null default false,
        reaction text,
        updated_at timestamptz not null default now(),
        primary key(room_name, participant_id)
      )
    `;

    await this.sql`
      create table if not exists workspace_meeting_audit (
        id text primary key,
        room_name text not null
          references workspace_meetings(room_name) on delete cascade,
        actor_participant_id text,
        actor_display_name text not null,
        event_type text not null,
        target_participant_id text,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `;

    await this.sql`
      create index if not exists workspace_meeting_audit_room_idx
      on workspace_meeting_audit(room_name, created_at desc)
    `;
  }

  async ensureRoom(roomName: string) {
    await this.ready();
    await this.sql`
      insert into workspace_meeting_controls(room_name)
      values (${roomName})
      on conflict(room_name) do nothing
    `;
  }

  async getControls(roomName: string) {
    await this.ensureRoom(roomName);
    const rows = await this.sql`
      select locked, chat_enabled, reactions_enabled,
        hand_raise_enabled, participant_microphone_enabled,
        participant_camera_enabled, updated_at
      from workspace_meeting_controls
      where room_name=${roomName}
      limit 1
    `;
    return toControls(rows[0] as Record<string, unknown>);
  }

  async updateControls(
    roomName: string,
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
    const current = await this.getControls(roomName);
    const locked = patch.locked ?? current.locked;
    const chatEnabled = patch.chatEnabled ?? current.chatEnabled;
    const reactionsEnabled =
      patch.reactionsEnabled ?? current.reactionsEnabled;
    const handRaiseEnabled =
      patch.handRaiseEnabled ?? current.handRaiseEnabled;
    const participantMicrophoneEnabled =
      patch.participantMicrophoneEnabled ??
      current.participantMicrophoneEnabled;
    const participantCameraEnabled =
      patch.participantCameraEnabled ??
      current.participantCameraEnabled;

    const rows = await this.sql`
      update workspace_meeting_controls
      set
        locked=${locked},
        chat_enabled=${chatEnabled},
        reactions_enabled=${reactionsEnabled},
        hand_raise_enabled=${handRaiseEnabled},
        participant_microphone_enabled=${participantMicrophoneEnabled},
        participant_camera_enabled=${participantCameraEnabled},
        updated_at=now()
      where room_name=${roomName}
      returning locked, chat_enabled, reactions_enabled,
        hand_raise_enabled, participant_microphone_enabled,
        participant_camera_enabled, updated_at
    `;
    return toControls(rows[0] as Record<string, unknown>);
  }

  async addMessage(
    roomName: string,
    participantId: string,
    displayName: string,
    body: string
  ) {
    const id = randomUUID();
    const rows = await this.sql`
      insert into workspace_meeting_messages(
        id, room_name, participant_id, display_name, body
      ) values (
        ${id}, ${roomName}, ${participantId}, ${displayName}, ${body}
      )
      returning id, room_name, participant_id, display_name, body, created_at
    `;
    return toMessage(rows[0] as Record<string, unknown>);
  }

  async listMessages(roomName: string, limit = 100) {
    const safeLimit = Math.min(200, Math.max(1, limit));
    const rows = await this.sql`
      select id, room_name, participant_id, display_name, body, created_at
      from workspace_meeting_messages
      where room_name=${roomName}
      order by created_at desc
      limit ${safeLimit}
    `;
    return rows
      .map((row) => toMessage(row as Record<string, unknown>))
      .reverse();
  }

  async setSignal(
    roomName: string,
    participantId: string,
    displayName: string,
    handRaised: boolean,
    reaction: string | null
  ) {
    const rows = await this.sql`
      insert into workspace_meeting_signals(
        room_name,
        participant_id,
        display_name,
        hand_raised,
        reaction,
        updated_at
      ) values (
        ${roomName},
        ${participantId},
        ${displayName},
        ${handRaised},
        ${reaction},
        now()
      )
      on conflict(room_name, participant_id) do update set
        display_name=excluded.display_name,
        hand_raised=excluded.hand_raised,
        reaction=excluded.reaction,
        updated_at=now()
      returning participant_id, display_name, hand_raised, reaction, updated_at
    `;
    return toSignal(rows[0] as Record<string, unknown>);
  }

  async listSignals(roomName: string) {
    const rows = await this.sql`
      select participant_id, display_name, hand_raised, reaction, updated_at
      from workspace_meeting_signals
      where room_name=${roomName}
        and (
          hand_raised=true
          or (
            reaction is not null
            and updated_at >= now() - interval '8 seconds'
          )
        )
      order by updated_at desc
    `;
    return rows.map((row) => toSignal(row as Record<string, unknown>));
  }

  async appendAudit(input: Omit<MeetingAuditEvent, "id" | "createdAt">) {
    const id = randomUUID();
    const metadataJson = JSON.stringify(input.metadata ?? {});
    await this.sql`
      insert into workspace_meeting_audit(
        id,
        room_name,
        actor_participant_id,
        actor_display_name,
        event_type,
        target_participant_id,
        metadata
      ) values (
        ${id},
        ${input.roomName},
        ${input.actorParticipantId},
        ${input.actorDisplayName},
        ${input.eventType},
        ${input.targetParticipantId},
        ${metadataJson}::jsonb
      )
    `;
  }

  async listAudit(roomName: string, limit = 100) {
    const safeLimit = Math.min(250, Math.max(1, limit));
    const rows = await this.sql`
      select
        id,
        room_name,
        actor_participant_id,
        actor_display_name,
        event_type,
        target_participant_id,
        metadata,
        created_at
      from workspace_meeting_audit
      where room_name=${roomName}
      order by created_at desc
      limit ${safeLimit}
    `;
    return rows.map((row) => toAudit(row as Record<string, unknown>));
  }
}

export function createMeetingCollaborationStore(): MeetingCollaborationStore {
  const databaseUrl =
    process.env.WORKSPACE_MEET_DATABASE_URL?.trim() ||
    process.env.WORKSPACE_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim();

  return databaseUrl
    ? new PostgresMeetingCollaborationStore(databaseUrl)
    : new MemoryMeetingCollaborationStore();
}
