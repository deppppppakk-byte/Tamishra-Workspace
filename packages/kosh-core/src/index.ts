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
    description: "Validated merge sequencing with queue priorities, pause/resume/cancel controls, required-check gating and audited processing.",
    status: "active"
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
    description: "Guarded branch editing workspace with file change sets, diff preview, expected-head concurrency protection and lifecycle integration.",
    status: "active"
  },
  {
    id: "dev-environments",
    name: "Development Environments",
    description: "Disposable exact-commit workspaces with atomic runner leases, bounded container isolation, lifecycle heartbeats and TTL expiry.",
    status: "active"
  },
  {
    id: "wiki",
    name: "Wiki & Documentation",
    description: "Versioned repository knowledge with Markdown editing, search, revision history, backlinks and repository access control.",
    status: "active"
  },
  {
    id: "pages",
    name: "Pages & Static Hosting",
    description: "Commit-pinned static publishing with validated source trees, deployment history, rollback, SPA fallback and repository access control.",
    status: "active"
  },
  {
    id: "webhooks",
    name: "Webhooks & Integrations",
    description: "Signed outbound events with encrypted endpoint secrets, public-network validation, retries, durable delivery history and redelivery controls.",
    status: "active"
  },
  {
    id: "api-cli",
    name: "Public API & CLI",
    description: "Stable API discovery, scoped hashed-at-rest tokens, lifecycle controls, OpenAPI metadata and a native authenticated Kosh command-line client.",
    status: "active"
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
    description: "Repository roadmaps with projects, iterations, custom fields and issue/change-request-linked planning items.",
    status: "active"
  },
  {
    id: "release-management",
    name: "Release & Deployment Management",
    description: "Release-linked deployment requests with environment policies, approvals, promotion, rollback and Automation execution records.",
    status: "active"
  },
  {
    id: "storage",
    name: "Storage Layer",
    description: "Repository storage policy, quota accounting, lifecycle controls and provider-neutral storage-root boundaries.",
    status: "active"
  },
  {
    id: "disaster-recovery",
    name: "Disaster Recovery",
    description: "Checksum-verified Git restore points with retention, staged fsck validation, explicit activation and automatic pre-restore safety backup.",
    status: "active"
  },
  {
    id: "observability",
    name: "Observability",
    description: "Repository and platform health views over automation state, deployments, storage, resource state and audit telemetry.",
    status: "active"
  },
  {
    id: "administration",
    name: "Administration",
    description: "Audited global policy settings plus runtime posture for storage, recovery, extensions, access and runner controls.",
    status: "active"
  },
  {
    id: "extensions",
    name: "Extension SDK",
    description: "Versioned declarative extension manifests with validated capabilities, permissions, asset kinds and controlled activation.",
    status: "active"
  }
];

export const koshExtensionCapabilities = [
  "asset-preview",
  "automation-step",
  "code-intelligence",
  "deployment-gate",
  "project-panel",
  "storage-adapter",
  "webhook-transform"
] as const;

export const koshExtensionPermissions = [
  "network.egress",
  "repository.manage",
  "repository.read",
  "repository.write",
  "storage.read",
  "storage.write"
] as const;

export type KoshExtensionCapability = typeof koshExtensionCapabilities[number];
export type KoshExtensionPermission = typeof koshExtensionPermissions[number];

export type KoshExtensionManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  runtime: "declarative";
  entrypoint: string | null;
  capabilities: KoshExtensionCapability[];
  permissions: KoshExtensionPermission[];
  assetKinds: string[];
  homepage: string | null;
};

export function validateKoshExtensionManifest(value: unknown): KoshExtensionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("extension_manifest_required");
  }
  const input = value as Record<string, unknown>;
  const id = String(input.id ?? "").trim().toLowerCase().slice(0, 100);
  const name = String(input.name ?? "").trim().slice(0, 160);
  const version = String(input.version ?? "").trim().slice(0, 80);
  if (!/^[a-z][a-z0-9._-]{1,99}$/.test(id) || !name) {
    throw new Error("invalid_extension_identity");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
    throw new Error("invalid_extension_version");
  }
  const capabilitySet = new Set<string>(koshExtensionCapabilities);
  const permissionSet = new Set<string>(koshExtensionPermissions);
  const capabilities = Array.isArray(input.capabilities)
    ? [...new Set(input.capabilities.map(String))]
        .filter((item): item is KoshExtensionCapability => capabilitySet.has(item))
        .slice(0, 32)
    : [];
  const permissions = Array.isArray(input.permissions)
    ? [...new Set(input.permissions.map(String))]
        .filter((item): item is KoshExtensionPermission => permissionSet.has(item))
        .slice(0, 32)
    : [];
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    description: String(input.description ?? "").trim().slice(0, 1000),
    runtime: "declarative",
    entrypoint: input.entrypoint ? String(input.entrypoint).trim().slice(0, 240) : null,
    capabilities,
    permissions,
    assetKinds: Array.isArray(input.assetKinds)
      ? [...new Set(input.assetKinds.map((item) => String(item).trim()).filter(Boolean))].slice(0, 64)
      : [],
    homepage: input.homepage ? String(input.homepage).trim().slice(0, 500) : null
  };
}

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