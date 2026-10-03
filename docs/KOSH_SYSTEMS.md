# Kosh Systems — Merge, Projects, Delivery, Storage, Recovery, Operations, Administration and Extensions

This runbook documents the eight Kosh systems completed after Public API & CLI. They are native Kosh contracts and use the same repository ACL, audit and persistence boundaries as the rest of the platform.

## Systems workspace

Repository control center:

```text
/apps/kosh/systems?namespace=<namespace>&slug=<repository>
```

Repository API root:

```text
/v1/kosh/repos/<namespace>/<repository>/systems
```

Global platform APIs:

```text
/v1/kosh/systems/observability
/v1/kosh/systems/admin
/v1/kosh/systems/extensions
```

Browser mutations enforce the Workspace allowed-origin boundary. Repository reads use `repository.read`. Management mutations use `repository.manage`, merge-queue controls use `repository.merge`, and deployment controls use `releases.manage`. Global administration requires a configured Kosh platform administrator.

## 1. Merge Queue

Kosh Change Reviews already provide validated queue insertion and processing:

```text
GET  /v1/kosh/repos/<ns>/<repo>/merge-queue
POST /v1/kosh/repos/<ns>/<repo>/merge-queue
POST /v1/kosh/repos/<ns>/<repo>/merge-queue/process
```

The Systems control plane adds operational queue management:

```text
GET   /v1/kosh/repos/<ns>/<repo>/systems/merge-queue
PATCH /v1/kosh/repos/<ns>/<repo>/systems/merge-queue/<entry-id>
```

Supported queue actions are `pause`, `resume`, `cancel`, and bounded priority updates. Entries already processing or merged are locked against operator mutation. Queue processing continues to use the Change Review merge/check logic rather than introducing a second merge implementation.

## 2. Advanced Project Management

Kosh Projects use durable `project_field` resources with a `kind` discriminator:

- `project` — roadmap container
- `iteration` — time-boxed planning cycle
- `field` — typed custom field definition
- `item` — issue/change-request/note planning item

API:

```text
GET  /v1/kosh/repos/<ns>/<repo>/systems/projects
POST /v1/kosh/repos/<ns>/<repo>/systems/projects
POST /v1/kosh/repos/<ns>/<repo>/systems/projects/<project-id>/fields
POST /v1/kosh/repos/<ns>/<repo>/systems/projects/<project-id>/iterations
POST /v1/kosh/repos/<ns>/<repo>/systems/projects/<project-id>/items
PATCH /v1/kosh/repos/<ns>/<repo>/systems/projects/resources/<resource-id>
```

Field types currently supported: text, number, date, single-select, multi-select and boolean.

## 3. Release & Deployment Management

The control plane reuses Automation's native environment and deployment store. It does not create a parallel deployment database.

```text
GET /v1/kosh/repos/<ns>/<repo>/systems/deployments
PUT /v1/kosh/repos/<ns>/<repo>/systems/deployments/policies/<environment>
POST /v1/kosh/repos/<ns>/<repo>/systems/deployments/requests
POST /v1/kosh/repos/<ns>/<repo>/systems/deployments/requests/<id>/approve
POST /v1/kosh/repos/<ns>/<repo>/systems/deployments/requests/<id>/execute
POST /v1/kosh/repos/<ns>/<repo>/systems/deployments/promote
POST /v1/kosh/repos/<ns>/<repo>/systems/deployments/rollback
```

A request can be anchored to a published Kosh Release. In that case the exact immutable release commit and release tag are copied into the deployment request. Policies can require approvals, protect branches, freeze an environment and retain channel/lifecycle metadata. Executing an approved request creates a queued Automation deployment record; the trusted runner remains responsible for runtime status updates.

Promotion and rollback only accept a previously successful deployment as the source commit.

## 4. Storage Layer

```text
GET /v1/kosh/repos/<ns>/<repo>/systems/storage
PUT /v1/kosh/repos/<ns>/<repo>/systems/storage/policy
```

The initial active adapter is the Kosh-controlled filesystem boundary. Policy covers total repository storage, artifact, package, release, backup and retention limits. Usage accounting currently includes known package versions, release assets, Automation artifacts and restore-point bundles. Git LFS bytes are reported separately when direct accounting is available; they are not guessed.

