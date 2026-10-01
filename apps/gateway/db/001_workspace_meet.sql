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
);

create table if not exists workspace_meeting_participants (
  id text primary key,
  room_name text not null references workspace_meetings(room_name) on delete cascade,
  display_name text not null,
  role text not null,
  access_key_hash text not null unique,
  admission_status text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists workspace_meeting_participants_room_idx
  on workspace_meeting_participants(room_name, created_at);

create index if not exists workspace_meetings_status_idx
  on workspace_meetings(status, created_at desc);
