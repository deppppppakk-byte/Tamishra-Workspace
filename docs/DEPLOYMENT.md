# Tamishra Workspace deployment

## Public URLs

Tamishra Workspace is a separate product deployed on the existing Tamishra domain.

Primary entry:

```text
https://tamishra.in/workspace
```

Workspace backend boundary:

```text
https://tamishra.in/api/workspace
```

The public domain is shared with the main Tamishra site, but the Workspace application, build, backend gateway, data model and release lifecycle remain independently owned by the Workspace codebase.

## Routing model

Recommended reverse-proxy behavior:

```text
/workspace/*       -> Workspace web application
/api/workspace/*   -> Workspace gateway/backend
everything else    -> existing tamishra.in application
```

The proxy may strip `/api/workspace` before forwarding to the Workspace gateway.

## Build modes

### Hosted web

```bash
npm run build:web
```

Hosted builds use `WORKSPACE_BASE_PATH=/workspace`.

### Full hosted release

```bash
npm run build:hosted
```

This builds both the web client and Workspace gateway.

### Desktop / EXE

```bash
npm run desktop:build
```

Tauri invokes the root-path native web build so packaged navigation does not include the hosted `/workspace` prefix.

### Mobile

```bash
npm run mobile:sync
```

Capacitor also uses the root-path native build.

## Product separation

Sharing `tamishra.in` does not couple Workspace to the main Tamishra application.

Workspace keeps separate:

- application shell
- gateway/API namespace
- data/schema ownership
- storage namespace
- identity/session implementation
- mail runtime
- meeting runtime
- audit logs
- release pipeline
- environment variables and secrets

The main website may link to `/workspace`, but Workspace must not call unrelated training, webinar or payment APIs.

## Vendor independence

Core Workspace functionality must not depend on Google or Microsoft products or APIs.

Tamishra-owned services are the default. Open standards may be used when interoperability is needed, including IMAP/SMTP, WebRTC, WebSocket and standard document/media formats.
