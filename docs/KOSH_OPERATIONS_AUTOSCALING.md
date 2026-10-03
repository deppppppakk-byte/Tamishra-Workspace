# Kosh Operations fleet autoscaling and scheduler election

Kosh Operations workers separate **scheduler candidacy** from **scheduler leadership** and can now automatically reconcile worker capacity through the elected leader.

## Scheduler leader election

Set `KOSH_OPS_SCHEDULER=true` on two or more worker replicas if desired. Each candidate competes for a PostgreSQL-backed singleton lease. Only the current lease holder:

- reports `scheduler: true` in fleet heartbeats;
- enqueues recurring schedules;
- renews the leadership lease every scheduler cycle;
- evaluates automatic fleet scaling.

The lease is controlled by `KOSH_OPS_SCHEDULER_LEASE_SECONDS` and defaults to 120 seconds. When the leader disappears, another candidate may take over after lease expiry. Production fails closed when scheduler election has no PostgreSQL persistence.

## Capacity recommendation

Platform administrators can inspect the current capacity decision:

```text
GET /v1/kosh/systems/workers/capacity
```

The response includes online workers, full queue counts, oldest queued age, retries/dead letters, active/available execution slots, scheduler leadership, durable scaling state, desired workers, reason, and policy.

Kosh calculates recommendations from the full SQL queue rather than a paginated history window.

## Manual capacity application

A platform administrator can explicitly hand the current recommendation to the trusted deployment scaler:

```http
POST /v1/kosh/systems/workers/capacity
Content-Type: application/json

{"apply":true}
```

Manual and automatic scaling use the same decision engine and durable state.

## Automatic reconciliation

Automatic scaling is disabled by default. Enable it with:

```env
KOSH_OPS_AUTOSCALE_ENABLED=true
```

On each scheduler-leader cycle, Kosh evaluates the queue and fleet. Scaling uses a PostgreSQL singleton state so decisions survive restarts and multiple scheduler candidates cannot independently flap capacity.

Scale-up is responsive to queue pressure. Scale-down is deliberately slower:

```env
KOSH_OPS_AUTOSCALE_COOLDOWN_SECONDS=180
KOSH_OPS_AUTOSCALE_SCALE_DOWN_STABILIZATION_SECONDS=600
```

- no scale action is applied inside the cooldown after the previous successful change;
- downscaling requires continuous idle evidence for the stabilization period;
- the desired worker count is always bounded by configured minimum/maximum values;
- when no workers are online, Kosh recommends at least the minimum;
- scaler failures do not change the recorded `lastAppliedAt` value.

## Capacity policy

```env
KOSH_OPS_AUTOSCALE_MIN_WORKERS=1
KOSH_OPS_AUTOSCALE_MAX_WORKERS=20
KOSH_OPS_AUTOSCALE_TARGET_QUEUED_PER_SLOT=2
KOSH_OPS_AUTOSCALE_ASSUMED_CONCURRENCY=2
KOSH_OPS_AUTOSCALE_SCALE_DOWN_IDLE_SLOTS=4
```

## Scaler adapter

Kosh remains provider-neutral. It sends the desired replica count to:

```env
KOSH_OPS_SCALER_URL=https://scaler.internal.example
KOSH_OPS_SCALER_TOKEN=<secret>
```

In production:

- the scaler URL must be HTTPS;
- a bearer token is mandatory;
- redirects are rejected;
- the request is bounded to eight seconds;
- scaler credentials never appear in API responses or worker-fleet evidence.

The adapter may target Kubernetes, Railway, Render, another container platform, or an internal orchestrator. Kosh owns the capacity decision; the adapter owns provider-specific replica mutation.

## Deployment guidance

For high availability, run at least two scheduler candidates in different failure domains. They may also process ordinary Operations jobs. Configure the scheduler poll interval comfortably below the scheduler lease interval.

Keep automatic scaling disabled until the scaler adapter has been tested through manual capacity application. Then enable automatic reconciliation and observe `/v1/kosh/systems/workers`, `/v1/kosh/systems/workers/capacity`, Operations metrics, and the Operations Control Center.
