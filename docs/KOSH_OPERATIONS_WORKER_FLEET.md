# Kosh Operations worker fleet

Kosh production operations workers publish renewable fleet heartbeats independently from individual job leases. This gives operators evidence that the worker service itself is alive and has usable capacity.

## Persistence

Production worker evidence is stored in PostgreSQL table:

```text
kosh_ops_workers
```

Each record contains:

- worker ID;
- host name and process ID;
- release version;
- configured concurrency;
- current active-job count;
- scheduler-leader flag;
- process start time;
- last heartbeat time.

Workers are not immediately deleted when they stop. They become `stale`, preserving useful failure evidence.

## Configuration

```env
KOSH_OPS_WORKER_HEARTBEAT_SECONDS=15
KOSH_OPS_WORKER_STALE_SECONDS=90
```

The heartbeat interval is bounded to 5–60 seconds. The stale threshold is bounded to 20–3600 seconds.

A normal production setting keeps the stale threshold several heartbeat intervals above the publish interval.

## Scheduler leadership

Recurring schedules still use the explicit deployment flag:

```env
KOSH_OPS_SCHEDULER=true
```

Exactly one **online** worker should have scheduler leadership.

Fleet summary states:

- `healthy` — exactly one online scheduler leader and at least one worker;
- `missing` — no online scheduler leader;
- `multiple` — more than one online scheduler leader.

Kosh reports this evidence; it does not perform hidden leader election behind the deployment configuration.

## API

Platform administrators can inspect individual workers:

```text
GET /v1/kosh/systems/workers
```

The response contains the aggregate summary plus worker records.

Repository readers can inspect aggregate worker capacity without receiving process/host identity:

```text
GET /v1/kosh/repos/<namespace>/<repo>/systems/workers
```

Repository access requires `repository.read`.

## Capacity evidence

Fleet summary contains:

- online worker count;
- stale worker count;
- online scheduler leader count;
- total configured concurrency;
- active jobs;
- currently available slots;
- persistence backend;
- scheduler state;
- overall fleet-health flag.

A worker updates the fleet record at startup, periodically while idle, immediately after claiming work, and immediately after releasing a job slot.

## Security boundary

Individual worker identity, host name, PID and release version are platform-administrator evidence. Repository readers receive only aggregate capacity and health.

The worker registry does not expose job lease tokens, repository credentials, service tokens or object-storage credentials.
