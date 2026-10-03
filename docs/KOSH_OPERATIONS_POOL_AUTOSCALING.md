# Kosh Operations pool-aware autoscaling

Kosh Operations can isolate heavy or sensitive workloads into dedicated worker pools. Pool-aware autoscaling extends that isolation to capacity decisions so pressure in one workload class does not set the capacity target for every worker service.

## Pools

The dedicated production pools are:

| Pool | Job classes |
| --- | --- |
| `general` | alerts, notifications, Pages-domain verification, secret-rotation audits |
| `storage` | storage lifecycle and replication verification |
| `recovery` | disaster-recovery drills |
| `database` | PostgreSQL backup jobs |
| `isolated` | extension execution, bounded load tests and failure probes |

The `all` pool remains a backward-compatible shared worker pool. Its capacity is reported as fallback capacity, but it is not counted as dedicated capacity when computing a pool target. This prevents shared workers from masking the absence of an isolated production pool.

## Enablement

Pool-aware automatic scaling is opt-in:

```env
KOSH_OPS_POOL_AUTOSCALE_ENABLED=true
```

When it is false, the scheduler keeps using the existing global Kosh Operations autoscaler.

The scheduler leader is the only process that applies automatic scaling decisions. PostgreSQL scheduler election therefore remains the single-writer boundary for automatic fleet reconciliation.

## Capacity bounds

Each pool has independent minimum and maximum worker counts:

```env
KOSH_OPS_POOL_GENERAL_MIN_WORKERS=1
KOSH_OPS_POOL_GENERAL_MAX_WORKERS=20
KOSH_OPS_POOL_STORAGE_MIN_WORKERS=1
KOSH_OPS_POOL_STORAGE_MAX_WORKERS=20
KOSH_OPS_POOL_RECOVERY_MIN_WORKERS=0
KOSH_OPS_POOL_RECOVERY_MAX_WORKERS=10
KOSH_OPS_POOL_DATABASE_MIN_WORKERS=0
KOSH_OPS_POOL_DATABASE_MAX_WORKERS=10
KOSH_OPS_POOL_ISOLATED_MIN_WORKERS=0
KOSH_OPS_POOL_ISOLATED_MAX_WORKERS=10
```

Shared scaling controls continue to define target queue density, assumed concurrency, cooldown and scale-down stabilization:

```env
KOSH_OPS_AUTOSCALE_TARGET_QUEUED_PER_SLOT=2
KOSH_OPS_AUTOSCALE_ASSUMED_CONCURRENCY=2
KOSH_OPS_AUTOSCALE_SCALE_DOWN_IDLE_SLOTS=4
KOSH_OPS_AUTOSCALE_COOLDOWN_SECONDS=180
KOSH_OPS_AUTOSCALE_SCALE_DOWN_STABILIZATION_SECONDS=600
```

## Scaler adapters

A pool may have its own trusted scaler endpoint:

```env
KOSH_OPS_POOL_STORAGE_SCALER_URL=https://scaler.internal.example/kosh/storage
```

If a pool-specific URL is empty, Kosh falls back to `KOSH_OPS_SCALER_URL`. The common bearer credential is `KOSH_OPS_SCALER_TOKEN`. Production scaler endpoints must use HTTPS.

A pool scale request has this shape:

```json
{
  "product": "Kosh",
  "component": "operations-worker-pool",
  "pool": "storage",
  "desiredWorkers": 4,
  "currentWorkers": 2,
  "reason": "queue_pressure",
  "checkedAt": "2026-10-03T00:00:00.000Z"
}
```

The adapter is responsible for translating the desired replica count into the deployment platform being used. Kosh does not couple its control plane to Kubernetes, Vercel, Railway, Render or another hosting vendor.

## Recommendation evidence

For each pool Kosh reports:

- queued and leased jobs for that pool's job types;
- oldest queued age;
- dedicated online worker count;
- effective concurrency and available slots;
- desired worker count and delta;
- reason for the recommendation;
- configured min/max bounds;
- shared `all`-pool fallback capacity;
- scaler availability.

The autoscaler intentionally excludes draining and disabled workers from effective dedicated capacity.

## Scaling state

PostgreSQL table `kosh_ops_pool_scaling_state` persists the control evidence for every dedicated pool:

- desired capacity;
- latest reason;
- pressure start time;
- idle start time;
- last applied scale time;
- last observation time.

This gives each pool an independent cooldown and scale-down stabilization window. A scale-down in one pool therefore does not block a needed scale-up in another pool.

## Administration API

Platform administrators can inspect or manually apply pool capacity reconciliation:

```text
GET  /v1/kosh/systems/workers/capacity/pools
POST /v1/kosh/systems/workers/capacity/pools
```

Manual application requires:

```json
{ "apply": true }
```

The existing aggregate endpoint remains available:

```text
GET  /v1/kosh/systems/workers/capacity
POST /v1/kosh/systems/workers/capacity
```

## Rollout

A safe rollout is:

1. deploy dedicated worker services with `KOSH_OPS_WORKER_POOL` set per service;
2. confirm worker heartbeat evidence for every required pool;
3. configure per-pool minimum/maximum capacity and scaler adapters;
4. inspect `/v1/kosh/systems/workers/capacity/pools` without applying changes;
5. manually apply one reconciliation and confirm the deployment adapter response;
6. enable `KOSH_OPS_POOL_AUTOSCALE_ENABLED=true` for scheduler-led automatic reconciliation;
7. keep at least one `all` worker during migration if shared fallback is desired.

Pool autoscaling changes only Kosh Operations workers. It does not move or scale the live Git repository store.
