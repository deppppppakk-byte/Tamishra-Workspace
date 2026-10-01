export type WorkspaceFileKind =
  | "docs"
  | "sheets"
  | "slides"
  | "pdf"
  | "notes"
  | "forms"
  | "other";

export type WorkspaceFileRecord = {
  id: string;
  title: string;
  kind: WorkspaceFileKind;
  appHref: string;
  nativeExtension?: string;
  nativeMime?: string;
  sourceId?: string;
  sizeBytes?: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  favorite: boolean;
  trashedAt: string | null;
  storage: "local" | "cloud" | "external";
};

export type WorkspaceFileIndex = {
  version: 1;
  records: WorkspaceFileRecord[];
};

export const emptyWorkspaceFileIndex = (): WorkspaceFileIndex => ({
  version: 1,
  records: []
});

export function createWorkspaceFileId(prefix = "file") {
  const random =
    typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${random}`;
}

export function upsertWorkspaceFile(
  index: WorkspaceFileIndex,
  input: Omit<WorkspaceFileRecord, "createdAt" | "updatedAt" | "lastOpenedAt" | "favorite" | "trashedAt"> &
    Partial<Pick<WorkspaceFileRecord, "createdAt" | "updatedAt" | "lastOpenedAt" | "favorite" | "trashedAt">>
): WorkspaceFileIndex {
  const now = new Date().toISOString();
  const records = [...index.records];
  const existing = records.findIndex((item) => item.id === input.id);

  const next: WorkspaceFileRecord = {
    ...input,
    createdAt: input.createdAt ?? (existing >= 0 ? records[existing].createdAt : now),
    updatedAt: input.updatedAt ?? now,
    lastOpenedAt: input.lastOpenedAt ?? now,
    favorite: input.favorite ?? (existing >= 0 ? records[existing].favorite : false),
    trashedAt: input.trashedAt ?? null
  };

  if (existing >= 0) records[existing] = next;
  else records.unshift(next);

  return { version: 1, records };
}

export function touchWorkspaceFile(index: WorkspaceFileIndex, id: string) {
  const now = new Date().toISOString();
  return {
    ...index,
    records: index.records.map((item) =>
      item.id === id ? { ...item, lastOpenedAt: now } : item
    )
  };
}

export function toggleWorkspaceFileFavorite(index: WorkspaceFileIndex, id: string) {
  return {
    ...index,
    records: index.records.map((item) =>
      item.id === id ? { ...item, favorite: !item.favorite } : item
    )
  };
}

export function trashWorkspaceFile(index: WorkspaceFileIndex, id: string) {
  const now = new Date().toISOString();
  return {
    ...index,
    records: index.records.map((item) =>
      item.id === id ? { ...item, trashedAt: now, updatedAt: now } : item
    )
  };
}

export function restoreWorkspaceFile(index: WorkspaceFileIndex, id: string) {
  const now = new Date().toISOString();
  return {
    ...index,
    records: index.records.map((item) =>
      item.id === id ? { ...item, trashedAt: null, updatedAt: now } : item
    )
  };
}

export function permanentlyDeleteWorkspaceFile(index: WorkspaceFileIndex, id: string) {
  return {
    ...index,
    records: index.records.filter((item) => item.id !== id)
  };
}

export function searchWorkspaceFiles(index: WorkspaceFileIndex, query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return index.records;
  return index.records.filter((item) =>
    [item.title, item.kind, item.nativeExtension ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(normalized)
  );
}


export function mergeWorkspaceFileIndexes(
  local: WorkspaceFileIndex,
  remote: WorkspaceFileIndex
): WorkspaceFileIndex {
  const byId = new Map<string, WorkspaceFileRecord>();

  for (const item of [...local.records, ...remote.records]) {
    const current = byId.get(item.id);
    if (!current) {
      byId.set(item.id, { ...item });
      continue;
    }

    const currentStamp = Math.max(
      Date.parse(current.updatedAt) || 0,
      Date.parse(current.lastOpenedAt) || 0,
      Date.parse(current.trashedAt ?? "") || 0
    );
    const itemStamp = Math.max(
      Date.parse(item.updatedAt) || 0,
      Date.parse(item.lastOpenedAt) || 0,
      Date.parse(item.trashedAt ?? "") || 0
    );

    if (itemStamp >= currentStamp) {
      byId.set(item.id, { ...item });
    }
  }

  return {
    version: 1,
    records: Array.from(byId.values()).sort((a, b) =>
      b.lastOpenedAt.localeCompare(a.lastOpenedAt)
    )
  };
}
