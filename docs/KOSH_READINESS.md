# Kosh Readiness Diagnostics

Kosh readiness is an evidence view over the active Kosh control plane. It is intentionally separate from the Workspace Gateway `/ready` endpoint: process availability does not prove that storage, recovery, automation or platform configuration are production-ready.

## Platform readiness

```text
GET /v1/kosh/systems/readiness
```

This route requires a Kosh platform administrator and returns non-secret configuration posture for:

- persistent PostgreSQL metadata
- Kosh secret-encryption key configuration
- explicit platform-administrator configuration
- Runner authentication
- explicit repository and recovery roots
- legacy repository ACL mode
- webhook private-network blocking
- Runner outbound-network posture

The response status is one of:

- `ready` — every current check passes
- `degraded` — no hard failure exists, but one or more checks need operator attention
- `not_ready` — at least one production-critical check fails

No secret values are returned.

## Repository readiness

```text
GET /v1/kosh/repos/<namespace>/<repository>/systems/readiness
```

This route requires `repository.read` and returns repository-scoped evidence for:

- known storage usage versus enforced quota
- verified and invalid recovery restore points
- recent Automation failures and currently running runs
- recent deployment failures and currently running deployments
- Merge Queue processing and failed entries
- recent audit activity

Storage readiness uses Kosh's known durable metadata for packages, release assets, Automation artifacts and recovery bundles. Kosh does not invent an LFS byte total when authoritative LFS accounting is unavailable.

## Recovery semantics

A repository with no verified restore point is `degraded`, not healthy. A restore point explicitly marked invalid is a readiness failure. Verification evidence comes from the native Kosh recovery workflow rather than file existence alone.

## History semantics

Recent failed Automation runs, deployments or Merge Queue entries are warnings. These diagnostics do not infer that a currently serving application is broken; they report the operational evidence that Kosh actually holds.

## Example shape

```json
{
  "status": "degraded",
  "passing": 5,
  "warnings": 2,
  "failures": 0,
  "scope": "repository",
  "checkedAt": "2026-10-03T00:00:00.000Z",
  "checks": [],
  "storage": {},
  "recovery": {},
  "activity": {}
}
```

The detailed check list is the authoritative explanation for the top-level status.
