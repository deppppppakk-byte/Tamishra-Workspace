# Production PostgreSQL

Tamishra Workspace uses standard PostgreSQL through the provider-neutral `postgres` driver.

## Primary runtime variable

```text
WORKSPACE_DATABASE_URL=
```

This database backs Workspace Identity, Patra, Chat, Docs state, Files index and Meet persistence unless a specialized service override is configured.

## Supabase deployment

For the current Render-hosted gateway, use the Supabase **Shared Pooler / Session mode** connection string on port `5432`.

Why:

- Render is a long-running backend process.
- Session mode is reachable over IPv4.
- The gateway uses a small connection pool.
- Prepared statements are disabled in the application driver for broad pooler compatibility.

Do not place the PostgreSQL connection string in any `NEXT_PUBLIC_*` variable or browser bundle.

## Bootstrap order

Before setting `WORKSPACE_DATABASE_URL` on the production gateway:

1. Create the dedicated Tamishra Patra Supabase project.
2. Apply `database/supabase/001_patra_identity_bootstrap.sql`.
3. Run Supabase security and performance advisors.
4. Confirm Identity and Patra tables have RLS enabled.
5. Confirm `anon` and `authenticated` have no direct grants to Workspace/Patra tables.
6. Obtain the Session Pooler connection string.
7. Store it only as the server-side `WORKSPACE_DATABASE_URL`.
8. Deploy the gateway.
9. Run the Patra registration smoke flow against persistent storage.

## Security model

Supabase is used as managed PostgreSQL only.

Tamishra continues to own:

- authentication
- sessions
- organization membership
- authorization
- mailbox ownership
- mail APIs

The public Supabase Data API is not the application data plane for Workspace or Patra.

The bootstrap enables Row Level Security and revokes direct browser-role access as defense in depth.

## Connection pool

Gateway stores use:

```text
max connections per process: 5
prepared statements: disabled
```

Scale the pool only after observing database connection metrics.

## Provider portability

The same application code can use a standard PostgreSQL connection string from Supabase, Neon, Render PostgreSQL, Railway PostgreSQL or another compatible PostgreSQL provider.

No provider-specific database SDK is required by the gateway or Patra Mailer.
