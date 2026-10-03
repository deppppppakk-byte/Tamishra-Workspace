# Kosh production phase merge scope

This branch implements the coordinated twelve-item production-hardening phase:

- automated storage lifecycle
- asynchronous operations workers
- large-object streaming
- object mirror/failover
- recovery drills
- metrics and alert evaluation
- extension runtime isolation adapter
- asynchronous notification delivery
- Pages custom-domain ownership/TLS handoff
- bounded load/failure probes
- PostgreSQL backup evidence
- secret rotation/audit controls

The production queue is the shared execution backbone for recurring/heavy tasks. Object storage remains separate from live Git repository storage. Google Drive can remain the primary Kosh object provider with an optional verified local mirror.
