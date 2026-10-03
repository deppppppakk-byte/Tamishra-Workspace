# Production operations note

Run one scheduler leader with `KOSH_OPS_SCHEDULER=true` and one or more operations workers. Worker replicas may scale horizontally because queue claims are atomic and leased. Keep production failure probes disabled unless intentionally testing bounded synthetic failure behavior.
