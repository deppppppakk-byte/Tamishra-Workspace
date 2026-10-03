# Kosh production hardening phase

This phase hardens the already-active Kosh product modules for production operation. It does not move live Git repositories into object storage and it does not introduce another development platform as a runtime dependency.

## Architecture

The key addition is a durable **Kosh Operations** queue. Heavy, recurring and failure-prone work runs in a separate worker process instead of blocking Gateway HTTP requests.

- PostgreSQL queue: `kosh_ops_jobs`
- atomic claims: `FOR UPDATE SKIP LOCKED`
- renewable worker leases
- bounded retries with backoff
- cancellation and history
- one explicit scheduler leader, many worker consumers
- production fails closed if the operations queue has no PostgreSQL persistence

Build/start:

```bash
npm run build --workspace @tamishra/gateway
npm run start:kosh-ops --workspace @tamishra/gateway
```

Set `KOSH_OPS_SCHEDULER=true` on exactly one operations-worker deployment. All other worker replicas leave it false.

## Operations API

Repository jobs:

```text
GET  /v1/kosh/repos/<namespace>/<repo>/systems/operations
POST /v1/kosh/repos/<namespace>/<repo>/systems/operations
POST /v1/kosh/repos/<namespace>/<repo>/systems/operations/cancel
```

Repository reads require `repository.read`; queue/schedule mutations require `repository.manage`.

Platform jobs:

```text
GET  /v1/kosh/systems/operations
POST /v1/kosh/systems/operations
POST /v1/kosh/systems/operations/cancel
```

Platform endpoints require an explicit Kosh platform administrator in production.

A one-off job body is:

```json
{
  "type": "recovery.drill",
  "payload": {},
  "maxAttempts": 3
}
```

A recurring job uses the same endpoint:

```json
{
  "type": "storage.lifecycle",
  "payload": {
    "limit": 100,
    "orphanRetentionDays": 30,
    "deleteExpiredOrphans": false
  },
  "schedule": {
    "key": "daily-storage-lifecycle",
    "name": "Daily storage lifecycle",
    "intervalMinutes": 1440,
    "enabled": true
  }
}
```

## 1. Automated Storage Lifecycle Engine

Job type: `storage.lifecycle`

The worker:

1. reconciles Kosh metadata, locator index and Drive inventory;
2. selects local/missing-index objects that are safe to migrate or repair;
3. checks the local source size and SHA-256 before upload;
4. verifies the remote object after upload before switching the locator;
5. can remove the local source only after verification and only when requested;
6. identifies true orphan Drive objects separately;
7. only considers orphan deletion after an age/retention threshold;
8. excludes any remote object that is still referenced by live Kosh metadata.

`deleteExpiredOrphans` defaults false. Garbage deletion is therefore opt-in even for scheduled lifecycle jobs.

## 2. Asynchronous job infrastructure

Job types supported by the production queue:

- `storage.lifecycle`
- `replication.verify`
- `recovery.drill`
- `alerts.evaluate`
- `notification.deliver`
- `pages.domain.verify`
- `extension.execute`
- `load.test`
- `database.backup`
- `secret.rotation.audit`
- `failure.probe`

Workers can scale horizontally. PostgreSQL claims serialize ownership of each individual job while allowing independent jobs to run concurrently.

## 3. Large-object streaming

Kosh object storage now exposes a streaming read path. Package-version downloads, package-channel downloads and release-asset downloads with an object locator are intercepted before legacy handlers and streamed from the configured provider rather than converted into a full Gateway `Buffer` first.

The response retains:

- expected `Content-Length`
- `X-Kosh-Sha256`
- immutable ETag
- normal repository-read authorization

The small-object read API remains for callers that intentionally need bytes in memory.

## 4. Storage replication and failover

Google Drive can remain the primary object provider while Kosh creates a second local mirror for each newly stored object.

```env
KOSH_OBJECT_MIRROR_ROOT=/var/lib/kosh/object-mirror
KOSH_OBJECT_MIRROR_REQUIRED=false
```

With `KOSH_OBJECT_MIRROR_REQUIRED=true`, an object write fails if the mirror cannot be created; Kosh removes the newly-created Drive primary before returning the failure.

Drive reads/materialization can fall back to the mirror when Drive is unavailable. Object deletion removes both copies.

Job type `replication.verify` audits mirror presence/integrity. This is provider failover for Kosh object payloads; it does not mirror the live bare Git repository store.

## 5. Scheduled disaster-recovery drills

Job type: `recovery.drill`

A drill selects the most recent repository recovery bundle, materializes it without changing the live repository, validates its expected size/SHA-256, clones the bundle into an isolated temporary mirror, and runs:

```text
git fsck --full --strict
```

The temporary repository is deleted after the drill. Success is written to the Kosh audit log. A drill never activates a restore.

Use a recurring schedule to prove restoreability continuously.

## 6. Metrics and alerts

Repository metrics:

```text
GET /v1/kosh/repos/<namespace>/<repo>/systems/metrics
```

Platform metrics:

```text
GET /v1/kosh/systems/metrics
```

Normal JSON is returned by default. Send `Accept: text/plain` for Prometheus exposition format.

