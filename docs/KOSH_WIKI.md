# Kosh Wiki & Documentation

Kosh Wiki is the repository-scoped knowledge system in Kosh. It stores documentation as Kosh-native persistent resources instead of delegating repository knowledge to an external wiki provider.

## Workspace

Open a repository wiki at:

`/apps/kosh/wiki?namespace=<namespace>&slug=<repository>`

The workspace provides:

- repository-scoped documentation pages
- hierarchical page paths such as `engineering/architecture`
- Markdown source editing with a safe in-product preview
- tags and full-page text search
- explicit revision numbers and revision notes
- bounded revision history listing
- restoration of an earlier revision as a new revision
- `[[page/path]]` wiki-link indexing
- backlinks derived from current page links
- soft archive behavior that preserves revision evidence
- audit events for create, update, restore and archive actions

## API

Repository wiki endpoints are rooted at:

`/v1/kosh/repos/<namespace>/<repository>/wiki`

Supported operations:

- `GET /wiki` — list or search current pages
- `POST /wiki` — create a page and revision 1
- `GET /wiki/pages/<page-id>` — read one page and its backlinks
- `PATCH /wiki/pages/<page-id>` — save a new revision
- `DELETE /wiki/pages/<page-id>` — archive the page
- `GET /wiki/pages/<page-id>/history` — list revision history
- `POST /wiki/pages/<page-id>/restore` — restore a historical snapshot as a new revision

Search accepts `?q=<text>`. Archived pages are excluded from normal listing and can be included with `?archived=true`.

## Concurrency

Page updates carry `expectedRevision`. Kosh rejects a stale editor with `wiki_revision_conflict` instead of silently overwriting a newer revision.

## Storage model

Current pages and immutable revision snapshots use the existing persistent Kosh platform resource store with type `wiki_page`:

- current page key: `page:<normalized-path>`
- revision key: `revision:<page-id>:<revision-number>`

Revision records use state `revision`; current pages use `active` or `archived`. Page paths are stable after creation so links remain durable.

The page payload stores Markdown source, revision number, tags, extracted links, excerpt and last-editor metadata. Each revision stores a complete snapshot of the corresponding page content and metadata.

## Security boundaries

- reads require Kosh `repository.read` permission
- mutations require Kosh `repository.write` permission and an authenticated identity
- browser mutations enforce the Workspace allowed-origin boundary
- wiki bodies are bounded to 256 KiB per page
- page paths are normalized and bounded in depth and length
- the preview does not execute raw page HTML or scripts
- audit events contain metadata, not hidden credentials

Public repository wiki reads follow the normal Kosh repository access model. Private and internal repository documentation remains behind Kosh access control.

## Product principle

Kosh Wiki is for durable project knowledge: architecture, runbooks, onboarding, design decisions, APIs, engineering procedures and project documentation. Source code remains in Git; wiki knowledge remains versioned in the Kosh control plane and is connected to repository identity and permissions.
