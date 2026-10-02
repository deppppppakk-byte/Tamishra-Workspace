export type KoshRepositoryVisibility = "private" | "internal" | "public";
export type KoshRepositoryState = "ready" | "provisioning" | "error";
export type KoshModuleStatus = "active" | "foundation" | "planned";

export type KoshRepository = {
  id: string;
  namespace: string;
  slug: string;
  name: string;
  description: string;
  visibility: KoshRepositoryVisibility;
  defaultBranch: string;
  state: KoshRepositoryState;
  cloneHttpUrl: string;
  cloneSshUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KoshModule = {
  id: string;
  name: string;
  description: string;
  status: KoshModuleStatus;
};

export const koshModules: KoshModule[] = [
  {
    id: "repositories",
    name: "Repositories",
    description: "Native Git repositories with standard clone, fetch and push over smart HTTP.",
    status: "active"
  },
  {
    id: "reviews",
    name: "Change Reviews",
    description: "Branches, diffs, merge requests, approvals and protected merge policies.",
    status: "active"
  },
  {
    id: "work",
    name: "Work",
    description: "Issues, discussions, milestones, boards and linked project planning.",
    status: "active"
  },
  {
    id: "automation",
    name: "Automation",
    description: "Event-driven pipelines with leased isolated runners, bounded resources, ephemeral checkout credentials and runner health.",
    status: "active"
  },
  {
    id: "flow",
    name: "Flow",
    description: "A live Kosh lifecycle graph connecting intent, change, proof, delivery and operation.",
    status: "active"
  },
  {
    id: "mesh",
    name: "Mesh",
    description: "A cross-repository and cross-asset system map with dependency and impact analysis.",
    status: "active"
  },
  {
    id: "pulse",
    name: "Pulse",
    description: "A live command layer for signals, blast radius, acknowledgements and incidents across Kosh.",
    status: "active"
  },
  {
    id: "packages",
    name: "Packages & Registry",
    description: "Immutable package versions, checksum-verified artifacts, channels, provenance and Automation publishing.",
    status: "active"
  },
  {
    id: "releases",
    name: "Releases",
    description: "Git-anchored release lifecycle with immutable package evidence, verified assets, protected tags and promotion channels.",
    status: "active"
  },
  {
    id: "security",
    name: "Security",
    description: "Repository secret scanning, dependency policy analysis, durable findings, SBOM, encrypted runtime secrets and Pulse signals.",
    status: "active"
  },
  {
    id: "ssh",
    name: "SSH Git",
    description: "OpenSSH transport with Kosh key identity, forced Git commands, repository ACL enforcement and audit.",
    status: "active"
  },
  {
    id: "organizations",
    name: "Organizations & Permissions",
    description: "Namespace ownership, teams, repository roles and enforced access across Kosh APIs, Git, LFS, Pages, Mesh and Pulse.",
    status: "active"
  },
  {
    id: "merge-queue",
    name: "Merge Queue",
    description: "Queue-entry control plane for validated serial or parallel merge processing.",
    status: "foundation"
  },
  {
    id: "search",
    name: "Code Search",
    description: "Real Git-native code, path and commit search against repository objects.",
    status: "active"
  },
  {
    id: "code-intelligence",
    name: "Code Intelligence",
    description: "Commit-aware symbol and reference indexing with definitions, ownership mapping, push-triggered delta refresh and language-aware navigation.",
    status: "active"
  },
  {
    id: "browser-ide",
    name: "Browser IDE",
    description: "Repository editing workspace foundation for multi-file edits, commits and previews.",
    status: "foundation"
  },
  {
    id: "dev-environments",
    name: "Development Environments",
    description: "Disposable environment definitions ready for isolated runner-backed execution.",
    status: "foundation"
  },
  {
    id: "wiki",
    name: "Wiki & Documentation",
    description: "Versionable repository knowledge pages stored as structured Kosh resources.",
    status: "foundation"
  },
  {
    id: "pages",
    name: "Pages & Static Hosting",
    description: "Static-site configuration and deployment policy resources for repository publishing.",
    status: "foundation"
  },
  {
    id: "webhooks",
    name: "Webhooks & Integrations",
    description: "Webhook and integration registrations with auditable configuration.",
    status: "foundation"
  },
  {
    id: "api-cli",
    name: "Public API & CLI",
    description: "Scoped personal API tokens with one-time token reveal and hashed-at-rest authentication.",
    status: "foundation"
  },
  {
    id: "notifications",
    name: "Notifications",
    description: "Repository notifications plus subscription resources for future cross-platform delivery.",
    status: "active"
  },
  {
    id: "advanced-projects",
    name: "Advanced Project Management",
    description: "Custom-field resources extending Kosh Work toward roadmaps, iterations and cross-repository planning.",
    status: "foundation"
  },
  {
    id: "release-management",
    name: "Release & Deployment Management",
    description: "Deployment-policy resources extending Automation environments and deployment history.",
    status: "foundation"
  },
  {
    id: "storage",
    name: "Storage Layer",
    description: "Storage-policy resources for Git LFS, artifacts, quotas, lifecycle and adapter selection.",
    status: "foundation"
  },
  {
    id: "disaster-recovery",
    name: "Disaster Recovery",
    description: "Backup and restore-point resources with auditable lifecycle state.",
    status: "foundation"
  },
  {
    id: "observability",
    name: "Observability",
    description: "Platform summary, resource counts and audit telemetry across Kosh control-plane services.",
    status: "foundation"
  },
  {
    id: "administration",
    name: "Administration",
    description: "Global settings and policy resources for platform administrators.",
    status: "foundation"
  },
  {
    id: "extensions",
    name: "Extension SDK",
    description: "Generic extension registrations for code, CAD/BIM, documents, datasets and future assets.",
    status: "foundation"
  }
]

export function normalizeKoshSlug(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function isValidKoshNamespace(input: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input);
}
