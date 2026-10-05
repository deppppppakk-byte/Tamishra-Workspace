# Kosh Online Gateway

Kosh is designed so the online PostgreSQL snapshot is the durable repository authority. The online Git gateway uses a disposable local cache and can therefore run on a free/ephemeral container host.

## Free starter deployment

Use Koyeb's Free Web Service with the repository's `Dockerfile.kosh-online`.

[Deploy Kosh Online to Koyeb](https://app.koyeb.com/deploy?type=git&builder=dockerfile&repository=github.com/deppppppakk-byte/Tamishra-Workspace&branch=main&name=kosh-online&instance_type=free&regions=fra&ports=8000%3Bhttp%3B%2F&dockerfile=Dockerfile.kosh-online)

If the repository is private, connect Koyeb to the GitHub account that can read `deppppppakk-byte/Tamishra-Workspace` when prompted.

### Required environment variables

Copy the non-secret values from `.env.kosh-online.example` and set these secrets in the host's secret/environment UI:

- `WORKSPACE_DATABASE_URL`
- `WORKSPACE_IP_HASH_SECRET` (32+ random characters)
- `KOSH_GIT_TOKEN` (24+ random characters)
- `KOSH_RUNNER_TOKEN` (24+ random characters)

Do not put these secrets in source control or in a deploy-button URL.

The service should expose its injected `PORT` (the container defaults to `8000`). The health endpoint is `/health` and readiness endpoint is `/ready`.

## Production routing

Once the host returns a public HTTPS service URL, set the Tamishra production environment variable:

`KOSH_GATEWAY_ORIGIN=https://<online-kosh-service-host>`

Then redeploy the Tamishra web project. Public repository URLs stay stable, for example:

`https://tamishra.in/kosh/git/tamishra/kavyn-2d.git`

## First repository migration

The online gateway bootstraps metadata for:

- `tamishra/kavyn-2d`
- `tamishra/os`

After the Kosh owner has signed in once and ownership is assigned, migrate an existing repository with:

```text
SOURCE_GIT_URL=<source clone URL>
KOSH_TARGET_URL=https://tamishra.in/kosh/git/tamishra/kavyn-2d.git
KOSH_GIT_TOKEN=<service token>
npm run kosh:online:migrate
```

For a private source, provide `SOURCE_GIT_TOKEN` only as a local/CI secret. The migration script sends credentials as HTTP headers and does not embed them in repository URLs.

## Verification

After routing is switched:

```text
KOSH_GIT_TOKEN=<service token>
npm run kosh:online:smoke
```

The smoke test verifies the public health endpoint, authenticated Git read, and authenticated Git receive-pack access with `git push --dry-run`, so no remote reference is modified.

Finally, sign in to Kosh and verify Browser IDE open/edit/stage/commit for a UTF-8 file. Restart/redeploy the online gateway and repeat `git ls-remote` to prove the repository reconstructs from its PostgreSQL snapshot rather than relying on local disk.
