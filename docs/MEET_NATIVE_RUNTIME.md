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

## Current hardening boundary

Meeting state currently uses an in-memory gateway store.

That is intentionally marked as `ephemeral-memory` by the capabilities endpoint and is **not production persistence**. A gateway restart removes rooms and access keys.

The next production-hardening block should replace the in-memory maps with a Workspace-owned durable store while preserving the existing `@tamishra/meet-core` API.

The durable model should persist at minimum:

- meetings
- private joining codes
- memberships
- admission state
- lifecycle state
- attendance
- chat
- reactions / hand raise
- recording metadata
- audit events

## Independence rule

Production Workspace Meet must not redirect to or call the original Tamishra training/services website.

LiveKit may be self-hosted or otherwise provisioned for Workspace, but its credentials and token issuance remain entirely server-side in the Workspace gateway/service boundary.
