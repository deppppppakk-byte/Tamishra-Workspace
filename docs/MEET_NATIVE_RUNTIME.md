# Tamishra Meet native runtime

Tamishra Meet now has a Workspace-owned runtime path. The original Tamishra website remains a behavioral reference only.

## Current architecture

```text
Tamishra Workspace Web / Desktop / Mobile
                |
                v
        @tamishra/meet-core
                |
                v
        Workspace Gateway :4100
                |
        +-------+--------+
        |                |
        v                v
 Meeting lifecycle     LiveKit
 / admission / codes   token service
```

## Implemented

The native Workspace gateway currently provides:

- instant meeting creation
- scheduled meeting creation
- random private 10-character joining codes
- host capability key
- participant capability keys
- waiting-room admission
- host participant list
- admit / deny controls
- host start / end lifecycle
- meeting context polling
- LiveKit media-token issuance
- strict request body limits
- explicit web / Tauri / Capacitor CORS allow-list

The Workspace client currently provides:

- create meeting
- schedule meeting
- join by private code
- room-specific access storage
- pre-join microphone and camera check
- waiting-room status
- host start screen
- host admit / deny panel
- LiveKit video-conference room
- private-code copy
- participant roster
- end-meeting control
- responsive web / desktop / mobile layout

## Required environment

Copy the values from `.env.example` into the deployment environment.

### Web

`NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN`

Public origin of the Workspace gateway.

### Gateway

`WORKSPACE_GATEWAY_PORT`

Local listen port. Defaults to `4100`.

`WORKSPACE_ALLOWED_ORIGINS`

Comma-separated origin allow-list for Workspace clients.

`WORKSPACE_MEET_DATABASE_URL`

Workspace-owned Postgres connection string for durable meeting and membership state. If omitted, Meet uses the explicit local-development memory fallback.

### LiveKit

`LIVEKIT_URL`

Workspace-owned LiveKit websocket URL.

`LIVEKIT_API_KEY`

Server-side key. Never expose it to web, desktop or mobile clients.

`LIVEKIT_API_SECRET`

Server-side secret. Never expose it to web, desktop or mobile clients.

## Local development

Run the gateway and web app in separate terminals:

```bash
npm run dev:gateway
npm run dev:web
```

Then open Tamishra Meet from Workspace.

## Durable meeting persistence

The gateway now selects its meeting store automatically.

When `WORKSPACE_MEET_DATABASE_URL` (or `WORKSPACE_DATABASE_URL` / `DATABASE_URL`) is configured, Meet uses the Workspace Postgres adapter and persists:

- meeting records
- private joining codes
- scheduled / live / ended lifecycle state
- host and participant memberships
- waiting-room admission state
- participant display names
- last-seen timestamps
- connected attendance sessions
- attendance join / heartbeat / leave timestamps

Room capability keys are never stored raw. The gateway stores only SHA-256 hashes and returns the raw key to the creating/joining client once.

When no database URL is configured, the gateway deliberately falls back to `ephemeral-memory` for local development. The capabilities endpoint reports which store is active.

The next persistence block should extend the same database boundary for:

- persistent meeting chat
- reactions / hand raise
- recording metadata
- audit events

## Independence rule

Production Workspace Meet must not redirect to or call the original Tamishra training/services website.

LiveKit may be self-hosted or otherwise provisioned for Workspace, but its credentials and token issuance remain entirely server-side in the Workspace gateway/service boundary.


## Advanced collaboration runtime

Workspace Meet now includes a persistent collaboration and moderation layer.

### Persistent meeting chat

- messages are stored in Workspace persistence
- participants can send chat only while admitted to a live meeting
- host can enable or pause chat for the room
- the client polls the shared Workspace meeting contract, so web, desktop and mobile use the same history

### Hand raise and reactions

- hand raise persists until the participant lowers it or the host clears it
- reactions are transient and expire after eight seconds
- host can disable reactions or hand raise independently
- signals are stored separately from LiveKit media state

### Room security and moderation

- host can lock new code-based joins
- host can admit or deny waiting-room participants
- host can remove an admitted participant
- participant removal updates Workspace admission state
- participant removal closes attendance state
- LiveKit removal is issued server-side with token revocation
- ending a meeting also closes the LiveKit media room