Storage locations remain configured through Kosh environment roots (`KOSH_REPO_ROOT`, `KOSH_LFS_ROOT`, `KOSH_ARTIFACT_ROOT`, `KOSH_PACKAGE_ROOT`, `KOSH_RELEASE_ROOT`, `KOSH_BACKUP_ROOT`). Additional adapters can be introduced through the Extension SDK rather than hard-coding an external provider into Kosh.

## 5. Disaster Recovery

```text
GET  /v1/kosh/repos/<ns>/<repo>/systems/recovery
POST /v1/kosh/repos/<ns>/<repo>/systems/recovery/backups
POST /v1/kosh/repos/<ns>/<repo>/systems/recovery/backups/<id>/verify
POST /v1/kosh/repos/<ns>/<repo>/systems/recovery/backups/<id>/stage
POST /v1/kosh/repos/<ns>/<repo>/systems/recovery/backups/<id>/activate
```

Restore points are full Git bundles of all refs. Each stores a SHA-256 checksum and byte size. Creation is capped by `KOSH_BACKUP_MAX_MB` and old restore points are pruned according to the global `backup_keep_count` setting.

Recovery is intentionally staged:

1. **Verify** checks SHA-256 and `git bundle verify`.
2. **Stage** clones the bundle into a sibling bare repository, runs `git fsck --full`, and preserves Kosh hooks/protected-ref metadata.
3. **Activate** requires the exact `namespace/repository` confirmation string.
4. Before activation, Kosh creates a new `pre_restore_safety` bundle of the currently live repository.
5. The staged repository is then switched into the repository path. If the switch fails, Kosh restores the previous directory.

This protects against an unverified bundle replacing a live repository.

## 6. Observability

Repository view:

```text
GET /v1/kosh/repos/<ns>/<repo>/systems/observability
```

Platform-administrator view:

```text
GET /v1/kosh/systems/observability
```

Repository telemetry includes resource-state counts, Automation run states, deployment history, known storage usage, recent audit events and recent failed/error/invalid resources. The global view aggregates repository/resource counts and recent audit evidence. This is control-plane observability; it does not claim distributed tracing of external infrastructure that Kosh does not operate.

## 7. Administration

```text
GET /v1/kosh/systems/admin
PUT /v1/kosh/systems/admin/settings/<key>
```

Supported audited settings:

- `backup_keep_count`
- `default_storage_quota_bytes`
- `extension_policy`
- `platform_notice`

The administration response also exposes non-secret runtime posture such as persistence type, legacy ACL mode, webhook private-network policy, push scanning/indexing and runner network policy. Secret values are never returned.

Production platform-administrator identity comes from `KOSH_PLATFORM_ADMIN_USER_IDS`. Mutating settings also require an interactive session.

## 8. Extension SDK

Extension registry:

```text
GET  /v1/kosh/systems/extensions
POST /v1/kosh/systems/extensions
PATCH /v1/kosh/systems/extensions/<resource-id>
```

The first Kosh extension runtime is deliberately **declarative**. Registration does not execute arbitrary uploaded JavaScript or shell code inside the Gateway.

Manifest schema version 1 includes:

```json
{
  "id": "tamishra.example",
  "name": "Example",
  "version": "1.0.0",
  "runtime": "declarative",
  "capabilities": ["project-panel"],
  "permissions": ["repository.read"],
  "assetKinds": []
}
```

Validated capabilities:

- `asset-preview`
- `automation-step`
- `code-intelligence`
- `deployment-gate`
- `project-panel`
- `storage-adapter`
- `webhook-transform`

Validated permissions:

- `repository.read`
- `repository.write`
- `repository.manage`
- `storage.read`
- `storage.write`
- `network.egress`

Manifests are versioned and stored disabled unless explicitly enabled. Global registration/state changes require a platform administrator and interactive session. The `@tamishra/kosh-core` package exports the manifest type, capability/permission catalogs and a manifest validator for Kosh-native clients.

## Production configuration

```text
KOSH_BACKUP_ROOT=.kosh/backups
KOSH_BACKUP_MAX_MB=2048
KOSH_PLATFORM_ADMIN_USER_IDS=<workspace-user-id,...>
```

The repository root and backup root should both be persistent in production. For the staged restore switch to remain reliable, the live repository directory must permit sibling restore directories under `KOSH_REPO_ROOT`.
