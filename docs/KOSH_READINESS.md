# Kosh Readiness Diagnostics

Kosh exposes non-secret operational readiness diagnostics for the active platform systems.

## Global platform readiness

```text
GET /v1/kosh/systems/readiness
```

This endpoint requires a Kosh platform administrator. It reports `ready`, `degraded`, or `not_ready` from checks that Kosh can actually verify, including persistence, secret-encryption configuration, explicit platform administrators, runner authentication, repository/recovery roots, legacy ACL posture, webhook private-network policy and runner network posture.

Secret values are never returned.

## Repository readiness

```text
GET /v1/kosh/repos/<namespace>/<repository>/systems/readiness
```

This endpoint requires `repository.read`. It reports:

- known storage usage against the repository quota
- whether at least one recovery restore point has been verified
- failed recent Automation runs
- failed recent deployments
- current Merge Queue processing posture

Repository readiness is evidence-based. A missing backup is a warning rather than a fabricated claim that recovery is healthy.

## Status model

- `ready` — all current checks pass
- `degraded` — no hard failure, but one or more warnings require operator attention
- `not_ready` — at least one production-critical check fails

The endpoint is intended for operators and Kosh control-plane UI. It is separate from the generic Gateway `/ready` endpoint, which only indicates that the Gateway process is available to serve requests.
