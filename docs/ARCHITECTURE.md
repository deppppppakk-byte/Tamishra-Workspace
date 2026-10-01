# Tamishra Workspace Architecture

## Target structure

apps/
- web
- desktop
- mobile

packages/
- design-system
- workspace-shell
- identity
- permissions
- search
- notifications
- file-core
- storage
- sync
- collaboration
- command-core
- history
- docs-engine
- sheets-engine
- slides-engine
- pdf-engine
- chat-core
- mail-core
- meet-core
- notes-core
- forms-core
- import-export
- telemetry

## Shared platform services

Every module should share:

- authentication
- user profile
- organization/workspace membership
- permissions
- notifications
- presence
- search
- file storage
- activity history
- autosave
- versioning
- command palette
- keyboard shortcuts
- theme system
- settings
- audit events

## Communication model

### Chat
Persistent message store with threads, reactions, attachments and presence.

### Mail
Provider-agnostic mail abstraction. External accounts should connect through adapters rather than becoming part of the internal data model.

### Meet
`@tamishra/meet-core` is the provider-neutral meeting boundary.

The behavioral source of truth is the existing Tamishra Meet product in the original Tamishra repository. Workspace must reuse or migrate that implementation rather than create a competing meeting engine.

The first Workspace integration bridges to the existing Tamishra Meet runtime because `apps/web` is currently a static export. The existing runtime already provides LiveKit media, private joining codes, waiting-room admission, screen sharing, chat/reactions, participant controls, attendance and recording infrastructure.

The long-term Workspace target is a dedicated meeting service behind the same `meet-core` contract so web, desktop and mobile can share one room lifecycle and one backend.

See `docs/MEET_MIGRATION.md`.

### Notes
Block-based document model optimized for fast capture and cross-linking.

### Forms
Schema-driven form definitions with versioned response storage and export APIs.

## Unified object model

All user-created items should expose common metadata:

- id
- workspaceId
- ownerId
- type
- title
- createdAt
- updatedAt
- createdBy
- permissions
- tags
- starred
- archived
- version
- activity

This lets search, sharing, recent items and notifications work across the entire suite.

## Security baseline

- server-side authorization
- role-based permissions
- encryption in transit
- secure token storage
- signed asset URLs
- sandboxed document parsing
- audit logging
- rate limiting
- safe attachment handling
- meeting access controls
- anti-spam hooks for mail/forms/chat
