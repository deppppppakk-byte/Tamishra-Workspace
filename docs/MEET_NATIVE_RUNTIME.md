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

Room capability keys are never stored raw. The gateway stores only SHA-256 hashes and returns the raw key to the creating/joining client once.

When no database URL is configured, the gateway deliberately falls back to `ephemeral-memory` for local development. The capabilities endpoint reports which store is active.

The next persistence block should extend the same database boundary for:

- detailed attendance sessions
- persistent meeting chat
- reactions / hand raise
- recording metadata
- audit events

## Independence rule

Production Workspace Meet must not redirect to or call the original Tamishra training/services website.

LiveKit may be self-hosted or otherwise provisioned for Workspace, but its credentials and token issuance remain entirely server-side in the Workspace gateway/service boundary.
