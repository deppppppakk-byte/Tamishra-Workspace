# Tamishra Workspace Identity

## Goal

Tamishra Workspace uses its own first-party identity and session model.

No Google account, Microsoft account or external productivity identity is required.

## Native authentication

Initial authentication methods:

- Tamishra email + password
- passkeys
- recovery codes
- email verification

External identity providers are disabled by design.

## Session model

Each session stores:

- session ID
- user ID
- created time
- expiry time
- last activity time
- optional user-agent metadata
- optional privacy-preserving IP hash
- revocation state

Session cookies used by the hosted web app must be:

- HttpOnly
- Secure
- SameSite protected
- short-lived with rotation
- scoped to the Workspace API boundary

Desktop and mobile should use secure native credential storage rather than browser local storage.

## Password storage

Passwords must never be stored directly.

The production identity service must use a modern memory-hard password hashing function with a unique salt per credential and configurable work factors.

Password reset tokens must be:

- random
- single-use
- short-lived
- stored only as a hash
- invalidated after successful reset

## Passkeys

Passkeys are the preferred passwordless method.

Passkey registration and authentication must be bound to the Tamishra Workspace relying-party configuration for `tamishra.in`.

## Membership model

Users can belong to Workspace organizations with one of:

- owner
- admin
- member
- guest

Authorization is enforced through `@tamishra/permissions`, never through UI visibility alone.

## Gateway boundary

The public hosted client calls:

```text
https://tamishra.in/api/workspace/v1/auth/*
```

The reverse proxy may strip `/api/workspace` before the request reaches `@tamishra/gateway`.

Current discovery endpoint:

```text
GET /v1/auth/capabilities
```

Credential registration, sign-in, passkey enrollment and session persistence should be implemented only after the persistent Workspace identity store is connected.


## Implemented endpoints

The Workspace gateway now provides:

```text
GET    /v1/auth/capabilities
POST   /v1/auth/register
POST   /v1/auth/sign-in
POST   /v1/auth/sign-out
GET    /v1/auth/session
GET    /v1/auth/sessions
DELETE /v1/auth/sessions/:sessionId
PATCH  /v1/auth/profile
```

Hosted public paths are routed through:

```text
https://tamishra.in/api/workspace/v1/auth/*
```

## Implemented credential security

Password credentials use Node's scrypt implementation with:

- unique random salt per credential
- memory-hard derivation
- configurable stored work parameters
- constant-time hash comparison
- no plaintext password persistence

Session cookies use:

- random 256-bit bearer secrets
- only SHA-256 token hashes stored in the database
- HttpOnly
- Secure in production
- SameSite=Lax
- configurable API-only cookie path
- expiry and revocation records

The API never returns the raw session cookie token in JSON.

## Persistent tables

The Identity store initializes:

- `workspace_users`
- `workspace_password_credentials`
- `workspace_sessions`
- `workspace_organizations`
- `workspace_memberships`

Use `WORKSPACE_DATABASE_URL` as the primary PostgreSQL connection setting.

A process-memory fallback exists only for development when no database URL is configured.

## Current capability status

Currently production-implemented:

- password registration
- password sign-in
- sign-out
- persistent sessions
- remember-me sessions
- multi-session listing/revocation
- personal organization creation
- owner membership
- display-name update

Not yet marked production-ready:

- passkeys
- recovery codes
- email verification delivery
- password-reset delivery

The capabilities endpoint reports only features that are actually implemented.
