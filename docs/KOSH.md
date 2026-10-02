# Kosh by Tamishra

Kosh is Tamishra's independent development and collaboration platform. Its goal is to replace the full GitHub workflow while keeping compatibility with standard Git clients.

## Phase 1 implemented in this branch

- Kosh Workspace application at `/apps/kosh`
- Generic Kosh core package
- Repository metadata backed by Workspace PostgreSQL, with in-memory development fallback
- Real bare Git repository provisioning through the Workspace gateway
- Git smart HTTP through `git http-backend`
- Standard clone/fetch/push URL shape: `/git/<namespace>/<repo>.git`
- Production write protection through `KOSH_GIT_TOKEN`
- No fake repositories or activity data
- Storage separation between Git objects and future artifact/object storage

## Runtime configuration

```env
KOSH_REPO_ROOT=/var/lib/kosh/repos
KOSH_PUBLIC_ORIGIN=https://kosh.tamishra.in
KOSH_GIT_TOKEN=replace-with-a-long-random-secret
```

The repository root must be on persistent disk. Do not place live Git object directories in Google Drive. Google Drive can later be implemented as a replaceable provider for release assets, build artifacts, backups, CAD/BIM files and other large project objects.

## Git client

```bash
git clone https://kosh.tamishra.in/git/tamishra/project.git
cd project
git add .
git commit -m "Initial commit"
git push origin main
```

For protected pushes, configure the Kosh token as the HTTP password in the user's Git credential manager.

## Next production layers

1. Workspace identity integration and per-repository roles
2. SSH transport and SSH key management
3. Branch protection and signed commits
4. Change requests, diffs, approvals and merge queues
5. Issues, boards, milestones and discussions
6. Runner protocol and workflow engine
7. Package/container registries
8. Release artifacts and object-storage adapters
9. Code/secret/dependency scanning and audit events
10. Pages/deployments, extension SDK, search and organization administration

Kosh must remain provider-neutral: PostgreSQL, Git storage and artifact storage are interfaces, not vendor assumptions.

## Phase 2 — repository browser

Kosh now reads repository state directly from the bare Git object database instead of duplicating branches, tags, commits or trees in PostgreSQL.

Implemented repository APIs:

- repository summary and HEAD state
- branch listing
- tag listing
- commit history by ref
- tree browsing at any path
- bounded text-file previews directly from Git objects
- binary/large-file preview guards

The Workspace repository screen is static-export compatible at:

`/apps/kosh/repository?namespace=<namespace>&slug=<slug>`

This keeps the same route usable in the hosted site, desktop shell and mobile shell while the repository data remains fully runtime-driven.

## Phase 3 — Change Reviews

Kosh now has a native review-and-merge workflow on top of Git.

Implemented:

- branch creation from an existing branch
- policy-controlled branch deletion
- protected-branch direct-push enforcement through a server-side Git pre-receive hook
- branch policy settings for required approvals, requested-changes blocking, direct push and deletion
- live base/head comparison
- ahead/behind counts and changed-file statistics
- bounded unified diff previews
- Change Request creation and lifecycle metadata
- approvals, requested changes and review comments
- file/line comments scoped to changed files
- approval invalidation when reviewed refs move
- Git conflict detection through merge-tree
- atomic fast-forward or merge-commit execution
- atomic base-ref update to avoid racing branch movement
- review close without merge

Static-export-compatible UI routes:

`/apps/kosh/repository?namespace=<namespace>&slug=<slug>`

`/apps/kosh/review?namespace=<namespace>&slug=<slug>&number=<number>`

Change Review metadata lives in PostgreSQL. Branches, commits, diffs, merge bases and merge commits remain Git-native.

## Phase 4 — Work Management

Kosh now includes a native work-management layer that replaces the core GitHub Issues, Projects and Discussions workflow.

Implemented:

- repository issue numbering and lifecycle
- issue descriptions, comments and self-assignment
- labels and multi-label issue assignment
- milestones and due dates
- issue dependencies
- issue links to commits and Change Requests
- automatic commit-message issue linking
- automatic Change Request issue linking
- closing keywords on merged Change Requests: closes, fixes and resolves
- project activity timeline
- repository notifications for issue authors and assignees
- issue templates
- technical/project discussions with categories and replies
- discussion locking
- project boards with Backlog, Ready, In progress, In review and Done stages
- board cards linked directly to issues
- repository Work dashboard and planning UI

Static-export-compatible workspace route:

`/apps/kosh/work?namespace=<namespace>&slug=<slug>`

Issue deep link:

`/apps/kosh/work?namespace=<namespace>&slug=<slug>&issue=<number>`

Work metadata is stored in PostgreSQL. Commit and Change Request links continue to resolve to Kosh's Git-native development layer.

## Phase 5 — Automation / CI-CD

Kosh now includes its own event-driven CI/CD control plane and runner protocol.

Implemented:

- Kosh Workflow Definition v1 stored as provider-neutral JSON
- manual workflow triggers
- Git push triggers detected from real branch-ref changes after receive-pack
- Change Review triggers against the exact reviewed head SHA
- workflow runs, jobs and statuses
- authenticated runner job claiming through KOSH_RUNNER_TOKEN
- standalone @tamishra/kosh-runner service
- exact-commit checkout over Kosh Git smart HTTP
- per-job and per-step environment variables
- step timeouts and continue-on-error behavior
- stdout, stderr and system log streaming back to the Gateway
- .kosh-artifacts convention for build artifacts
- bounded artifact upload with SHA-256 metadata
- environments and protected-branch deployment records
- commit-level status checks
- required Change Review checks
- merge blocking while required checks are queued/running
- merge blocking when required checks fail or are cancelled
- Automation dashboard for workflows, runs, logs, artifacts, environments and deployments

