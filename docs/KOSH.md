# Kosh by Tamishra

Kosh is Tamishra's independent development and collaboration platform. It defines its own workflows, architecture and product direction while remaining compatible with standard Git clients.

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

Kosh now includes its own native work-management layer for issues, planning, discussions and connected project activity.

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

This expansion develops the broader Kosh platform domains while keeping maturity explicit.

| # | Capability | Current Kosh implementation |
|---|---|---|
| 1 | Packages & registries | Generic immutable binary package publishing/download, SHA-256 metadata, package/channel resources |
| 2 | Releases | Release resources plus persistent release-asset upload/download and checksums |
| 3 | Security | AES-256-GCM encrypted secrets, security-finding resources, audit trail, code-owner policy resources |
| 4 | SSH Git | SSH public-key registration and SHA-256 fingerprints; dedicated SSH transport remains a separate service |
| 5 | Organizations & permissions | Active namespace ownership, teams, repository roles and enforcement across API, Git HTTP, LFS, Pages, Mesh and Pulse |
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


## Kosh Flow

Kosh Flow is a native Kosh system for understanding a project's live movement from intent to operation.

Flow is not a second project database. It derives state from existing Kosh systems and stores only relationships that Kosh cannot infer automatically.

### Flow stages

1. **Shape** — issues, milestones and discussions
2. **Change** — Change Reviews and commits
3. **Prove** — Automation runs and required checks
4. **Deliver** — packages and releases
5. **Run** — deployments, Pages and recovery assets

Static-export-compatible workspace route:

`/apps/kosh/flow?namespace=<namespace>&slug=<slug>`

### Derived relationships

Kosh Flow automatically connects:

- milestones → issues
- issue dependencies
- issues → Change Reviews
- issues → commits
- Change Reviews → reviewed commits
- Change Reviews → Automation runs
- commits → push-triggered Automation runs
- Automation runs → packages/releases when provenance is present
- Automation runs → deployments
- releases → deployments when commit provenance matches

### Flow health

Flow normalizes live state into:

- `good`
- `attention`
- `blocked`
- `failed`
- `neutral`

Examples:

- an open issue with an unresolved issue dependency becomes blocked
- a failed required review check marks its Change Review as failed in Flow
- running or queued Automation becomes attention
- successful releases/deployments become good
- failed deployments become failed

The repository Flow state is derived from the strongest current signal:

`failed → blocked → moving → stable`

### Manual Kosh relationships

Users can add relationships that are meaningful to their project but cannot be inferred safely:

- depends on
- implements
- references
- validated by
- produces
- promotes to
- delivers to
- blocks
- relates to
- supersedes
- contains

Manual relationships are stored in `kosh_flow_links`; source-system state remains in the original Kosh system.

### Unified timeline

Flow combines Work activity, Change Review state, Automation runs, packages, releases, deployments and platform audit events into one repository timeline.

### Product principle

Kosh Flow exists to answer:

> What is this project trying to do, what changed, what proved it, what was delivered, and what is running now?

This is Kosh's own lifecycle model: one connected view of intent, change, proof, delivery and operation.


## Kosh Mesh

Kosh Mesh is the workspace-wide system graph above repository-level Flow.

- **Flow** answers how one repository moves from intent to operation.
- **Mesh** answers how repositories, services, apps, APIs, data, engineering assets and runtime environments depend on each other.

Workspace route:

`/apps/kosh/mesh`

### Mesh node types

Mesh automatically creates live nodes for every Kosh repository. Additional Kosh-native component nodes can represent:

- service
- app
- API
- package
- data
- CAD asset/system
- BIM asset/system
- document
- environment
- deployment
- workspace
- generic component

Repository health is derived from its current Kosh Flow state; it is not copied into Mesh storage.

### Mesh relationships

Kosh Mesh supports:

- depends on
- provides
- consumes
- publishes
- deploys to
- uses
- syncs with
- contains
- relates to
- replaces
- extends

Components may optionally declare a repository reference in metadata. Mesh derives a `uses` relationship to that repository when the repository exists.

### Impact analysis

For any Mesh node, Kosh computes:

- upstream dependencies
- downstream impact
- relationship type
- traversal depth

Traversal is cycle-safe and bounded to eight relationship levels.

This allows Kosh to answer questions such as:

- Which systems depend on this repository?
- Which API will be affected by this service?
- Which deployments consume this package?
- Which CAD/BIM component belongs to this engineering system?
- What is upstream of a failed runtime component?

### Mesh storage principle

Kosh Mesh stores only cross-system component definitions and relationships. Repository lifecycle state stays in Flow and the original Kosh subsystems.


## Kosh Pulse

Kosh Pulse is the live command layer above Flow and Mesh.

