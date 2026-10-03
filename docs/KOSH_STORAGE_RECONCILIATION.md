# Kosh storage reconciliation and migration

Kosh treats object storage as a provider-neutral layer. Live Git repositories remain Git-native; Packages, Release assets, Automation artifacts and recovery bundles can use the Google Drive object adapter.

This reconciliation control plane exists to move older local objects safely and to prove that Kosh metadata, the durable locator index and the physical Drive objects still agree.

## Repository API

All endpoints are repository scoped:

```text
GET  /v1/kosh/repos/<namespace>/<repository>/systems/storage/reconcile
POST /v1/kosh/repos/<namespace>/<repository>/systems/storage/reconcile
POST /v1/kosh/repos/<namespace>/<repository>/systems/storage/reconcile/orphans/delete
POST /v1/kosh/repos/<namespace>/<repository>/systems/storage/reconcile/stale-index/delete
```

Reads require `repository.read`. Mutations require `repository.manage`, an allowed browser origin when Origin is present, and Kosh's persisted operation guard.

## Reconciliation evidence

The report compares three independent sources of truth:

1. Kosh product metadata for Packages, Releases, Automation and Recovery.
2. The provider-neutral `kosh_storage_objects` locator index.
3. Actual objects found in the configured Google Drive class folders.

Objects are classified as:

- `drive_indexed` — metadata, locator and Drive object agree.
- `drive_unchecked` — the configured Drive class could not be inspected, so Kosh does not claim the object is missing.
- `drive_missing` — metadata and a Drive locator exist, but the indexed Drive object is absent.
- `drive_mismatch` — stored size/checksum evidence disagrees.
- `recoverable_remote` — a Drive object still matches live Kosh metadata but its locator index is missing or local; it can be repaired without re-uploading.
- `local_indexed` — a local locator remains for live metadata.
- `local_only` — live metadata has only its legacy local payload.
- `missing_payload` — neither a usable Drive object nor local payload can be established.

The report separately identifies stale locator entries and Drive objects that are not referenced by the locator index. Deletion uses an additional metadata-safety filter so a `recoverable_remote` object is never deleted as garbage.

## Dry-run first

Migration POST requests are dry-run by default:

```json
{
  "apply": false,
  "classes": ["package", "release", "artifact", "backup"],
  "limit": 100
}
```

Dry-run returns candidates and records reconciliation evidence, but does not copy or delete object bytes.

## Apply migration

To migrate or repair candidates:

```json
{
  "apply": true,
  "classes": ["package", "release", "artifact", "backup"],
  "limit": 100,
  "deleteLocalAfterVerified": false
}
```

`KOSH_OBJECT_STORAGE_BACKEND=google-drive` is required for apply mode.

For a legacy local object Kosh:

1. Confines the source path to that storage class's configured local root.
2. Verifies the source byte length and SHA-256 against immutable metadata.
3. Uploads the file through the Drive adapter. Large file-backed objects use resumable transfer.
4. Materializes the uploaded Drive object to a temporary reconciliation path.
5. Verifies the materialized byte length and SHA-256 again.
6. Only after successful verification updates the provider-neutral locator index.
7. Keeps the local payload by default.

`deleteLocalAfterVerified=true` removes the local copy only after the remote verification and locator switch succeed.

A Drive object whose `koshLogicalId`, byte length and SHA-256 already match live metadata is downloaded and verified, then its missing locator is repaired without creating a duplicate Drive object.

Migration does not consume extra logical repository quota: the object already exists in Kosh metadata and is already counted in repository usage. The operation moves its physical storage backend rather than adding user data.

## Orphan cleanup

Kosh never deletes Drive objects merely because a locator is missing. A Drive object that still maps to live metadata is treated as recoverable and is protected from orphan cleanup.

Cleanup requires an explicit repository confirmation and explicit object IDs:

```json
{
  "confirm": "<namespace>/<repository>",
  "objectIds": ["drive-file-id"]
}
```

The server recomputes reconciliation immediately before deletion. Only objects that are still safe orphans are removed. At most 100 IDs are processed per request.

## Stale locator cleanup

Stale index cleanup is separate from Drive deletion. It removes locator records whose logical key no longer has live Kosh metadata and does not automatically delete the referenced Drive object.

```json
{
  "confirm": "<namespace>/<repository>",
  "entries": [
    { "storageClass": "package", "logicalId": "..." }
  ]
}
```

This separation prevents a metadata repair operation from silently becoming destructive object deletion.

## Readiness integration

Platform readiness probes the actual configured Packages, Releases, Artifacts and Backups Drive folders when Google Drive is active.

Repository readiness reads the latest stored reconciliation evidence. Missing or integrity-mismatched objects make storage readiness fail. Local migration candidates, recoverable Drive objects, stale indexes, true orphans or stale reconciliation evidence produce a degraded warning instead of a false healthy state.

## Temporary verification workspace

Configure a local verification workspace if desired:

```env
KOSH_STORAGE_RECONCILIATION_ROOT=.kosh/reconciliation
```

This directory is only for temporary materialized verification files. It must not be configured inside a Google Drive-synced folder.

## Operational boundary

Reconciliation does not move live Git repositories to Drive and does not rewrite Git history. It only reconciles the four Kosh object-storage classes: Package payloads, Release assets, Automation artifacts and Recovery bundles.
