# Kosh Operations Control Center

The Operations Control Center is the browser UI for Kosh's durable production worker queue and worker-fleet capacity control.

Route:

```text
/apps/kosh/operations
```

Repository scope can be opened directly with:

```text
/apps/kosh/operations?namespace=<namespace>&slug=<repository>
```

## Capabilities

The control center uses the existing Kosh Operations APIs and does not execute heavy work in the browser or Gateway request thread.

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
- worker-fleet online/stale evidence and available execution slots;
- scheduler-leader state;
- platform-level current versus desired worker capacity;
- autoscaling policy, cooldown and scale-down stabilization evidence;
- durable last-applied scaling state and pressure/idle timestamps;
- guarded manual application of the current capacity recommendation;
- auto-refresh every 15 seconds, with manual refresh available.

Queue, fleet and capacity evidence refresh through the same page refresh cycle.

## Fleet capacity panel

The platform view reads:

```text
GET /v1/kosh/systems/workers
GET /v1/kosh/systems/workers/capacity
```

The panel surfaces:

- current and desired workers;
- recommendation delta and reason;
- total concurrency, active jobs and available slots;
- full-queue pressure evidence;
- elected scheduler worker and lease expiry;
- whether automatic scaling is enabled;
- configured minimum/maximum workers;
- cooldown and scale-down stabilization windows;
- last applied desired capacity;
- last pressure and continuous-idle evidence;
- safe worker heartbeat metadata such as worker id, release version and last-seen time.

Platform administrators can explicitly apply the current recommendation. The UI requires a confirmation before submitting:

```http
POST /v1/kosh/systems/workers/capacity
Content-Type: application/json

{"apply":true}
```

The server remains authoritative. Cooldown, scale-down stabilization, scaler configuration and production HTTPS/token requirements are enforced server-side even when the action starts from the browser.

When automatic scaling is enabled, the panel explains that the elected scheduler leader evaluates the same shared recommendation automatically.

## Authorization

Platform Operations and capacity mutation use the existing explicit Kosh platform-administrator rule.

Repository Operations requires:

- `repository.read` for inspection;
- `repository.manage` for enqueue, schedule, cancel and requeue actions.

Repository scope may show safe worker-fleet summary evidence but does not expose platform scaler controls or scaler configuration secrets.

The UI does not weaken any server-side rule.

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

The page reports the queue and worker-fleet persistence evidence returned by the server instead of assuming persistence.

## Scheduler and autoscaling contract

Multiple workers may be scheduler candidates. PostgreSQL elects one renewable scheduler leader, and only that leader enqueues recurring schedules or runs automatic capacity reconciliation.

Automatic scaling is opt-in with:

```env
KOSH_OPS_AUTOSCALE_ENABLED=true
```

The capacity decision uses the full SQL queue and durable scaling state. Scale-up responds to pressure, while scale-down requires continuous idle evidence and respects the stabilization period.

The external scaler remains provider-neutral. The UI never receives `KOSH_OPS_SCALER_TOKEN`, database credentials, Drive credentials, operation lease tokens or repository secrets.

## Production boundary

This page is an operator surface, not a worker itself. Kosh Operations workers still run separately with:

```text
npm run start:kosh-ops --workspace @tamishra/gateway
```

For scheduler high availability, multiple worker replicas may set `KOSH_OPS_SCHEDULER=true`; PostgreSQL leader election ensures only one active scheduler leader at a time.