- **Flow** describes movement inside one repository.
- **Mesh** describes dependency and impact across systems.
- **Pulse** decides what needs attention now.

Workspace route:

`/apps/kosh/pulse`

### Live signals

Pulse does not persist system health. It derives signals from the current Mesh graph.

A signal is created when a Mesh node is:

- attention
- blocked
- failed

Signal urgency is calculated from:

1. current node health
2. total downstream blast radius
3. downstream failed systems
4. downstream blocked systems

Pulse assigns a 0–100 score and maps it to:

- low
- medium
- high
- critical

Because the signal key includes the current node health, an acknowledgement does not hide a later state change.

### Pulse state

The workspace Pulse state is derived as:

- `clear` — no active attention signals
- `watch` — medium signals exist
- `degraded` — high signals or open incidents exist
- `critical` — critical signals or critical open incidents exist

### Acknowledgements

Acknowledgement means a person has seen and temporarily owns a signal.

It does not:

- change Mesh health
- change Flow state
- resolve an incident
- permanently suppress a signal

Acknowledgements expire automatically. The supported UI windows are one hour, four hours, one day and seven days.

### Incidents

Incidents are explicit human decisions and are never automatically opened by Pulse.

Incident lifecycle:

`open → investigating → mitigating → resolved`

Each incident has:

- target Mesh node
- severity
- summary
- owner
- creator
- timestamps
- resolution time

Pulse stores incidents and acknowledgements only. The system truth remains in Flow, Mesh and the original Kosh subsystems.

### Native Kosh stack

```text
Repository systems
        ↓
      Flow
        ↓
      Mesh
        ↓
      Pulse
        ↓
Human attention / incident action
```


## Kosh Access

Kosh Access is the native authorization layer for namespaces, repositories and cross-system visibility.

Workspace route:

`/apps/kosh/access`

Repository-specific route:

`/apps/kosh/access?namespace=<namespace>&slug=<slug>`

### Repository roles

Kosh repository roles are independent from general Workspace membership roles.

| Role | Capabilities |
|---|---|
| Reader | Read repository content and visible repository systems |
| Reviewer | Reader capabilities plus Change Review participation |
| Contributor | Reviewer capabilities plus Git writes, workflow runs and package publishing |
| Maintainer | Contributor capabilities plus merge, repository management, Automation management, releases, security and access administration |
| Owner | Full repository authority |

Effective repository access can come from:

1. explicit user grant
2. team grant
3. namespace organization authority
4. public read access
5. temporary legacy migration mode for pre-ACL repositories

Kosh chooses the strongest applicable repository role.

### Namespace ownership

Every new Kosh repository namespace is bound to a Workspace organization.

A namespace can be claimed by an organization owner or admin. On first repository creation, Kosh can automatically bind an unclaimed namespace when the user has exactly one organization where they are owner/admin.

If Kosh cannot determine the intended organization safely, repository creation returns `namespace_binding_required` and the namespace must be bound explicitly in Kosh Access.

### Teams

Teams are namespace-scoped groups.

A repository grant may target:

- one Workspace user
- one Kosh team

Team members inherit the repository role assigned to that team.

### Enforcement boundary

Kosh Access is enforced at the service boundary rather than only in the UI.

Current enforcement includes:

- repository list visibility
- repository browser APIs
- Work
- Change Reviews
- Automation
- Flow
- repository Platform APIs
- Git smart HTTP clone/fetch/push
- Git LFS read/write
- Kosh Pages
- Mesh repository visibility
- Mesh component/link mutations
- Pulse signals and incidents
- global platform administration

Git HTTP supports scoped Kosh personal access tokens. The internal `KOSH_GIT_TOKEN` remains a trusted service credential for Kosh-controlled workers and must not be distributed as a user credential.

### Legacy repository migration

Repositories created before Kosh Access may not yet have a namespace binding or explicit grants.

`KOSH_ACCESS_LEGACY_MODE` controls that migration:

- `deny` — no implicit access; production-safe default
- `authenticated` — authenticated Kosh users receive temporary maintainer compatibility access

Production defaults to `deny` when the variable is omitted. Development defaults to `authenticated` to avoid blocking local migration.

Recommended migration:

1. temporarily use `authenticated` only in a controlled migration environment if needed
2. open Kosh Access
3. bind each legacy namespace to the correct Workspace organization
4. assign explicit repository/team grants where needed
5. restore `KOSH_ACCESS_LEGACY_MODE=deny`

New repositories receive an explicit owner grant automatically and do not rely on legacy mode.

### Cross-system visibility

Flow remains repository-scoped.

Mesh includes only repositories visible to the current identity and only components inside those visible namespaces.

Pulse derives its signals and visible incidents from that caller-filtered Mesh graph.

This keeps Kosh lifecycle and impact intelligence inside the same authorization boundary as the underlying repositories.
