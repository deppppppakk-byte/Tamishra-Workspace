# Kosh mobile app

This Capacitor shell opens the standalone Kosh web app and keeps the native package identity separate from Tamishra Workspace.

## Identity

- App ID: `in.tamishra.kosh`
- App name: `Kosh`
- Default app URL: `https://kosh.tamishra.in/kosh`

Override the URL for development or another deployment:

```bash
KOSH_APP_URL=http://10.0.2.2:3000/kosh npm run sync --workspace @tamishra/kosh-mobile
```

Use HTTPS for production deployments. `cleartext` is enabled only when the configured development URL explicitly uses `http://`.

## Native projects

Create and sync Android:

```bash
npm run android:add --workspace @tamishra/kosh-mobile
npm run sync --workspace @tamishra/kosh-mobile
```

Create and sync iOS:

```bash
npm run ios:add --workspace @tamishra/kosh-mobile
npm run sync --workspace @tamishra/kosh-mobile
```

The web product remains the source of truth. The native shell does not duplicate Kosh repository, auth, storage, or collaboration logic.
