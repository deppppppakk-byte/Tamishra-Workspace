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

## Object metadata

Drive objects are created with Kosh properties containing the repository ID, storage class, logical object ID and SHA-256 checksum. Kosh stores only the returned Drive file ID and non-secret object metadata in its own metadata store.

Downloads still pass through Kosh authorization and integrity verification. A Drive file is not treated as trusted merely because it exists.

## Quota accounting and concurrency

Storage quota enforcement is independent of the physical backend. Before a storage-heavy request is accepted, Kosh reserves the estimated bytes for that repository.

With PostgreSQL configured, reservations use a repository-scoped PostgreSQL advisory lock and the `kosh_storage_reservations` table. Concurrent Gateway instances therefore account for each other's in-flight uploads before admitting another write.

Production storage writes fail closed if distributed reservations cannot use PostgreSQL. Development can use the in-memory reservation implementation.

Reservation TTL is controlled with:

```env
KOSH_STORAGE_RESERVATION_TTL_MINUTES=120
```

Reservations are finalized when the HTTP response finishes. Successful 2xx writes become `completed`; failed or interrupted writes become `aborted`; stale active reservations expire automatically.

## Current migration model

Existing locally stored objects remain readable through their current local paths. New systems can store a serialized Kosh object locator in their metadata and use the shared `kosh-object-storage` adapter. This permits staged migration by storage class without rewriting Git repositories or metadata history.
