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
);

create index if not exists workspace_meeting_recordings_room_idx
  on workspace_meeting_recordings(room_name, created_at desc);

create table if not exists workspace_meeting_recording_consents (
  room_name text not null
    references workspace_meetings(room_name) on delete cascade,
  participant_id text not null
    references workspace_meeting_participants(id) on delete cascade,
  display_name text not null,
  consent text not null,
  updated_at timestamptz not null default now(),
  primary key(room_name, participant_id)
);

create index if not exists workspace_meeting_recording_consents_room_idx
  on workspace_meeting_recording_consents(room_name, updated_at desc);
