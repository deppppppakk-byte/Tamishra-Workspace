# Kosh operation guards

Kosh protects high-impact control-plane mutations with repository-scoped persisted operation guards. The guard lives in the same durable platform resource store as the rest of the Kosh control plane, so a second Gateway instance cannot acquire the same operation merely because it has a different Node.js process.

## Guarded operations

- `POST /v1/kosh/repos/:namespace/:repository/systems/deployments/requests/:id/execute`
  - one-shot guard
  - requires `releases.manage`
  - a completed execution cannot be executed again through the same semantic operation
- `POST /v1/kosh/repos/:namespace/:repository/systems/recovery/backups/:id/activate`
  - one-shot guard
  - requires `repository.manage`
  - a stale or uncertain activation fails closed and must be reviewed before its guard can be cleared
- `POST /v1/kosh/repos/:namespace/:repository/merge-queue/process`
  - lease guard
  - requires `repository.merge`
  - serializes queue processors across Gateway instances

Successful guarded responses include `X-Kosh-Operation-Id`.

## Operation states

`processing` means the mutation currently owns the guard. `completed` is retained for one-shot operations. A server-side failure after guard acquisition becomes `uncertain`; Kosh does not automatically retry a one-shot destructive operation because the process could have crossed an irreversible boundary before failing.

Repeatable merge-queue processing uses an expiring lease. The default lease is 300 seconds and can be configured with `KOSH_OPERATION_GUARD_LEASE_SECONDS` from 30 to 3600 seconds.

## Inspection and recovery

Repository managers can inspect persisted guards:

`GET /v1/kosh/repos/:namespace/:repository/systems/operations`

A stale, completed, or uncertain guard can be cleared with an interactive session:

`DELETE /v1/kosh/repos/:namespace/:repository/systems/operations/:operationId`

An active unexpired `processing` guard cannot be cleared. Every acquire, completion, release, uncertain result, and manual clear is written to the Kosh audit log.

## Idempotency keys

Guarded requests accept an optional `Idempotency-Key` header containing 8–160 letters, digits, `.`, `_`, `:`, or `-`. Clients should reuse the same key when retrying the same operation. The Gateway CORS preflight allows this header.

## Failure behavior

- a concurrent active operation returns `423 operation_in_progress`
- an already completed one-shot operation returns `409 operation_already_completed`
- an expired/uncertain one-shot operation returns `409 operation_state_uncertain`
- a rejected 4xx downstream request releases the newly acquired guard
- a 5xx downstream result keeps the one-shot guard as `uncertain`

This layer does not replace deployment approvals, restore confirmation, repository ACLs, or audit controls; it wraps those existing controls with cross-instance mutation serialization.
