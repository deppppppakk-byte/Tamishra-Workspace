# Kosh Storage Enforcement

Kosh storage policy is enforced before storage-heavy writes reach their subsystem handlers.

## Covered write boundaries

The Gateway preflights:

- direct package publication under `/v1/kosh/repos/<namespace>/<repository>/packages`
- release asset uploads under `/v1/kosh/repos/<namespace>/<repository>/releases/<tag>/assets`
- Automation runner package publication
- Automation runner artifact uploads

The downstream package, release and Automation handlers keep their existing subsystem-specific size and integrity validation, so the preflight is an additional guard rather than a replacement.

## Policy resolution

Repository policy is read from the active `storage_policy` resource with key `default`.

The enforced fields are:

- `maxTotalBytes`
- `maxArtifactBytes`
- `maxPackageBytes`
- `maxReleaseBytes`
- `maxBackupBytes`

When `maxTotalBytes` is not configured, Kosh uses the global `default_storage_quota_bytes` administration setting. If that setting is also absent, the fallback is 50 GiB.

Known repository usage is calculated from durable Kosh metadata for package versions, release assets, Automation artifacts and recovery bundles. Git LFS remains separately accounted because Kosh does not invent LFS byte totals when authoritative accounting is unavailable.

## Production upload contract

For storage-heavy POST requests, production gateways require a valid `Content-Length` header. Requests without one receive `411 content_length_required_for_storage_write` before their bodies are consumed.

Direct binary uploads use the declared byte length. Runner artifact and package endpoints carry base64 data inside JSON, so the guard uses a conservative encoded-body estimate before the exact downstream decode and size checks run.

## Rejection errors

`storage_object_limit_exceeded`
: the incoming object exceeds its class-specific configured limit.

`repository_storage_quota_exceeded`
: known repository usage plus the incoming write exceeds `maxTotalBytes`.

These return HTTP 413 and include the relevant class and byte limits when available.

## Boundary

This guard prevents obvious quota violations before disk writes and keeps Kosh independent of any particular external storage provider. It does not claim distributed transactional quota reservations across multiple simultaneously active Gateway instances; that can be layered on the persistent control plane separately if multi-Gateway active-active deployment requires it.
