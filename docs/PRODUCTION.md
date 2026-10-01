# Tamishra Workspace production release

Tamishra Workspace now has two separate pipelines:

- **Build Tamishra Clients** — continuous integration for development and pull requests.
- **Tamishra Workspace Production Release** — signed, gated production packaging.

## Production gates

A production release does not proceed unless:

1. TypeScript checks pass across the Workspace surfaces.
2. Production dependencies have no known high-or-higher npm audit finding.
3. Hosted web and gateway builds pass.
4. Windows signing secrets are configured.
5. Android signing secrets are configured.
6. Windows Authenticode verification succeeds.
7. Android APK signature verification succeeds.
8. Release artifacts receive SHA-256 checksum manifests.

## Required GitHub Actions secrets

### Windows

- `WINDOWS_CERT_PFX_BASE64`
- `WINDOWS_CERT_PASSWORD`

`WINDOWS_CERT_PFX_BASE64` is the Base64 representation of the code-signing PFX/P12 certificate.

### Android

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The Android keystore must be treated as a permanent release identity. Losing it can prevent future application upgrades.

## Runtime production environment

The Workspace gateway refuses to start in `NODE_ENV=production` when core security values are absent or obviously insecure.

Required:

- `WORKSPACE_DATABASE_URL`
- `WORKSPACE_IP_HASH_SECRET` — at least 32 characters
- `WORKSPACE_ALLOWED_ORIGINS`
- `LIVEKIT_URL` — must use `wss://`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `WORKSPACE_SESSION_COOKIE_SECURE` must not be `false`

Recommended:

- `WORKSPACE_TRUST_PROXY=true` behind the Tamishra reverse proxy.
- `WORKSPACE_SESSION_COOKIE_PATH=/api/workspace`.
- Inject `WORKSPACE_RELEASE_VERSION` from the release version.

## Release process

### Manual production packaging

Open the **Tamishra Workspace Production Release** workflow and supply a SemVer version such as `1.0.0`.

The workflow produces:

- hosted web export
- deployable Workspace gateway archive
- signed Windows EXE / NSIS / MSI artifacts
- signed Android APK
- signed Android AAB
- SHA-256 checksum files

### Tagged release

Create a tag in this format:

```text
workspace-v1.0.0
```

The same production gates run. If every signed package succeeds, GitHub Release publishing is performed automatically.

## Backend health

- `GET /health` — process health and release version
- `GET /ready` — production configuration readiness state

The deployment platform should use these endpoints for health probes.

## Reverse-proxy security headers

The static web export should be served with at least:

```text
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: geolocation=(), payment=(), usb=(), serial=()
Content-Security-Policy: default-src 'self'; connect-src 'self' https: wss:; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; media-src 'self' blob: https:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'
```

Tune `connect-src` to the actual Tamishra Workspace API and LiveKit origins before rollout.

## Repository protection

The `main` branch should be protected in GitHub settings with:

- pull request required before merge
- required passing **Production Quality Gate**
- required passing Website, Workspace Gateway, Windows and Android CI jobs as appropriate
- dismissal of stale approvals
- no force pushes
- no branch deletion

This repository connector cannot enable administrative branch-protection settings, so that final repository policy must be enabled in GitHub by an administrator.