Current evidence includes:

- operations queue counts by state
- completed-operation p50/p95/p99 elapsed time
- known storage bytes and configured quota
- quota ratio
- recent audit evidence
- recovery point count and verified recovery count

Alert rules are `admin_setting` resources with `payload.kind = "alert_rule"`. `alerts.evaluate` evaluates bounded native metrics such as storage pressure, queued operations and failed operations and emits durable audit evidence when a threshold fires.

## 7. Extension runtime isolation

Job type: `extension.execute`

Extension execution is removed from Gateway request execution. In production, Kosh refuses to execute an extension without `KOSH_EXTENSION_SANDBOX_COMMAND`.

A Docker-oriented reference adapter is provided at:

```text
scripts/kosh-extension-sandbox.mjs
```

It launches extension images with:

- read-only root filesystem
- all Linux capabilities dropped
- `no-new-privileges`
- bounded memory/CPU/PIDs
- bounded temporary filesystem
- no network by default
- no repository filesystem mount by default

Deployments should expose that adapter through a small executable wrapper and set `KOSH_EXTENSION_SANDBOX_COMMAND` to the wrapper path. Extension images/entrypoints remain explicit deployment data; Kosh does not run arbitrary shell strings.

## 8. Notification delivery

Job type: `notification.deliver`

The existing Kosh `subscription` resources are now executable delivery subscriptions. A notification job filters active subscriptions by event and posts a provider-neutral delivery envelope to:

```env
KOSH_NOTIFICATION_DELIVERY_ENDPOINT=https://notification-relay.internal.example
KOSH_NOTIFICATION_DELIVERY_TOKEN=<secret>
```

The relay chooses the real email/push/mobile provider. Kosh therefore owns subscription policy, queueing, retry/evidence and delivery intent without coupling the core platform to one communications vendor.

Use event producers or alert workflows to enqueue delivery jobs. Delivery history is represented by operations state plus Kosh audit evidence.

## 9. Pages custom-domain and TLS automation

API:

```text
GET  /v1/kosh/repos/<namespace>/<repo>/pages/domains
POST /v1/kosh/repos/<namespace>/<repo>/pages/domains
POST /v1/kosh/repos/<namespace>/<repo>/pages/domains/<hostname>/verify
POST /v1/kosh/repos/<namespace>/<repo>/pages/domains/<hostname>/archive
```

Creation returns the required TXT proof:

```text
_kosh.example.com TXT "kosh-domain=<random-token>"
```

Verification runs asynchronously as `pages.domain.verify`. Verified domains can be handed to a trusted certificate/edge adapter:

```env
KOSH_PAGES_TLS_PROVISIONER_URL=https://edge-provisioner.internal.example
KOSH_PAGES_TLS_PROVISIONER_TOKEN=<secret>
```

Kosh records `pending_provisioner`; it does not claim that a TLS certificate exists until the external provisioner actually handles it.

## 10. Scale and bounded failure testing

Job type: `load.test`

The built-in test is intentionally bounded:

- target must resolve to the configured `KOSH_PUBLIC_ORIGIN` origin;
- at most 5,000 requests per job;
- at most 100 concurrent requests;
- reports success rate and p50/p95/p99 response time.

Job type `failure.probe` supports bounded synthetic failure/latency proof. Production probes are disabled unless:

```env
KOSH_ALLOW_PRODUCTION_FAILURE_PROBES=true
```

No destructive network, disk or process-kill chaos is implemented by this job type.

## 11. PostgreSQL operational backups

Job type: `database.backup`

The operations worker invokes `pg_dump` using PostgreSQL custom format with owner/privilege restoration disabled. The resulting dump is hashed, stored through the normal Kosh backup object provider and indexed as a platform backup resource.

The worker image must contain the appropriate PostgreSQL client version.

Typical schedule: at least daily, with retention sized to the platform's recovery objectives.

Restore operations should be performed in an isolated database first:

```text
pg_restore --clean --if-exists --no-owner <dump>
```

Kosh stores backup evidence; production database failover/orchestration remains a database-infrastructure responsibility.

## 12. Secret rotation and failure evidence

Interactive rotation endpoint:

```text
POST /v1/kosh/repos/<namespace>/<repo>/systems/secrets/rotate
```

It requires `repository.manage` **and an interactive session**. API tokens cannot rotate repository secrets. Secret plaintext is accepted only as the new encrypted value and is never returned in the response or audit record.

Job type `secret.rotation.audit` finds secrets older than a configured age and creates audit evidence for overdue rotation.

Recommended recurring controls:

- secret-rotation audit weekly;
- recovery drill weekly or after storage/recovery changes;
- database backup daily or more frequently according to RPO;
- storage lifecycle daily;
- replication verification daily;
- alert evaluation every 5–15 minutes.

## Production boundary

These controls improve Kosh's own behavior, but a production service still depends on its deployment environment. Kosh does not manufacture health for Google Drive, SMTP/push vendors, a TLS edge, Docker hosts or PostgreSQL replicas that it cannot independently prove. Use the Readiness API plus Operations metrics to observe the evidence Kosh actually has.
