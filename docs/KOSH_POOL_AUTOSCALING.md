# Kosh Operations pool autoscaling

Kosh supports dedicated Operations worker pools for `general`, `storage`, `recovery`, `database` and `isolated` workloads. Pool autoscaling keeps those workload classes independent so pressure in one class does not force unrelated workers to scale.

## Modes

`KOSH_OPS_POOL_AUTOSCALE_ENABLED=false` keeps the existing global autoscaler and is the backward-compatible mode for `KOSH_OPS_WORKER_POOL=all` deployments.

When `KOSH_OPS_POOL_AUTOSCALE_ENABLED=true`, the elected scheduler runs only the pool-aware scaler. The global automatic scaler is not run in the same scheduler cycle.

## Evidence and decisions

For every dedicated pool Kosh evaluates:

- queued and leased jobs belonging to that pool;
- oldest queued age, retries and dead-lettered jobs;
- online dedicated workers and their effective concurrency;
- available dedicated worker slots;
- `all` workers as fallback evidence, without double-counting them as dedicated capacity;
- independent cooldown, idle stabilization and last-applied scaling state.

Each pool has its own durable row in `kosh_ops_pool_scaling_state`.

## Default capacity policy

| Pool | Default minimum | Default maximum |
| --- | ---: | ---: |
| general | 1 | 20 |
| storage | 0 | 8 |
| recovery | 0 | 4 |
| database | 0 | 4 |
| isolated | 0 | 4 |

If a pool has queued work but no dedicated workers, Kosh requests at least one worker even when the configured minimum is zero. Existing `all` workers remain valid fallback consumers but are reported separately.

Per-pool overrides use:

```text
KOSH_OPS_AUTOSCALE_<POOL>_ENABLED
KOSH_OPS_AUTOSCALE_<POOL>_MIN_WORKERS
KOSH_OPS_AUTOSCALE_<POOL>_MAX_WORKERS
KOSH_OPS_AUTOSCALE_<POOL>_TARGET_QUEUED_PER_SLOT
KOSH_OPS_AUTOSCALE_<POOL>_ASSUMED_CONCURRENCY
KOSH_OPS_AUTOSCALE_<POOL>_SCALE_DOWN_IDLE_SLOTS
KOSH_OPS_AUTOSCALE_<POOL>_COOLDOWN_SECONDS
KOSH_OPS_AUTOSCALE_<POOL>_SCALE_DOWN_STABILIZATION_SECONDS
```

The existing global values are used as fallbacks for common tuning parameters.

## Control API

Platform administrators can inspect all pool recommendations:

```text
GET /v1/kosh/systems/workers/pools/capacity
```

Manual reconciliation requires an explicit apply body:

```json
{ "apply": true }
```

A single pool can be targeted:

```json
{ "apply": true, "pool": "storage" }
```

Manual reconciliation is allowed even when automatic pool scaling is disabled, but still requires a configured trusted scaler adapter.

## Scaler adapter contract

Kosh sends one request per pool that requires a capacity change:

```json
{
  "product": "Kosh",
  "component": "operations-worker-pool",
  "pool": "storage",
  "desiredWorkers": 3,
  "currentWorkers": 1,
  "reason": "queue_pressure",
  "checkedAt": "2026-10-03T00:00:00.000Z"
}
```

In production, `KOSH_OPS_SCALER_URL` must be HTTPS and `KOSH_OPS_SCALER_TOKEN` must be set.

The deployment scaler owns infrastructure-specific actions such as changing replica counts. Kosh owns queue evidence, policy, cooldown/stabilization state and the requested capacity decision.
