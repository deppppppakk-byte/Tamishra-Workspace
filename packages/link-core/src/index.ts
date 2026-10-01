export type WorkspaceLinkApp =
  | "docs"
  | "sheets"
  | "slides"
  | "notes"
  | "forms"
  | "blocks"
  | "files"
  | "workspace";

export type WorkspaceLinkEdge = {
  id: string;
  blockId: string;
  sourceApp: WorkspaceLinkApp;
  sourceResourceId: string;
  sourceLocator?: string;
  sourceTitle?: string;
  targetApp: WorkspaceLinkApp;
  targetResourceId: string;
  targetLocator?: string;
  targetTitle?: string;
  targetHref: string;
  blockVersion: number;
  createdAt: string;
  updatedAt: string;
  lastSyncedAt: string;
};

export type WorkspaceLinkIndex = {
  version: 1;
  edges: WorkspaceLinkEdge[];
  deleted: Record<string, string>;
};

export type WorkspaceLinkInput = Omit<
  WorkspaceLinkEdge,
  "id" | "createdAt" | "updatedAt"
> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

export function emptyWorkspaceLinkIndex(): WorkspaceLinkIndex {
  return { version: 1, edges: [], deleted: {} };
}

export function workspaceLinkId(input: {
  blockId: string;
  targetApp: WorkspaceLinkApp;
  targetResourceId: string;
  targetLocator?: string;
}) {
  return [
    "link",
    input.blockId,
    input.targetApp,
    input.targetResourceId,
    input.targetLocator ?? ""
  ]
    .map((value) => encodeURIComponent(value))
    .join(":");
}

export function normalizeWorkspaceLinkIndex(
  value: unknown
): WorkspaceLinkIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return emptyWorkspaceLinkIndex();
  }

  const candidate = value as Partial<WorkspaceLinkIndex>;
  const deleted =
    candidate.deleted &&
    typeof candidate.deleted === "object" &&
    !Array.isArray(candidate.deleted)
      ? Object.fromEntries(
          Object.entries(candidate.deleted).filter(
            ([id, deletedAt]) =>
              id.length > 0 && typeof deletedAt === "string"
          )
        )
      : {};

  const edges = Array.isArray(candidate.edges)
    ? candidate.edges
        .filter(isWorkspaceLinkEdge)
        .filter((edge) => !(edge.id in deleted))
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt)
        )
    : [];

  return { version: 1, edges, deleted };
}

export function upsertWorkspaceLink(
  index: WorkspaceLinkIndex,
  input: WorkspaceLinkInput
): WorkspaceLinkIndex {
  const now = new Date().toISOString();
  const id =
    input.id ??
    workspaceLinkId({
      blockId: input.blockId,
      targetApp: input.targetApp,
      targetResourceId: input.targetResourceId,
      targetLocator: input.targetLocator
    });
  const existing = index.edges.find((edge) => edge.id === id);
  const deleted = { ...index.deleted };
  delete deleted[id];

  const edge: WorkspaceLinkEdge = {
    ...input,
    id,
    createdAt: input.createdAt ?? existing?.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    lastSyncedAt: input.lastSyncedAt || now
  };

  return {
    version: 1,
    deleted,
    edges: [
      edge,
      ...index.edges.filter((item) => item.id !== id)
    ]
  };
}

export function removeWorkspaceLink(
  index: WorkspaceLinkIndex,
  id: string
): WorkspaceLinkIndex {
  const now = new Date().toISOString();
  return {
    version: 1,
    edges: index.edges.filter((edge) => edge.id !== id),
    deleted: { ...index.deleted, [id]: now }
  };
}

export function removeWorkspaceConsumerLinks(
  index: WorkspaceLinkIndex,
  filter: {
    blockId?: string;
    targetApp?: WorkspaceLinkApp;
    targetResourceId?: string;
    targetLocator?: string;
  }
): WorkspaceLinkIndex {
  const ids = index.edges
    .filter(
      (edge) =>
        (filter.blockId === undefined || edge.blockId === filter.blockId) &&
        (filter.targetApp === undefined || edge.targetApp === filter.targetApp) &&
        (filter.targetResourceId === undefined ||
          edge.targetResourceId === filter.targetResourceId) &&
        (filter.targetLocator === undefined ||
          edge.targetLocator === filter.targetLocator)
    )
    .map((edge) => edge.id);

  if (!ids.length) return index;

  const now = new Date().toISOString();
  return {
    version: 1,
    edges: index.edges.filter((edge) => !ids.includes(edge.id)),
    deleted: {
      ...index.deleted,
      ...Object.fromEntries(ids.map((id) => [id, now]))
    }
  };
}

export function linksForBlock(
  index: WorkspaceLinkIndex,
  blockId: string
) {
  return index.edges.filter((edge) => edge.blockId === blockId);
}

function isWorkspaceLinkEdge(value: unknown): value is WorkspaceLinkEdge {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edge = value as Partial<WorkspaceLinkEdge>;
  return Boolean(
    typeof edge.id === "string" &&
    typeof edge.blockId === "string" &&
    typeof edge.sourceApp === "string" &&
    typeof edge.sourceResourceId === "string" &&
    typeof edge.targetApp === "string" &&
    typeof edge.targetResourceId === "string" &&
    typeof edge.targetHref === "string" &&
    typeof edge.blockVersion === "number" &&
    typeof edge.createdAt === "string" &&
    typeof edge.updatedAt === "string" &&
    typeof edge.lastSyncedAt === "string"
  );
}
