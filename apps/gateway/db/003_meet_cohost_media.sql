alter table workspace_meeting_controls
  add column if not exists participant_microphone_enabled boolean not null default true;

alter table workspace_meeting_controls
  add column if not exists participant_camera_enabled boolean not null default true;

create index if not exists workspace_meeting_participants_role_idx
  on workspace_meeting_participants(room_name, role, created_at);
