-- Tamishra Workspace / Patra PostgreSQL bootstrap for Supabase.
-- Application traffic uses WORKSPACE_DATABASE_URL directly through the gateway.
-- No Patra/Workspace table is intended to be exposed to browser Data API roles.

begin;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists public.workspace_users (
  id text primary key,
  email text not null unique,
  display_name text not null,
  email_verified boolean not null default false,
  disabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_password_credentials (
  user_id text primary key references public.workspace_users(id) on delete cascade,
  password_hash text not null,
  password_salt text not null,
  scrypt_n integer not null,
  scrypt_r integer not null,
  scrypt_p integer not null,
  key_length integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_sessions (
  id text primary key,
  user_id text not null references public.workspace_users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  user_agent text,
  ip_hash text,
  revoked_at timestamptz
);

create table if not exists public.workspace_organizations (
  id text primary key,
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_memberships (
  id text primary key,
  user_id text not null references public.workspace_users(id) on delete cascade,
  organization_id text not null references public.workspace_organizations(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'guest')),
  joined_at timestamptz not null default now(),
  disabled boolean not null default false,
  unique(user_id, organization_id)
);

create table if not exists public.workspace_identity_tokens (
  id text primary key,
  user_id text not null references public.workspace_users(id) on delete cascade,
  purpose text not null check (purpose in ('verify-email', 'reset-password')),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table if not exists public.workspace_recovery_codes (
  id text primary key,
  user_id text not null references public.workspace_users(id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  unique(user_id, code_hash)
);

create table if not exists public.patra_mailboxes (
  id text primary key,
  user_id text not null references public.workspace_users(id) on delete cascade,
  local_part text not null,
  domain text not null,
  address text not null unique,
  mailbox_class text not null check (mailbox_class in ('public', 'tamishra-company')),
  display_name text not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  quota_bytes bigint not null default 5368709120 check (quota_bytes >= 0),
  used_bytes bigint not null default 0 check (used_bytes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, domain)
);

create table if not exists public.patra_folders (
  id text primary key,
  mailbox_id text not null references public.patra_mailboxes(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('inbox', 'sent', 'drafts', 'archive', 'spam', 'trash')),
  created_at timestamptz not null default now(),
  unique(mailbox_id, kind)
);

create table if not exists public.patra_messages (
  id text primary key,
  mailbox_id text not null references public.patra_mailboxes(id) on delete cascade,
  folder_id text not null references public.patra_folders(id) on delete cascade,
  thread_id text not null,
  from_name text,
  from_address text not null,
  to_json jsonb not null default '[]'::jsonb,
  cc_json jsonb not null default '[]'::jsonb,
  bcc_json jsonb not null default '[]'::jsonb,
  subject text not null default '',
  text_body text not null default '',
  html_body text,
  preview text not null default '',
  received_at timestamptz,
  sent_at timestamptz,
  is_read boolean not null default false,
  starred boolean not null default false,
  labels_json jsonb not null default '[]'::jsonb,
  delivery_status text not null check (
    delivery_status in ('draft', 'queued', 'delivered-local', 'sent-external', 'failed')
  ),
  internet_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.patra_delivery_queue (
  id text primary key,
  message_id text not null references public.patra_messages(id) on delete cascade,
  mailbox_id text not null references public.patra_mailboxes(id) on delete cascade,
  status text not null default 'queued' check (
    status in ('queued', 'processing', 'delivered', 'failed')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error text,
  recipients_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workspace_sessions_user_idx
  on public.workspace_sessions(user_id, last_seen_at desc);
create index if not exists workspace_sessions_token_idx
  on public.workspace_sessions(token_hash);
create index if not exists workspace_memberships_user_idx
  on public.workspace_memberships(user_id, joined_at);
create index if not exists workspace_identity_tokens_lookup_idx
  on public.workspace_identity_tokens(token_hash, purpose, expires_at);
create index if not exists workspace_recovery_codes_user_idx
  on public.workspace_recovery_codes(user_id, used_at);
create index if not exists patra_mailboxes_user_idx
  on public.patra_mailboxes(user_id, created_at);
create index if not exists patra_messages_mailbox_folder_idx
  on public.patra_messages(mailbox_id, folder_id, created_at desc);
create index if not exists patra_messages_thread_idx
  on public.patra_messages(mailbox_id, thread_id, created_at);
create index if not exists patra_delivery_queue_ready_idx
  on public.patra_delivery_queue(status, next_attempt_at, created_at);

-- The Tamishra gateway is the only application data plane.
-- Supabase browser roles must not directly access these tables.
revoke all on table
  public.workspace_users,
  public.workspace_password_credentials,
  public.workspace_sessions,
  public.workspace_organizations,
  public.workspace_memberships,
  public.workspace_identity_tokens,
  public.workspace_recovery_codes,
  public.patra_mailboxes,
  public.patra_folders,
  public.patra_messages,
  public.patra_delivery_queue
from anon, authenticated;

alter table public.workspace_users enable row level security;
alter table public.workspace_password_credentials enable row level security;
alter table public.workspace_sessions enable row level security;
alter table public.workspace_organizations enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.workspace_identity_tokens enable row level security;
alter table public.workspace_recovery_codes enable row level security;
alter table public.patra_mailboxes enable row level security;
alter table public.patra_folders enable row level security;
alter table public.patra_messages enable row level security;
alter table public.patra_delivery_queue enable row level security;

-- Protect future gateway-created public tables as defense in depth.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;

create or replace function private.tamishra_enable_rls()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table', 'partitioned table')
  loop
    if cmd.schema_name = 'public' then
      execute format('alter table if exists %s enable row level security', cmd.object_identity);
    end if;
  end loop;
end;
$$;

revoke execute on function private.tamishra_enable_rls() from public, anon, authenticated;

drop event trigger if exists tamishra_ensure_public_rls;
create event trigger tamishra_ensure_public_rls
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function private.tamishra_enable_rls();

commit;
