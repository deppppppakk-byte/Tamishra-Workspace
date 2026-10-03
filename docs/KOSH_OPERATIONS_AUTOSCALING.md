# Kosh Operations fleet autoscaling and scheduler election

Kosh Operations workers now separate **scheduler candidacy** from **scheduler leadership**.

## Scheduler leader election

Set `KOSH_OPS_SCHEDULER=true` on two or more worker replicas if desired. Each candidate competes for a PostgreSQL-backed singleton lease. Only the current lease holder:

- reports `scheduler: true` in fleet heartbeats;
- enqueues recurring schedules;
- renews the leadership lease every scheduler cycle.

The lease is controlled by `KOSH_OPS_SCHEDULER_LEASE_SECONDS` and defaults to 120 seconds. When the leader disappears, another candidate may take over after lease expiry. Production fails closed when scheduler election has no PostgreSQL persistence.

This removes the deployment requirement that operators manually guarantee exactly one scheduler-enabled worker.

## Capacity recommendation

Platform administrators can inspect the current capacity decision:

```text
GET /v1/kosh/systems/workers/capacity
```

The response includes:

- online worker count;
- queued and leased operations;
- active and available execution slots;
- current scheduler leader lease;
- bounded minimum/maximum worker policy;
- desired worker count and reason;
- whether an external scaler adapter is configured.

Kosh calculates a recommendation from queue pressure and observed fleet concurrency. It does not assume a specific cloud or container platform.

## Applying capacity

A platform administrator may explicitly request the current recommendation be handed to a trusted deployment scaler:

```http
POST /v1/kosh/systems/workers/capacity
Content-Type: application/json

{"apply":true}
```

Kosh sends the desired count to `KOSH_OPS_SCALER_URL`. In production:

- the scaler URL must be HTTPS;
- `KOSH_OPS_SCALER_TOKEN` is required;
- redirects are rejected;
- the outbound request is bounded to 8 seconds;
- Kosh never exposes the scaler token in API responses.

The scaler adapter owns provider-specific actions such as changing Kubernetes replicas, a Railway/Render/Vercel worker count, or another deployment system. Kosh remains provider-neutral.

## Capacity policy

```env
KOSH_OPS_AUTOSCALE_MIN_WORKERS=1
KOSH_OPS_AUTOSCALE_MAX_WORKERS=20
KOSH_OPS_AUTOSCALE_TARGET_QUEUED_PER_SLOT=2
KOSH_OPS_AUTOSCALE_ASSUMED_CONCURRENCY=2
KOSH_OPS_AUTOSCALE_SCALE_DOWN_IDLE_SLOTS=4
```

The recommendation is always clamped between the configured minimum and maximum. When no workers are online, Kosh recommends at least the configured minimum. A missing scheduler leader is surfaced as the decision reason so an operator can distinguish scheduling failure from normal queue pressure.

## Deployment guidance

For high availability, run at least two scheduler candidates in different failure domains. They may also process normal operations jobs. The PostgreSQL scheduler lease prevents duplicate recurring schedule cycles from healthy candidates.

Worker fleet heartbeats remain evidence only; they do not contain job lease tokens, database credentials, Drive credentials, or scaler secrets.
