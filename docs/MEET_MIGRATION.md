# Tamishra Meet migration into Workspace

## Source of truth

The meeting product already exists in the private `deppppppakk-byte/Tamishra` repository.

The dedicated meeting product was introduced by commit:

- `95851b6f72416c9c986fcaf20a3ceed2e1f543b3` — **Add Tamishra Meet meeting product**

The current implementation was then hardened by later Tamishra Live commits for screen sharing, identity, waiting-room behavior, token issuance, recording mutations and rate limiting.

## Existing product files

The dedicated Meet layer in Tamishra currently includes:

- `app/(site)/meet/MeetHomeClient.tsx`
- `app/(site)/meet/page.tsx`
- `app/(site)/meet/meet.css`
- `app/api/meetings/route.ts`
- `app/meet/[roomName]/page.tsx`
- `app/meet/[roomName]/MeetRoomClient.tsx`

The meeting room reuses the existing Live runtime, including:

- LiveKit room connection and pre-join device checks
- join context and admission status
- host/co-host/participant roles
- microphone and camera publishing
- presenter screen sharing
- persistent meeting chat and reactions
- hand raise / engagement
- participant moderation
- attendance tracking
- meeting lifecycle controls
- recording infrastructure
- mobile screen-share support

## Existing server behavior

The Tamishra meeting API creates `generic_meeting` sessions in the established live-session schema.

Meeting creation currently provides:

- random 10-character private join code
- instant or scheduled mode
- host membership
- waiting-room policy
- participant screen-share policy
- capacity enforcement
- signed-in access
- moderation state
- secure mutation-origin checks
- request body limits
- sensitive-action rate limiting

The dedicated room then obtains a LiveKit token from the hardened Tamishra Live token service.

## Workspace integration strategy

### Phase 1 — active bridge

Workspace uses `@tamishra/meet-core` as the product boundary.

The web application opens the existing Tamishra Meet runtime through a configurable origin:

`NEXT_PUBLIC_TAMISHRA_MEET_ORIGIN`

If the environment variable is not defined, the current default is:

`https://www.tamishra.in`

This avoids creating a second meeting engine while the Workspace monorepo is still using a static-export web shell.

### Phase 2 — migrate the same runtime

Move the existing Tamishra Meet implementation into Workspace without changing meeting behavior or stored data semantics.

Recommended target structure:

```text
apps/
  meet-service/
packages/
  meet-core/
  meet-livekit/
  meet-server/
```

The static `apps/web`, desktop shell and mobile shell should consume the same `meet-core` contract.

### Phase 3 — retire the bridge

When the Workspace-hosted meeting service reaches feature parity and production verification:

1. switch `@tamishra/meet-core` to the Workspace-native gateway;
2. preserve existing private-code and room identifiers where possible;
3. keep database migrations additive;
4. run parallel compatibility tests against the original Tamishra runtime;
5. remove the bridge only after real host/participant end-to-end verification.

## Important rule

Do not build a second independent meeting feature set in Workspace.

The older Tamishra Meet implementation is the behavioral reference. New Workspace work should either reuse it or migrate it behind `@tamishra/meet-core`.
