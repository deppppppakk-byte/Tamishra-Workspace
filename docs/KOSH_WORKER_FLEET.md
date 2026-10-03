# Kosh Worker Fleet

Kosh Operations workers register runtime capacity and honor persistent operator controls from PostgreSQL.

## Fleet API

Platform administrators can inspect the fleet:

```text
GET /v1/kosh/systems/workers
```

Repository readers can inspect aggregate fleet posture:

```text
GET /v1/kosh/repos/<namespace>/<repository>/systems/workers
```

The platform response includes hostname, process ID, release version, configured concurrency, active jobs, scheduler leadership, heartbeat time, requested state and desired-concurrency override.

## Drain, disable and reactivate

```text
POST /v1/kosh/systems/workers/control
```

Example:

```json
{
  "workerId": "ops-1",
  "requestedState": "draining",
  "desiredConcurrency": 2,
  "reason": "Rolling deployment"
}
```

States:

- `active`: the worker may claim new jobs up to effective concurrency.
- `draining`: current jobs finish, no new jobs are claimed, and scheduler leadership is released if held.
- `disabled`: no new jobs are claimed until an administrator reactivates the worker.

`desiredConcurrency` can reduce capacity below the process startup maximum without restarting the worker. It cannot raise capacity above `KOSH_OPS_WORKER_CONCURRENCY`.

Worker heartbeat updates preserve administrator controls.

## Safe stale-worker cleanup

```text
POST /v1/kosh/systems/workers/prune
```

```json
{ "workerId": "ops-1" }
```

Kosh deletes a worker record only when it is older than `KOSH_OPS_WORKER_STALE_SECONDS` and reports zero active jobs.

## Rolling deployment

1. Mark one worker `draining`.
2. Wait for `activeJobs` to reach zero.
3. Stop and replace the process/container.
4. Let the replacement register and become online.
5. Reactivate it if a stable `KOSH_OPS_WORKER_ID` is reused.
6. Repeat for the next worker.

Keep at least one active worker available during maintenance.

## Scheduler election compatibility

Multiple workers may be scheduler candidates. PostgreSQL leader election still selects one active scheduler. A drained or disabled scheduler releases leadership and does not renew it until reactivated.

## Autoscaling compatibility

The capacity endpoint remains:

```text
GET /v1/kosh/systems/workers/capacity
```

Automatic fleet reconciliation remains leader-only. Fleet summaries and autoscaling recommendations count effective capacity from workers in `active` state and respect each worker's `desiredConcurrency` cap, so deliberate maintenance drains do not appear as usable capacity.

## Metrics

`GET /v1/kosh/systems/metrics` exposes worker fleet evidence in JSON and Prometheus form:

```text
kosh_ops_workers{state="online"}
kosh_ops_workers{state="stale"}
kosh_ops_workers{state="active"}
kosh_ops_workers{state="draining"}
kosh_ops_workers{state="disabled"}
kosh_ops_worker_concurrency
kosh_ops_worker_active_jobs
kosh_ops_worker_available_slots
kosh_ops_scheduler_leaders
kosh_ops_fleet_healthy
```

Useful alerts include zero active workers, zero available slots while queue depth grows, stale workers, and scheduler leader count other than one.

## Operator workspace

The platform-admin UI is available at:

```text
/apps/kosh/workers
```

It provides fleet health, effective capacity, worker state, concurrency controls, drain/disable/reactivate actions and safe stale-record pruning.
