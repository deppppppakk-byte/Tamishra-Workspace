# Kosh Operations workload isolation

Kosh Operations can run as one general worker fleet or as multiple isolated worker pools. This prevents expensive or high-risk jobs from consuming the same capacity as routine notifications, storage maintenance or recovery work.

## Worker pools

Configure each Operations worker service with `KOSH_OPS_WORKER_POOL`.

| Pool | Job types |
| --- | --- |
| `all` | Every Operations job type. Backward-compatible default. |
| `general` | `alerts.evaluate`, `notification.deliver`, `pages.domain.verify`, `secret.rotation.audit` |
| `storage` | `storage.lifecycle`, `replication.verify` |
| `recovery` | `recovery.drill` |
| `database` | `database.backup` |
| `isolated` | `extension.execute`, `load.test`, `failure.probe` |

The pool is enforced when a worker atomically claims a queued job in PostgreSQL. Workers do not claim jobs that belong to another pool.

## Deployment model

Small installations may continue using:

```env
KOSH_OPS_WORKER_POOL=all
```

For production, run separate worker deployments. Example:

```text
kosh-ops-general    KOSH_OPS_WORKER_POOL=general
kosh-ops-storage    KOSH_OPS_WORKER_POOL=storage
kosh-ops-recovery   KOSH_OPS_WORKER_POOL=recovery
kosh-ops-database   KOSH_OPS_WORKER_POOL=database
kosh-ops-isolated   KOSH_OPS_WORKER_POOL=isolated
```

Concurrency, drain/disable controls, worker heartbeats, scheduler election and fleet controls remain process-scoped. Each dedicated worker therefore keeps the same operational controls as the existing Operations fleet.

## Scheduler

Scheduler candidacy is independent from job-pool membership. Multiple worker processes may set `KOSH_OPS_SCHEDULER=true`; PostgreSQL scheduler election still selects one renewable leader.

A common deployment is to make only the `general` fleet scheduler candidates while storage/recovery/database/isolated workers remain consumers only.

## Safety properties

- Pool selection happens before the row is leased.
- PostgreSQL uses `FOR UPDATE SKIP LOCKED`, preserving multi-worker atomicity.
- Priority ordering is preserved inside each pool.
- Existing lease expiry, retries, dead-letter evidence and idempotency remain unchanged.
- A drained or disabled worker stops making new pool claims but lets already-leased work finish.
- The `isolated` pool separates extension execution and bounded load/failure probes from routine worker capacity.
- Database backups and recovery drills can be given dedicated resource sizing without slowing notification or alert delivery.

## Persistence requirement

Dedicated pool claiming requires PostgreSQL because cross-process workload isolation must be atomic. In production Kosh already requires persistent Operations queue storage. The `all` pool retains the existing development-compatible claim path.

## Runtime commands

The normal Operations command now starts the pool-aware worker:

```bash
npm run build --workspace @tamishra/gateway
npm run start:kosh-ops --workspace @tamishra/gateway
```

The pre-pool worker remains temporarily available for rollback/testing:

```bash
npm run start:kosh-ops:legacy --workspace @tamishra/gateway
```

The legacy entrypoint should not be deployed alongside isolated worker pools because it is intentionally capable of claiming every job type.
