# Kosh production phase acceptance checklist

This checklist is the merge gate for the twelve-item Kosh production-hardening phase.

1. Storage lifecycle runs as an asynchronous job with conservative reconciliation and opt-in orphan deletion.
2. Operations jobs are persisted in PostgreSQL, claimed atomically, leased, retried, cancellable, and processed outside Gateway requests.
3. Indexed package and release payload downloads use the streaming object-storage path.
4. Drive-backed objects can be mirrored locally, verified, failed over on reads/materialization, and deleted from both copies.
5. Recovery drills verify a restore point in isolation and never activate it.
6. Repository/platform metrics expose queue/storage/recovery evidence and alert evaluation is asynchronous.
7. Extension execution requires an isolated sandbox command in production and does not execute inline in Gateway.
8. Notification subscriptions can be delivered asynchronously through a provider-neutral relay with retry/evidence.
9. Pages custom domains require ownership proof and TLS provisioning is handed to an explicit trusted adapter.
10. Load and failure probes are bounded and production failure probes are opt-in.
11. PostgreSQL backups run through pg_dump, are hashed, stored through Kosh object storage, and recorded as platform evidence.
12. Repository secret rotation requires repository.manage plus an interactive session; rotation-age audits and safe failure probes are schedulable.

Additional merge requirements:

- `npm run check --workspace @tamishra/gateway` passes.
- Gateway production build and compiled import smoke pass.
- Existing hosted production validation remains green.
- Live Git repositories remain Git-native and are not moved into Google Drive/object storage.