Static-export-compatible workspace route:

`/apps/kosh/automation?namespace=<namespace>&slug=<slug>`

### Runner deployment

The Kosh Runner executes repository-provided commands and must be treated as a trusted execution worker. In production, deploy runners separately from the Gateway in disposable or strongly isolated containers/VMs with restricted filesystem, network and credentials.

Required production values:

```env
KOSH_RUNNER_TOKEN=<separate-long-secret>
KOSH_GATEWAY_ORIGIN=https://kosh.tamishra.in
KOSH_GIT_TOKEN=<git-service-credential-available-only-to-trusted-runners>
KOSH_ARTIFACT_ROOT=/var/lib/kosh/artifacts
```

Start a runner with:

```bash
npm run build:kosh-runner
npm run start --workspace @tamishra/kosh-runner
```

Workflow Definition v1 example:

```json
{
  "version": 1,
  "name": "Build and test",
  "triggers": {
    "manual": true,
    "push": { "branches": ["main"] },
    "changeRequest": { "branches": ["main"] }
  },
  "jobs": [
    {
      "id": "quality",
      "name": "Quality checks",
      "timeoutMinutes": 30,
      "steps": [
        { "name": "Install", "run": "npm install" },
        { "name": "Check", "run": "npm run check" }
      ]
    }
  ]
}
```

Build outputs placed under `.kosh-artifacts/` are uploaded by the runner after the job.

## Expansion 1–22

This expansion starts all remaining GitHub-replacement domains while keeping maturity explicit.

| # | Capability | Current Kosh implementation |
|---|---|---|
| 1 | Packages & registries | Generic immutable binary package publishing/download, SHA-256 metadata, package/channel resources |
| 2 | Releases | Release resources plus persistent release-asset upload/download and checksums |
| 3 | Security | AES-256-GCM encrypted secrets, security-finding resources, audit trail, code-owner policy resources |
| 4 | SSH Git | SSH public-key registration and SHA-256 fingerprints; dedicated SSH transport remains a separate service |
| 5 | Organizations & permissions | Organization/team control-plane resources; deeper repository ACL enforcement remains to be hardened |
| 6 | Merge queue | Persistent priority queue and processor using the same approval/CI/conflict/atomic merge engine as manual reviews |
| 7 | Code search | Git-native code, path and commit-message search |
| 8 | Code intelligence | Symbol/reference search surface, blame endpoint, code-index and code-owner resources |
| 9 | Browser IDE | Authenticated multi-file commit backend on non-default branches with Git hooks, audit and CI trigger |
| 10 | Development environments | Persistent environment definitions; disposable long-running runtime orchestration remains a runner expansion |
| 11 | Wiki / documentation | Repository-scoped wiki-page resources |
| 12 | Pages / static hosting | Static files served directly from configured Git branch/path with private-repo authentication and CSP |
| 13 | Webhooks & integrations | Signed outbound webhooks for push, reviews, issues and completed workflows |
| 14 | Public API & CLI | Scoped hashed API tokens and first-party `@tamishra/kosh-cli` |
| 15 | Notifications | Existing Kosh Work notifications plus subscription resources |
| 16 | Advanced project management | Custom-field resources extending Kosh Work |
| 17 | Release/deployment management | Existing environments/deployments plus deployment-policy resources |
| 18 | Storage layer | Git LFS basic transfer protocol, packages, release assets, CI artifacts and storage-policy resources |
| 19 | Disaster recovery | Native Git-bundle repository backups, SHA-256 verification and downloads |
| 20 | Observability | Global/repository platform summaries, resource counts and audit telemetry |
| 21 | Administration | Global administration-setting resources |
| 22 | Extension SDK | Extension registrations/control plane; richer sandboxed runtime SDK remains an expansion target |

### Platform security rules

- `KOSH_MASTER_KEY` encrypts repository/environment secrets at rest using AES-256-GCM.
- API token plaintext is returned only when a token is created. Only its SHA-256 hash is persisted.
- API token authentication resolves back to the real Workspace user and is accepted across Kosh repository APIs.
- API tokens cannot mint or manage other API tokens or SSH keys; those actions require an interactive Workspace session.
- Browser IDE commits cannot target the default branch directly.
- Git LFS validates uploaded objects against their SHA-256 object IDs.
- Package versions are immutable once published.
- Merge-queue processing cannot bypass Change Review policy or Automation checks.

### Storage configuration

```env
KOSH_MASTER_KEY=<high-entropy-secret>
KOSH_LFS_ROOT=/var/lib/kosh/lfs
KOSH_LFS_MAX_MB=1024
KOSH_PACKAGE_ROOT=/var/lib/kosh/packages
KOSH_RELEASE_ROOT=/var/lib/kosh/releases
KOSH_BACKUP_ROOT=/var/lib/kosh/backups
```

### First-party CLI

```bash
npm run build:kosh-cli
export KOSH_ORIGIN=https://kosh.tamishra.in
export KOSH_TOKEN=kosh_pat_...
node apps/kosh-cli/dist/index.js repo list
node apps/kosh-cli/dist/index.js search tamishra/project "symbolName" code
```

### Kosh Pages

Create a `page_site` resource with a payload such as:

```json
{
  "sourceBranch": "main",
  "sourcePath": "site",
  "indexFile": "index.html"
}
```

The site is then available at:

`/pages/<namespace>/<repository>/`

Private repository Pages require Kosh authentication.

### Git LFS

Kosh exposes the standard basic LFS endpoint beneath the normal Git remote:

`/git/<namespace>/<repository>.git/info/lfs/`

The same Git credential protects LFS uploads; public repositories may serve LFS downloads without authentication.
