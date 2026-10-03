# Kosh Google Drive object storage

Kosh can use Google Drive as a replaceable object-storage backend for packages, release assets, Automation artifacts and recovery bundles. Live Git repositories remain on `KOSH_REPO_ROOT`; Google Drive is not used as the live Git object database.

## Backend selection

Set:

```env
KOSH_OBJECT_STORAGE_BACKEND=google-drive
```

The default remains `local` for development and existing installations.

## Authentication

Kosh uses its own runtime credentials for Google Drive access.

Preferred production configuration uses an OAuth refresh token:

```env
KOSH_GOOGLE_DRIVE_CLIENT_ID=
KOSH_GOOGLE_DRIVE_CLIENT_SECRET=
KOSH_GOOGLE_DRIVE_REFRESH_TOKEN=
```

For short-lived development or controlled infrastructure, an already-issued access token can be supplied instead:

```env
KOSH_GOOGLE_DRIVE_ACCESS_TOKEN=
```

Do not commit any OAuth secret or token to the repository.

## Folder layout

Create one Kosh storage root and four class folders:

```text
Kosh Storage/
  Packages/
  Releases/
  Artifacts/
  Backups/
```

Configure the Drive folder IDs in the deployment environment:

```env
KOSH_GOOGLE_DRIVE_ROOT_FOLDER_ID=
KOSH_GOOGLE_DRIVE_PACKAGES_FOLDER_ID=
KOSH_GOOGLE_DRIVE_RELEASES_FOLDER_ID=
KOSH_GOOGLE_DRIVE_ARTIFACTS_FOLDER_ID=
KOSH_GOOGLE_DRIVE_BACKUPS_FOLDER_ID=
KOSH_GOOGLE_DRIVE_TIMEOUT_MS=120000
KOSH_GOOGLE_DRIVE_CHUNK_MB=8
```

A class-specific folder ID takes precedence over the root folder ID. The root ID is only a fallback.

## Object metadata and locator index

Drive objects are created with Kosh properties containing the repository ID, storage class, logical object ID and SHA-256 checksum.

Kosh keeps the provider locator separately in the `kosh_storage_objects` index. This lets repository metadata stay provider-neutral while package versions, release assets, Automation artifacts and recovery backups resolve the object without embedding a Drive-specific path into their primary records.

Downloads pass through Kosh authorization and SHA-256/size verification. A Drive file is not treated as trusted merely because it exists.

## Live routed storage classes

With `KOSH_OBJECT_STORAGE_BACKEND=google-drive`:

- package publishes are written to the configured Packages folder;
- package downloads, channel downloads and verification read the indexed Drive object;
- package channel promotion verifies the Drive object before promotion;
- release asset uploads are written to the Releases folder;
- release asset downloads and verification read the indexed Drive object;
- Automation Runner artifact uploads are written to the Artifacts folder after Runner bearer authentication and active lease validation;
- Automation artifact downloads and verification use repository-read authorization and verify SHA-256 plus byte length before returning data;
- repository recovery bundles are written to the Backups folder with resumable chunked upload;
- Drive recovery bundles are streamed back to a temporary file for Git bundle verification and restore staging instead of being loaded into Gateway memory;
- pre-restore safety backups use the same configured backend as normal recovery points;
- existing local package, release, Automation artifact and recovery payloads remain readable through their legacy local paths when no Drive locator exists.

## Automation artifact routes

Runner upload remains:

```text
POST /v1/kosh/automation/runner/jobs/<job-id>/artifacts
```

When Drive storage is enabled, Kosh stores the bytes in the Artifacts folder and records a provider-neutral object reference in Automation metadata.

Repository readers can inspect, download and verify an artifact through:

```text
GET /v1/kosh/repos/<namespace>/<repository>/automation/runs/<run-id>/artifacts/<artifact-id>
GET /v1/kosh/repos/<namespace>/<repository>/automation/runs/<run-id>/artifacts/<artifact-id>/download
GET /v1/kosh/repos/<namespace>/<repository>/automation/runs/<run-id>/artifacts/<artifact-id>/verify
```

Legacy local artifact reads are constrained to `KOSH_ARTIFACT_ROOT`; Kosh does not accept an arbitrary filesystem path from artifact metadata.

The Automation artifact payload limit remains 8 MiB, matching the pre-existing Runner contract.

## Recovery bundle lifecycle

Recovery stays on the native Kosh Systems API:

```text
POST /v1/kosh/repos/<namespace>/<repository>/systems/recovery/backups
POST /v1/kosh/repos/<namespace>/<repository>/systems/recovery/backups/<backup-id>/verify
POST /v1/kosh/repos/<namespace>/<repository>/systems/recovery/backups/<backup-id>/stage
POST /v1/kosh/repos/<namespace>/<repository>/systems/recovery/backups/<backup-id>/activate
GET  /v1/kosh/repos/<namespace>/<repository>/systems/recovery/backups/<backup-id>/download
```

Creation still produces a complete Git bundle with `--all`. Kosh hashes the bundle, checks the configured backup object limit, reserves repository capacity using the actual generated bundle size, and then persists the object and metadata.

Google Drive backup upload uses Drive's resumable upload protocol in bounded chunks (`KOSH_GOOGLE_DRIVE_CHUNK_MB`, default 8 MiB), so multi-gigabyte bundle support does not require a same-sized in-memory buffer.

Verification materializes a Drive bundle to a bounded temporary path below `KOSH_BACKUP_ROOT`, validates byte length and SHA-256, and runs `git bundle verify`. Staging then creates a bare repository from that verified bundle and runs `git fsck --full` before any activation is permitted.

Activation retains Kosh's persisted operation guard and explicit `<namespace>/<repository>` confirmation. Immediately before switching the repository, Kosh creates a `pre_restore_safety` restore point through the same backend, validates the staged repository again, and only then performs the atomic repository-directory swap with rollback if the swap fails.

Backup retention removes both the metadata resource and its indexed Drive object. Existing local restore points stay valid and continue to use their confined `KOSH_BACKUP_ROOT` path.

The existing backup size policy remains controlled by `KOSH_BACKUP_MAX_MB` and repository storage policy.

## Quota accounting and concurrency

Storage quota enforcement is independent of the physical backend. Before a storage-heavy request is accepted, Kosh reserves the estimated or known bytes for that repository.

With PostgreSQL configured, reservations use a repository-scoped PostgreSQL advisory lock and the `kosh_storage_reservations` table. Concurrent Gateway instances therefore account for each other's in-flight writes before admitting another object.

Repository package and release uploads must pass Kosh repository authorization before a reservation is created. Runner package/artifact uploads must pass the Runner bearer token and active job lease before reserving capacity. Server-generated backups reserve capacity after the Git bundle is generated, using its actual byte size.

Production storage writes fail closed if distributed reservations cannot use PostgreSQL. Development can use the in-memory reservation implementation.

Reservation TTL is controlled with:

```env
KOSH_STORAGE_RESERVATION_TTL_MINUTES=120
```

Reservations are finalized when the storage operation commits. Completed writes become `completed`; failed writes become `aborted`; stale active reservations expire automatically.

## Migration model

The storage adapter is intentionally provider-replaceable. Existing local objects remain readable, Drive-backed objects are resolved from the locator index, and Git repositories stay on Git-native persistent storage. Switching package/release/artifact/backup payload storage therefore does not rewrite Git history or repository metadata.
