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
);

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
);

create index if not exists workspace_meeting_breakout_rooms_status_idx
  on workspace_meeting_breakout_rooms(parent_room_name, status, opened_at);

create index if not exists workspace_meeting_breakout_assignments_group_idx
  on workspace_meeting_breakout_assignments(parent_room_name, group_id, returned_at);

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
);

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
);

create index if not exists workspace_meeting_transcript_room_idx
  on workspace_meeting_transcript_segments(room_name, first_received_at);

create table if not exists workspace_meeting_notes (
  room_name text primary key
    references workspace_meetings(room_name) on delete cascade,
  body text not null default '',
  updated_by_participant_id text,
  updated_by_display_name text,
  updated_at timestamptz not null default now()
);

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
);

create index if not exists workspace_meeting_summaries_room_idx
  on workspace_meeting_summaries(room_name, created_at desc);
