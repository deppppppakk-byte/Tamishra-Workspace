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
KOSH_ORIGIN=http://localhost:4100 npm run start:kosh-plugin
```

The MCP endpoint is:

```text
http://localhost:4310/mcp
```

Health is available at:

```text
http://localhost:4310/health
```

Run the plugin protocol smoke test with:

```bash
npm run check:kosh-plugin
```

### Authentication

The MCP server forwards an incoming Bearer credential to Kosh. For a personal development deployment, `KOSH_PLUGIN_TOKEN` may provide a fallback `kosh_pat_...` token.

Do not commit that token. Public/multi-user deployment must use per-user authorization rather than one shared service token.

The initial ChatGPT tool set is deliberately read-only:

- discover Kosh
- list repositories
- get repository
- repository search
- list issues
- list workflow runs
- list releases
- repository readiness

All tools preserve Kosh repository ACLs and token scopes.

### Remote endpoint

The portable plugin currently targets:

```text
https://kosh.tamishra.in/mcp
```

Production routing must send that path to the `@tamishra/kosh-plugin` process. The endpoint must be public HTTPS before remote ChatGPT testing or public submission.

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

Code for all three surfaces is now present, but public usability still depends on deployment configuration:

1. deploy the web app and map the Kosh public URL;
2. deploy/reverse-proxy the MCP process at `/mcp`;
3. configure per-user authentication for a public ChatGPT plugin;
4. generate/sign Android and iOS native projects for store or direct distribution;
5. provide public support/privacy/terms URLs before public plugin submission.
