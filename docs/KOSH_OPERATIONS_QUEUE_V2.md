# Kosh Operations Queue v2

Kosh Operations Queue v2 hardens the asynchronous worker backbone introduced by the production phase. The queue remains PostgreSQL-backed in production and continues to use atomic `FOR UPDATE SKIP LOCKED` claims with renewable leases.

## Goals

Queue v2 adds:

- priority-aware scheduling;
- repository-scoped/platform-scoped idempotency keys;
- bounded queue admission/backpressure;
- durable dead-letter evidence;
- explicit manager requeue;
- safer recurring schedules;
- queue age, retry, priority and throughput metrics.

It does not change live Git repository storage or the semantics of Kosh repository permissions.

## Priority

Every operation has an integer priority from `0` to `100`.

- default: `50`
- high-priority queue: `75–100`
- normal queue: `25–74`
- low-priority queue: `0–24`

Workers claim ready jobs by:

1. highest priority;
2. earliest `availableAt`;
3. oldest creation time.

API example:

```json
{
  "type": "recovery.drill",
  "priority": 80,
  "payload": {}
}
```

Recurring schedules can also persist a priority.

## Idempotency

One-off POST requests may send:

```text
Idempotency-Key: client-generated-key
```

or `idempotencyKey` in the JSON body.

Keys are unique within their Kosh scope:

- one repository; or
- the platform-level queue.

Reusing the same key returns the already-existing operation instead of inserting another job. This gives callers an exactly-once queue insertion primitive even when HTTP requests are retried.

Scheduled jobs automatically use an occurrence key based on the schedule ID and scheduled timestamp. The scheduler now enqueues first and advances `nextRunAt` only after queue insertion. If a worker/scheduler process dies after insertion but before the schedule record is updated, the next pass reuses the same idempotency key and does not duplicate the operation.

## Backpressure

Production queue admission is bounded by:

```env
KOSH_OPS_MAX_QUEUED=10000
KOSH_OPS_MAX_REPOSITORY_QUEUED=1000
```

The first limit bounds all queued work. The second bounds each repository scope and the platform scope independently.

Admission is serialized with a PostgreSQL transaction advisory lock so concurrent Gateway instances cannot all pass the same queue-capacity check.

When a queue limit is reached, the Operations API returns HTTP `429` and a `Retry-After` header.

## Dead-letter evidence

The public job state contract remains compatible:

```text
queued | leased | succeeded | failed | cancelled
```

A job that exhausts its retry budget remains `failed` and also receives `deadLetteredAt`. This preserves existing alert consumers while distinguishing terminal/dead-letter failures from jobs still being retried.

Lease expiry follows the same retry/dead-letter rules.

## Requeue

Repository managers may requeue a terminal failed operation:

```text
POST /v1/kosh/repos/<namespace>/<repo>/systems/operations/requeue
```

Body:

```json
{ "id": "<operation-id>" }
```

Platform administrators may use:

```text
POST /v1/kosh/systems/operations/requeue
```

Requeue resets retry/error/result/lease/dead-letter state and sends the same durable operation row back to `queued`. Its idempotency key remains attached to that row.

## Queue API evidence

Operations-list responses now include `stats` with:

- total jobs;
- counts by state;
- dead-letter count;
- retrying count;
- oldest queued age;
- queued jobs by priority band;
- successful throughput over one hour and 24 hours;
- configured queue limits.

## Metrics

The existing JSON and Prometheus operations metrics now include:

```text
kosh_ops_dead_lettered
kosh_ops_retrying
kosh_ops_oldest_queued_age_ms
kosh_ops_throughput
kosh_ops_queued_by_priority
kosh_ops_queue_limit
```

The platform metrics path uses global queue statistics directly, so platform-level operations such as database backups are included instead of being lost when repository metrics are aggregated.

## Database migration

`readyKoshOpsStore()` upgrades an existing operations table in place with:

- `priority`;
- `idempotency_key`;
- `dead_lettered_at`;
- `finished_at`;
- priority-aware claim index;
- dead-letter index;
- scoped unique idempotency index.

Existing operations receive default priority `50` and remain compatible with the worker.

## Production boundary

Queue v2 protects Kosh queue insertion and worker ownership. It does not guarantee that an external provider called by a job is itself exactly-once. Jobs that invoke external systems must continue to use provider-specific idempotency/evidence where available.