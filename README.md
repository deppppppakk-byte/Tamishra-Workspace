# Tamishra Workspace

Tamishra Workspace is an independent productivity and collaboration suite.

## Core apps

- **Tamishra Docs** — documents, reports, letters, review and export
- **Tamishra Sheets** — spreadsheets, formulas, charts and analysis
- **Tamishra Slides** — presentations, presenter tools and export
- **Tamishra PDF** — view, annotate, merge, split, fill and export
- **Tamishra Chat** — direct messages, group chat, channels and file sharing
- **Tamishra Patra** — email inbox, compose, threads, folders and search; public domain: `patra.tamishra.in`
- **Tamishra Meet** — video meetings, screen sharing, chat and recording hooks
- **Tamishra Notes** — quick notes, notebooks, rich blocks and task notes
- **Tamishra Forms** — surveys, registrations, quizzes and response analytics
- **Tamishra Files** — recent files, folders, sharing, search and storage

## Product principles

1. Original Tamishra UI, naming and workflows.
2. No visual or terminology cloning of Microsoft Office.
3. Shared design system and command model across every app.
4. Local-first editing where practical, with cloud sync layered on top.
5. Open import/export formats wherever possible.
6. Fast startup, large-file resilience and crash recovery.
7. Accessibility, keyboard navigation and mobile responsiveness from the start.
8. One identity, permission and collaboration system across all modules.
9. No Google or Microsoft runtime dependency, APIs, productivity services or branding.
10. Tamishra-native services first; open standards only where interoperability is needed.

## Workspace shell

The suite should open into one Workspace Home with:

- app launcher
- global search
- recent items
- favorites
- shared with me
- notifications
- activity
- quick create
- storage status
- account/profile
- unified settings

See `docs/PRODUCT_SCOPE.md` and `docs/ARCHITECTURE.md`.


## Independence boundary

Tamishra Workspace is a standalone product and codebase.

It must not depend on the Tamishra training/services website for authentication, APIs, meetings, storage, payments, deployment, routing or runtime assets.

Workspace owns its own:

- web application
- Windows/macOS/Linux desktop shell
- Android/iOS shell
- backend gateway and APIs
- identity and organization model
- file/storage layer
- collaboration and sync services
- Patra provider gateway
- meeting service
- notification service
- deployment configuration
- environment variables and secrets
- product settings and release lifecycle

The original Tamishra website may link users to Workspace, but it is an external product boundary—not a runtime dependency.


## Patra mail transport

Patra's persistent mailbox API is implemented in the Workspace gateway. Internet SMTP transport runs as the separate `@tamishra/patra-mailer` service.

See `docs/PATRA_MAILER.md` for SMTP, MX, SPF, DKIM, DMARC, TLS and deployment requirements.
