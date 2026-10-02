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
    status: "foundation"
  },
  {
    id: "work",
    name: "Work",
    description: "Issues, discussions, milestones, boards and linked project planning.",
    status: "foundation"
  },
  {
    id: "automation",
    name: "Automation",
    description: "Event-driven pipelines for build, test, validation, release and deployment.",
    status: "planned"
  },
  {
    id: "packages",
    name: "Packages",
    description: "Package and container registries with immutable versions and provenance.",
    status: "planned"
  },
  {
    id: "releases",
    name: "Releases",
    description: "Release assets, notes, signing, artifacts and deployment promotion.",
    status: "planned"
  },
  {
    id: "security",
    name: "Security",
    description: "Secrets, dependency review, code scanning, audit trails and policy enforcement.",
    status: "planned"
  },
  {
    id: "extensions",
    name: "Extensions",
    description: "Generic extension SDK for code, CAD/BIM, documents, datasets and future assets.",
    status: "planned"
  }
];

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
