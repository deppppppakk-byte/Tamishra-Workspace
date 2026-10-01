# Tamishra Meet — standalone Workspace implementation

## Product boundary

Tamishra Meet is part of Tamishra Workspace and must run independently of the original Tamishra website.

The original product may be used only as a behavioral reference during migration. Production Workspace clients must not redirect to, fetch tokens from, or depend on `tamishra.in` meeting routes.

## Workspace-owned target

```text
apps/
  web/
  gateway/
  meet-service/
  desktop/
  mobile/

packages/
  meet-core/
  meet-livekit/
  identity/
  permissions/
  notifications/
```

## Required meeting behavior

The standalone Workspace meeting stack should provide:

- instant and scheduled meetings
- private joining codes
- authenticated host ownership
- waiting-room admission
- host/co-host/participant roles
- microphone and camera publishing
- screen sharing
- in-meeting chat
- reactions
- hand raise
- participant moderation
- attendance
- meeting lifecycle controls
- recording integration
- browser/mobile support
- meeting notes integration
- rate limiting and abuse controls

## Media boundary

`@tamishra/meet-core` remains provider-neutral.

A LiveKit adapter is acceptable, but:

- LiveKit credentials belong to Workspace infrastructure
- token issuance belongs to Workspace backend services
- room metadata belongs to Workspace storage
- clients never receive service secrets
- provider-specific SDK details stay outside the core domain model

## Migration rule

Features may be ported or reimplemented from the earlier Tamishra meeting experience, but code and data dependencies must be brought into this repository or into Workspace-owned infrastructure before they are considered production-ready.

## Completion criteria

Meet is considered standalone only when:

1. the original Tamishra website can be unavailable without affecting meetings;
2. Workspace creates rooms itself;
3. Workspace issues media tokens itself;
4. Workspace stores meeting membership and attendance itself;
5. host and participant flows work from Workspace web/desktop/mobile;
6. no runtime configuration points to the old website.