### Audit history

Major meeting events are persisted in `workspace_meeting_audit`, including:

- meeting creation
- meeting start / end
- join requests
- participant admission / denial
- participant removal
- room policy changes
- host-cleared hand raises

### Database migrations

- `apps/gateway/db/001_workspace_meet.sql` — base meetings, membership and attendance
- `apps/gateway/db/002_meet_collaboration.sql` — controls, chat, signals and audit

The runtime still uses the same `@tamishra/meet-core` client contract across browser, Tauri desktop and Capacitor mobile clients.


## Co-host and media moderation

Workspace Meet now supports a distinct moderator layer without giving every moderator owner authority.

### Roles

- **Host** — meeting owner; can end the meeting, change room policy, promote/demote co-hosts, and use all moderation controls.
- **Co-host** — can manage the waiting room, view attendance/activity, clear raised hands, mute participant microphones, stop participant cameras, and remove ordinary participants.
- **Participant** — standard admitted attendee.

Only admitted participants can be promoted to co-host.

### Server-enforced media controls

LiveKit moderation is performed by the Workspace gateway, not by trusting client UI state.

- mute an individual participant microphone
- stop an individual participant camera
- mute all ordinary participant microphones
- stop all ordinary participant cameras
- owner policy can disable participant microphone publishing
- owner policy can disable participant camera publishing

When a publish policy changes, connected ordinary participants receive updated LiveKit permissions. Existing microphone/camera tracks are muted or stopped when the policy is disabled. Offline participants receive the policy on their next token issue.

The gateway does not remotely unmute a participant when a policy is re-enabled; it restores permission and the participant chooses whether to publish again.

### Live media state

The People panel reports current server-observed microphone, camera, and screen-share state from LiveKit participant tracks.

### Database migration

- `apps/gateway/db/003_meet_cohost_media.sql` — participant media policy columns and role lookup index

The runtime also auto-upgrades existing `workspace_meeting_controls` tables with the new policy columns using `ADD COLUMN IF NOT EXISTS`.


## Recording, history and attendance reports

Workspace Meet now includes a durable recording and post-meeting operations layer.

### Consent-aware recording

- only the meeting host can start or stop a recording
- recording uses server-side LiveKit Egress
- output is written to Workspace-configured S3-compatible object storage
- object-storage credentials remain server-side
- all currently admitted non-host participants must explicitly accept recording before the host can start
- participants can pre-consent before joining media
- participants joining while recording is active must accept consent before a media token is issued
- withdrawing consent while recording is active stops the recording
- recording start / stop / consent events are written to the meeting audit log

### Recording persistence

`workspace_meeting_recordings` stores:

- Egress identifier
- lifecycle state
- output filepath and location
- start / end timestamps
- file duration
- file size
- errors

`workspace_meeting_recording_consents` stores the current meeting recording-consent cycle. Consent records are reset after a recording stops so a later recording requires fresh consent.

Migration:

- `apps/gateway/db/004_meet_recordings.sql`

### Recording environment

The gateway supports any S3-compatible object store through:

- `WORKSPACE_MEET_RECORDING_BUCKET`
- `WORKSPACE_MEET_RECORDING_REGION`
- `WORKSPACE_MEET_RECORDING_ENDPOINT`
- `WORKSPACE_MEET_RECORDING_ACCESS_KEY`
- `WORKSPACE_MEET_RECORDING_SECRET`
- `WORKSPACE_MEET_RECORDING_FORCE_PATH_STYLE`
- `WORKSPACE_MEET_RECORDING_PREFIX`

Recording remains unavailable until LiveKit and recording storage are both configured.

### Recent meeting history

The Meet home screen reads capability keys already stored on the current Workspace client and asks the gateway to validate them. The gateway returns only meetings for which the supplied capability is still valid.

History includes:

- meeting title and lifecycle status
- current role
- scheduled / started / ended timestamps
- host join code
- admitted participant count
- attendance count
- recording count

This preserves the current capability-based security model without inventing a separate identity system.

### Attendance reports

Hosts and co-hosts can request an attendance report for a meeting. The report includes:

- join time
- last seen time
- leave time
- per-participant duration
- total meeting duration
- total attendance time

The Meet home client can export this report as CSV.
