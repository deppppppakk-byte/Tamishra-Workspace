create table if not exists workspace_meeting_controls (
  room_name text primary key
    references workspace_meetings(room_name) on delete cascade,
  locked boolean not null default false,
  chat_enabled boolean not null default true,
  reactions_enabled boolean not null default true,
  hand_raise_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists workspace_meeting_messages (
  id text primary key,
  room_name text not null
    references workspace_meetings(room_name) on delete cascade,
  participant_id text not null
    references workspace_meeting_participants(id) on delete cascade,
  display_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists workspace_meeting_messages_room_idx
  on workspace_meeting_messages(room_name, created_at desc);

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
);

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
);

create index if not exists workspace_meeting_audit_room_idx
  on workspace_meeting_audit(room_name, created_at desc);
