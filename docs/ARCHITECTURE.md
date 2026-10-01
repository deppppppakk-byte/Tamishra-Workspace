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
Tamishra Mail is the primary first-party mailbox service.

The mail abstraction remains provider-neutral internally so open standards can be supported, but the Workspace product does not use Google or Microsoft mail APIs, OAuth providers or proprietary mail SDKs. Optional external interoperability is limited to standards-based IMAP/SMTP servers.

### Meet
`@tamishra/meet-core` is the provider-neutral meeting boundary.

Workspace owns its meeting runtime. The meeting service must live in this repository or in infrastructure deployed exclusively for Tamishra Workspace.

The implementation may reuse proven architectural ideas such as LiveKit-based media, private joining codes, waiting-room admission, screen sharing, chat/reactions, participant controls, attendance and recording, but it must not call the original Tamishra website at runtime.

Web, desktop and mobile consume the same `meet-core` contract and the same Workspace-owned meeting gateway.

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


## Standalone product boundary

Tamishra Workspace is independently deployable.

Forbidden runtime dependencies:

- the original Tamishra website routes
- its authentication session
- its database schema
- its LiveKit token endpoints
- its payment APIs
- its training/webinar APIs
- its static assets
- its environment variables

Allowed integration:

- ordinary external links
- optional import/migration tools
- explicitly versioned public APIs
- shared third-party infrastructure only when credentials, tenancy and access control are independently scoped for Workspace

All production-critical services must remain operational even if the original Tamishra website is offline.


## Vendor independence

Tamishra Workspace must not depend on Google or Microsoft productivity platforms for its core runtime.

Do not introduce:

- Google account requirements
- Microsoft account requirements
- Google Mail APIs
- Microsoft Graph Mail
- Google Drive or Microsoft OneDrive as core storage
- Google Docs/Sheets/Slides or Microsoft Office web runtimes
- Google Meet or Microsoft Teams dependencies
- vendor-specific branding, terminology or cloned UI

Prefer Tamishra-owned services and open standards/protocols.
