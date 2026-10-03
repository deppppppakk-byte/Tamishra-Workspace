# Kosh Operations fair-share scheduling

Kosh Operations uses repository-aware fair-share selection inside each worker pool so one busy repository cannot monopolize all claims indefinitely.

## Why this exists

Queue backpressure limits how many jobs a repository may enqueue, but backpressure alone does not determine which queued job receives the next worker slot. A strict `priority -> available time -> creation time` claim order can repeatedly select work from one high-volume repository while other repositories wait.

Fair-share scheduling adds two bounded controls without removing explicit job priority:

1. prefer repositories using fewer active leases within the same worker pool;
2. gradually raise the effective priority of waiting jobs so old work cannot starve forever.

Urgent operational jobs can bypass the fair-share concurrency tier at a high priority threshold.

## Pool-local fairness

Fairness is calculated independently for:

- `general`
- `storage`
- `recovery`
- `database`
- `isolated`

An active database backup therefore does not consume a repository's fair-share allowance in the storage pool. An `all` worker calculates fairness across all Kosh Operations job types because that worker can execute every class.

The platform scope (`repository_id IS NULL`) is treated as its own scheduling scope.

## Selection order

For normal-priority work, Kosh orders eligible jobs by:

1. repository below/above the configured soft concurrency boundary;
2. current leased count for that repository in the same pool;
3. effective priority, including bounded waiting-time aging;
4. `available_at`;
5. creation time.

Jobs whose explicit priority is at or above `KOSH_OPS_FAIR_SHARE_PRIORITY_BYPASS` skip the fair-share concurrency tier and remain urgent.

All PostgreSQL claims still use row locking with `FOR UPDATE ... SKIP LOCKED`, so multiple workers can claim concurrently without leasing the same job.

## Configuration

```env
KOSH_OPS_FAIR_SHARE_ENABLED=true
KOSH_OPS_REPOSITORY_SOFT_CONCURRENCY=4
KOSH_OPS_FAIR_SHARE_PRIORITY_BYPASS=95
KOSH_OPS_PRIORITY_AGING_MINUTES=30
KOSH_OPS_PRIORITY_AGING_MAX_BONUS=20
```

### `KOSH_OPS_REPOSITORY_SOFT_CONCURRENCY`

This is a preference boundary, not a hard execution cap. When another repository has eligible work and fewer active leases, Kosh prefers that repository. If only one repository has work, it can still use otherwise-idle capacity.

### Priority aging

An eligible waiting job gains one effective priority point for every configured aging interval, up to the configured maximum bonus. Aging is measured from the later of creation time and current `available_at`, so retry backoff does not accumulate hidden scheduling advantage while a job is unavailable.

### Emergency bypass

The bypass threshold preserves a path for urgent platform work. It should remain high enough that ordinary user jobs do not routinely bypass fair sharing.

## Operator evidence

Platform administrators can inspect current scheduling pressure at:

```text
GET /v1/kosh/systems/operations/fairness
```

The response includes:

- active fair-share policy;
- queued and leased counts per repository/platform scope;
- breakdown by worker pool;
- oldest eligible queued age;
- highest queued explicit priority.

The endpoint returns evidence only and does not expose job payloads or secrets.

## Rollback

Set:

```env
KOSH_OPS_FAIR_SHARE_ENABLED=false
```

The pool claim path then falls back to strict priority/FIFO ordering while retaining workload isolation, queue backpressure, leases, retries and pool-aware autoscaling.

## Production boundary

Fair-share scheduling protects Kosh Operations worker capacity. It does not rate-limit Git transport, repository HTTP traffic, Pages serving or other Kosh request paths; those require their own capacity and abuse controls.
