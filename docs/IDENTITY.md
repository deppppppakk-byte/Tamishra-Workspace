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
