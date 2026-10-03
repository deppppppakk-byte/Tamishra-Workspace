# Kosh Operations Control Center

The Operations Control Center is the browser UI for Kosh's durable production worker queue.

Route:

```text
/apps/kosh/operations
```

Repository scope can be opened directly with:

```text
/apps/kosh/operations?namespace=<namespace>&slug=<repository>
```

## Capabilities

The control center uses the existing Kosh Operations API and does not execute heavy work in the browser or Gateway request thread.

It provides:

- platform-administrator or repository-scoped operation views;
- queued, running, completed, failed and cancelled job history;
- dead-letter visibility and manager requeue controls;
- queued/running/retrying counts;
- priority mix and queue saturation;
- one-hour and 24-hour throughput evidence;
- oldest queued job age;
- operation search and filters;
- one-off job creation with priority, retry limits and idempotency keys;
- recurring schedule creation/upsert;
- JSON payload editing;
- cancel controls for queued/leased jobs;
- auto-refresh every 15 seconds, with manual refresh available.

## Authorization

Platform Operations uses the existing explicit Kosh platform-administrator rule.

Repository Operations requires:

- `repository.read` for inspection;
- `repository.manage` for enqueue, schedule, cancel and requeue actions.

The UI does not weaken those server-side rules.

## Queue contract

The Control Center reflects the Operations Queue v2 contract:

- PostgreSQL-backed durable jobs in production;
- priority-aware claims;
- scoped idempotency keys;
- repository/global backpressure;
- renewable worker leases;
- bounded retries;
- dead-letter evidence;
- explicit requeue;
- recurring scheduler deduplication;
- horizontally scalable worker consumers.

The page reports the queue backend returned by the server instead of assuming persistence.

## Production boundary

This page is an operator surface, not a scheduler or worker itself. Kosh Operations workers still run separately with:

```text
npm run start:kosh-ops --workspace @tamishra/gateway
```

Exactly one worker deployment should enable the scheduler leader with `KOSH_OPS_SCHEDULER=true`; additional workers can remain consumers only.
