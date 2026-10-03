# Kosh — ChatGPT plugin, website and app

Kosh exposes one product through three client surfaces. Repository data, permissions, Automation, storage and audit remain owned by the Kosh gateway rather than being duplicated in each client.

## 1. ChatGPT / Codex plugin

The MCP server package is:

```text
apps/kosh-plugin
```

The portable plugin package is:

```text
plugins/kosh
```

The repository marketplace entry is:

```text
.agents/plugins/marketplace.json
```

### Run locally

Start the Kosh gateway first, then run:

```bash
KOSH_ORIGIN=http://localhost:4100 \
KOSH_PLUGIN_TOKEN=kosh_pat_... \
npm run start:kosh-plugin
```

`KOSH_PLUGIN_TOKEN` is a development-only fallback. Production refuses to start the MCP server when that shared PAT fallback is configured.

The MCP endpoint is:

```text
http://localhost:4310/mcp
```

Health is available at:

```text
http://localhost:4310/health
```

Run the plugin protocol/OAuth boundary smoke test with:

```bash
npm run check:kosh-plugin
```

The smoke test verifies protected-resource discovery, the unauthenticated HTTP 401 challenge, OAuth introspection, MCP initialize and the read-only tool catalog.

### Production authentication

Kosh now provides a native OAuth 2.1-style authorization-code flow for the public MCP resource. It uses the existing Kosh identity and repository ACL model; OAuth does not create a second permission system.

MCP protected-resource discovery:

```text
GET https://kosh.tamishra.in/.well-known/oauth-protected-resource
```

Kosh authorization-server discovery:

```text
GET https://kosh.tamishra.in/.well-known/oauth-authorization-server
```

Gateway endpoints:

```text
POST /v1/kosh/oauth/register
GET  /v1/kosh/oauth/authorize
POST /v1/kosh/oauth/authorize
POST /v1/kosh/oauth/token
POST /v1/kosh/oauth/introspect
```

The flow is:

1. an unauthenticated `/mcp` request receives HTTP `401` plus a `WWW-Authenticate` challenge pointing at the protected-resource metadata;
2. the MCP client discovers the Kosh authorization server;
3. a public OAuth client is dynamically registered with approved redirect URIs;
4. authorization uses `response_type=code`, PKCE `S256`, a registered redirect URI and the exact MCP `resource`;
5. the user must have an interactive Kosh session and explicitly approve the read-only consent screen;
6. the one-time authorization code is exchanged for a short-lived opaque `kosh_oat_...` access token and rotating `kosh_ort_...` refresh token;
7. the MCP process introspects each OAuth access token before parsing an MCP request;
8. the MCP process forwards the bearer token to Kosh together with the resource identifier and a private plugin assertion;
9. Kosh resolves the same user identity and applies normal repository ACLs plus the fixed `repo:read` OAuth scope.

OAuth access tokens are therefore resource-bound and cannot be replayed directly against Kosh repository APIs without the private MCP assertion.

The authorization-code, client and access-token records are persisted in PostgreSQL. Production OAuth fails closed without `WORKSPACE_DATABASE_URL`.

### Production variables

A safe template is provided in:

```text
.env.kosh-plugin.example
```

Gateway:

```text
KOSH_OAUTH_ISSUER=https://kosh.tamishra.in
KOSH_OAUTH_RESOURCES=https://kosh.tamishra.in/mcp
KOSH_OAUTH_LOGIN_URL=<actual Tamishra/Kosh interactive login URL>
KOSH_OAUTH_CONSENT_SECRET=<random secret, at least 32 characters>
KOSH_PLUGIN_ASSERTION_SECRET=<random secret, at least 32 characters>
```

MCP process:

```text
KOSH_ORIGIN=https://kosh.tamishra.in
KOSH_PLUGIN_PUBLIC_ORIGIN=https://kosh.tamishra.in
KOSH_OAUTH_ISSUER=https://kosh.tamishra.in
KOSH_PLUGIN_ASSERTION_SECRET=<same private assertion secret as Gateway>
```

`KOSH_PLUGIN_ASSERTION_SECRET` is an internal service assertion and must never be exposed to MCP clients. `KOSH_PLUGIN_TOKEN` must not be configured in production.

Default OAuth lifetimes are one hour for access tokens, 30 days for refresh tokens and ten minutes for authorization codes. They can be bounded with:

```text
KOSH_OAUTH_ACCESS_TOKEN_MINUTES
KOSH_OAUTH_REFRESH_TOKEN_DAYS
KOSH_OAUTH_CODE_SECONDS
```

### MCP tools

The initial tool set remains deliberately read-only:

- discover Kosh
- list repositories
- get repository
- repository search
- list issues
- list workflow runs
- list releases
- repository readiness

All tools preserve Kosh repository ACLs and the `repo:read` OAuth scope.

### Remote endpoint and routing

The portable plugin targets:

```text
https://kosh.tamishra.in/mcp
```

A same-origin production deployment can route:

```text
/mcp                                      -> @tamishra/kosh-plugin
/.well-known/oauth-protected-resource    -> @tamishra/kosh-plugin
/.well-known/oauth-protected-resource/mcp -> @tamishra/kosh-plugin
/.well-known/oauth-authorization-server  -> Kosh Gateway
/v1/kosh/oauth/*                         -> Kosh Gateway
/v1/kosh/*                               -> Kosh Gateway
```

This keeps OAuth discovery on one public origin while the MCP process remains independently scalable.

## 2. Website / PWA

The standalone Kosh web entry is:

```text
/kosh
```

It reuses the existing native Kosh workspace instead of maintaining a separate UI implementation.

PWA files:

```text
/kosh.webmanifest
/kosh-sw.js
/kosh-icon.svg
/kosh-offline.html
```

The service worker caches only application shell/static assets. It deliberately does not cache `/v1/` or `/api/` responses containing repository or account data.

When the browser exposes the install prompt, the `/kosh` shell displays an **Install app** action.

## 3. Native mobile app

The dedicated Capacitor package is:

```text
apps/kosh-mobile
```

Identity:

```text
App ID:   in.tamishra.kosh
App name: Kosh
```

The default remote app URL is:

```text
https://kosh.tamishra.in/kosh
```

Override it for development:

```bash
KOSH_APP_URL=http://10.0.2.2:3000/kosh npm run kosh:mobile:sync
```

Create native projects once:

```bash
npm run kosh:mobile:add:android
npm run kosh:mobile:add:ios
```

Then sync changes with:

```bash
npm run kosh:mobile:sync
```

Android and iOS remain thin Kosh clients. They do not contain a second repository database or a second permission model.

## Production boundary

Code for all three surfaces is now present. Public usability still depends on deployment configuration:

1. deploy the web app and map the Kosh public URL;
2. deploy/reverse-proxy the MCP process at `/mcp` and its protected-resource metadata routes;
3. deploy the Gateway OAuth endpoints with PostgreSQL persistence and the real interactive login route;
4. generate/sign Android and iOS native projects for store or direct distribution;
5. provide public support/privacy/terms URLs before public plugin submission.
