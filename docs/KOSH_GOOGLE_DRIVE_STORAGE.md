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
```

A class-specific folder ID takes precedence over the root folder ID. The root ID is only a fallback.

## Object metadata and locator index

Drive objects are created with Kosh properties containing the repository ID, storage class, logical object ID and SHA-256 checksum.

Kosh keeps the provider locator separately in the `kosh_storage_objects` index. This lets repository metadata stay provider-neutral while package versions, release assets and later storage classes can resolve the object without embedding a Drive-specific path into their primary records.

Downloads pass through Kosh authorization and SHA-256/size verification. A Drive file is not treated as trusted merely because it exists.

## Live routed storage classes

With `KOSH_OBJECT_STORAGE_BACKEND=google-drive`:

- package publishes are written to the configured Packages folder;
- package downloads, channel downloads and verification read the indexed Drive object;
- package channel promotion verifies the Drive object before promotion;
- release asset uploads are written to the Releases folder;
- release asset downloads and verification read the indexed Drive object;
- existing local package/release objects keep using the legacy local path when no Drive locator exists.

Automation artifacts and recovery bundles already have folder configuration in the adapter but are intentionally left on their current write path until their migration handlers are switched in a separate change. This keeps the rollout class-by-class and reversible.

## Quota accounting and concurrency

Storage quota enforcement is independent of the physical backend. Before a storage-heavy request is accepted, Kosh reserves the estimated bytes for that repository.

With PostgreSQL configured, reservations use a repository-scoped PostgreSQL advisory lock and the `kosh_storage_reservations` table. Concurrent Gateway instances therefore account for each other's in-flight uploads before admitting another write.

Repository package and release uploads must pass Kosh repository authorization before a reservation is created. Runner package/artifact uploads must pass the Runner bearer token and active job lease before reserving capacity. This prevents unauthenticated requests from consuming reservation headroom.

Production storage writes fail closed if distributed reservations cannot use PostgreSQL. Development can use the in-memory reservation implementation.

Reservation TTL is controlled with:

```env
KOSH_STORAGE_RESERVATION_TTL_MINUTES=120
```

Reservations are finalized when the HTTP response finishes. Successful 2xx writes become `completed`; failed or interrupted writes become `aborted`; stale active reservations expire automatically.

## Migration model

The storage adapter is intentionally provider-replaceable. Existing local objects remain readable, Drive-backed objects are resolved from the locator index, and Git repositories stay on Git-native persistent storage. Switching package/release payload storage therefore does not rewrite Git history or repository metadata.
