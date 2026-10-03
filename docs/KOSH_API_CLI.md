# Kosh Public API & CLI

Kosh exposes a stable public control-plane entrypoint for native clients and trusted automation. The public contract is intentionally separate from vendor-specific APIs and remains rooted in Kosh terminology and permissions.

## Public API root

```text
/v1/kosh/api
```

Discovery is available without authentication:

```text
GET /v1/kosh/api
GET /v1/kosh/api/openapi.json
```

Authenticated public endpoints currently include:

```text
GET /v1/kosh/api/me
GET /v1/kosh/api/repositories
```

Interactive-session token lifecycle endpoints are:

```text
GET    /v1/kosh/api/tokens
POST   /v1/kosh/api/tokens
DELETE /v1/kosh/api/tokens/<token-id>
POST   /v1/kosh/api/tokens/<token-id>/rotate
```

The existing repository API remains available under `/v1/kosh/repos/...` and uses the same Kosh identity, role and token-scope enforcement.

## Authentication

Personal API tokens use the prefix:

```text
kosh_pat_
```

Clients send them as a Bearer credential:

```text
Authorization: Bearer kosh_pat_...
```

The raw token is returned only at creation or rotation time. Kosh persists a SHA-256 token hash and a non-secret prefix for identification. Authentication updates `lastUsedAt`.

Token creation, rotation and revocation require an interactive Workspace session. An API token cannot mint another API token.

## Scope contract

Kosh currently enforces these public token scopes:

- `repo:read` — read repositories and repository-scoped data visible to the token owner.
- `repo:write` — change repository-scoped data where the token owner also has the required Kosh repository role. Write tokens are normalized to include `repo:read`.
- `*` — all currently enforced Kosh API scopes for the token owner. This does not bypass repository roles or Kosh ACLs.

Unknown scopes are rejected by the public token API rather than silently accepted.

Kosh repository permissions remain the final authorization layer. A token with `repo:write` cannot write to a repository where its owner lacks the required repository permission.

## Token expiry

The public token API applies bounded expiry:

- default lifetime: 90 days
- default maximum lifetime: 365 days

Deployments may tune those values with:

```text
KOSH_API_TOKEN_DEFAULT_DAYS=90
KOSH_API_TOKEN_MAX_DAYS=365
```

`KOSH_API_TOKEN_MAX_DAYS` is clamped to a maximum of 3650 days by the gateway.

## API metadata headers

Public API responses include:

```text
X-Kosh-Api-Version: 1
X-Kosh-Api-Contract: 2026-10-03
```

These identify the stable public contract rather than the Workspace release version.

## Developer workspace

The browser workspace is:

```text
/apps/kosh/api
```

It supports:

- API discovery information
- scoped token creation
- one-time token reveal
- token expiry selection
- token rotation
- token revocation
- last-used and expiry inspection
- CLI quick-start commands
- OpenAPI discovery links

## Native Kosh CLI

The CLI package is `@tamishra/kosh-cli` and exposes the executable:

```text
kosh
```

Build it from the monorepo with:

```text
npm run build:kosh-cli
```

### Login

```text
kosh auth login --token kosh_pat_... --origin https://kosh.example
kosh auth status
kosh auth logout
```

The CLI stores its profile at `~/.kosh/config.json` by default. It creates the directory with restrictive permissions where the operating system supports them and writes the configuration file with mode `0600`.

For ephemeral automation, prefer environment variables instead of persisted credentials:

```text
KOSH_ORIGIN=https://kosh.example
KOSH_TOKEN=kosh_pat_...
```

`KOSH_CONFIG` may point to an alternate configuration file.

### Repository commands

```text
kosh repo list
kosh repo view namespace/repository
kosh search namespace/repository "query" code
kosh issue list namespace/repository
kosh workflow runs namespace/repository
kosh release list namespace/repository
kosh resource list namespace/repository release
```

### Generic public API commands

```text
kosh api discover
kosh api get /v1/kosh/api/me
kosh api request POST /v1/kosh/repos/acme/project/work/issues '{"title":"Example"}'
```

The generic API command accepts only relative paths rooted at the configured Kosh origin. It deliberately rejects arbitrary absolute URLs so a token cannot be accidentally forwarded to another host.

## Security notes

- API tokens are not a substitute for repository ACLs.
- Token values should be treated like passwords and must not be committed to a repository.
- Prefer the narrowest available scopes.
- Rotate credentials when they may have been exposed.
- Revoke unused credentials.
- Use HTTPS for production Kosh origins.
- Public API token management requires an interactive browser session and obeys the Workspace allowed-origin boundary for mutations.

## Current boundary

Kosh #14 establishes the stable API discovery/token contract and native CLI. Repository feature APIs continue to live under their existing Kosh routes while sharing the same identity and authorization system. Future API versions can add stable aliases without breaking the v1 discovery contract.
