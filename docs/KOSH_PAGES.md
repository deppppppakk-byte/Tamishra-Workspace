# Kosh Pages & Static Hosting

Kosh Pages publishes static repository content from an **exact Git commit**. A branch is used only to choose the commit at publish time; serving never follows a moving branch head.

## Workspace

Repository Pages management is available at:

`/apps/kosh/pages?namespace=<namespace>&slug=<repository>`

The workspace supports:

- source branch and source-folder configuration
- configurable index file
- optional single-page-app fallback
- public cache-control configuration
- explicit publish
- exact commit, file-count and byte-count deployment evidence
- deployment history
- one-click rollback by reactivating an earlier deployment
- disable without deleting deployment history
- public Pages URL copy/open controls

## Publish model

A Pages site has one mutable configuration resource and immutable deployment resources.

### Site resource

Kosh stores the current Pages configuration in a `page_site` platform resource with:

`payload.kind = "site"`

The resource tracks the desired source branch/path and the currently active deployment ID.

### Deployment resource

Every publish creates a new `page_site` resource with:

`payload.kind = "deployment"`

The deployment stores:

- exact 40-character Git commit SHA
- source branch used to resolve that commit
- source folder
- index file
- SPA fallback setting
- validated file count
- validated total byte count
- publisher identity and publish timestamp through the platform resource record

Deployments are never rewritten. Rollback changes only the site's active deployment pointer.

## API

Management endpoints are repository scoped:

- `GET /v1/kosh/repos/<namespace>/<repo>/pages`
- `PUT /v1/kosh/repos/<namespace>/<repo>/pages`
- `POST /v1/kosh/repos/<namespace>/<repo>/pages/publish`
- `POST /v1/kosh/repos/<namespace>/<repo>/pages/disable`
- `POST /v1/kosh/repos/<namespace>/<repo>/pages/deployments/<deployment-id>/activate`

Serving remains at:

`/pages/<namespace>/<repository>/...`

Public repositories can be served anonymously through the normal Kosh repository access policy. Private/internal Pages require Kosh repository read access.

## Publish validation

Before Kosh creates a deployment it validates the selected commit and source tree.

The publish is rejected when:

- the configured branch cannot be resolved
- the source folder does not exist
- the source tree is empty
- the index file is missing
- the source contains a Git symlink
- a file exceeds the configured per-file limit
- aggregate site bytes exceed the configured site limit
- the source contains more files than the configured file-count limit

Production defaults:

```env
KOSH_PAGES_MAX_FILE_MB=20
KOSH_PAGES_MAX_SITE_MB=250
KOSH_PAGES_MAX_FILES=5000
```

## Serving guarantees

Serving uses the deployment's exact commit SHA, not the current branch ref. Therefore a later `git push` does not modify the live site until a user publishes again.

The server also provides:

- `GET` and `HEAD` only
- MIME types for common web assets
- `ETag` and conditional `304` handling
- repository-aware cache policy
- deployment and commit response headers
- bounded Git object reads
- directory index resolution
- optional SPA fallback
- CSP, `nosniff`, and frame restrictions

Response evidence headers:

- `x-kosh-pages-deployment`
- `x-kosh-pages-commit`

## Security model

- management reads require `repository.read`
- configuration/publish/disable/rollback require `repository.write`
- browser mutations enforce the Workspace allowed-origin boundary
- path traversal segments are rejected
- Git symlinks are rejected at publish time
- private/internal sites reuse Kosh repository ACLs
- page serving never obtains a checkout credential and reads directly from the bare Git object store
- deployment activation cannot point to an arbitrary SHA; it can only activate a deployment already recorded for that repository

## Current scope

Kosh Pages currently serves sites on the Kosh Pages path namespace. Custom-domain DNS ownership verification and managed TLS are intentionally not claimed by this implementation and remain future infrastructure work.
