import type { PersistedDocsDraft } from "./index";

export type DocsAccessRole = "owner" | "editor" | "commenter" | "viewer";
export type DocsEditingMode = "editing" | "reviewing" | "viewing";

export type DocsLibraryRecord = {
  id: string;
  title: string;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string;
  trashedAt: string | null;
  starred: boolean;
  draft: PersistedDocsDraft;
};

export type DocsFolder = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
};

export type DocsVersion = {
  id: string;
  documentId: string;
  createdAt: string;
  authorId: string;
  authorName: string;
  label: string | null;
  reason: "autosave" | "manual-save" | "restore" | "import";
  draft: PersistedDocsDraft;
};

export type DocsShareGrant = {
  id: string;
  documentId: string;
  principal: string;
  role: Exclude<DocsAccessRole, "owner">;
  createdAt: string;
};

export type DocsCommentReply = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type DocsComment = {
  id: string;
  documentId: string;
  blockId: string | null;
  quotedText: string;
  body: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  resolvedAt: string | null;
  replies: DocsCommentReply[];
};

export type DocsSuggestion = {
  id: string;
  documentId: string;
  kind: "insert" | "delete" | "format";
  blockId: string | null;
  beforeText: string;
  afterText: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  status: "pending" | "accepted" | "rejected";
};

export type DocsOutlineEntry = {
  id: string;
  level: 1 | 2 | 3 | 4;
  text: string;
  blockId: string;
};

export type DocsProofingStats = {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  paragraphs: number;
  headings: number;
  sentences: number;
  estimatedReadingMinutes: number;
};

export type DocsWorkspaceSnapshot = {
  records: DocsLibraryRecord[];
  folders: DocsFolder[];
  versions: DocsVersion[];
  grants: DocsShareGrant[];
  comments: DocsComment[];
  suggestions: DocsSuggestion[];
};

const STORAGE_KEY = "tamishra.docs.workspace.v1";

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function id(prefix: string) {
  const random =
    typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${random}`;
}

function emptySnapshot(): DocsWorkspaceSnapshot {
  return {
    records: [],
    folders: [],
    versions: [],
    grants: [],
    comments: [],
    suggestions: []
  };
}

export function loadDocsWorkspace(): DocsWorkspaceSnapshot {
  if (typeof localStorage === "undefined") return emptySnapshot();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptySnapshot();
    const parsed = JSON.parse(raw) as Partial<DocsWorkspaceSnapshot>;

    return {
      records: parsed.records ?? [],
      folders: parsed.folders ?? [],
      versions: parsed.versions ?? [],
      grants: parsed.grants ?? [],
      comments: parsed.comments ?? [],
      suggestions: parsed.suggestions ?? []
    };
  } catch {
    return emptySnapshot();
  }
}

export function saveDocsWorkspace(snapshot: DocsWorkspaceSnapshot) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

export function upsertDocsRecord(
  snapshot: DocsWorkspaceSnapshot,
  input: {
    id?: string;
    title: string;
    draft: PersistedDocsDraft;
    folderId?: string | null;
    starred?: boolean;
  }
): { snapshot: DocsWorkspaceSnapshot; record: DocsLibraryRecord } {
  const now = new Date().toISOString();
  const next = clone(snapshot);
  const existingIndex = input.id
    ? next.records.findIndex((item) => item.id === input.id)
    : -1;

  if (existingIndex >= 0) {
    const existing = next.records[existingIndex];
    const record: DocsLibraryRecord = {
      ...existing,
      title: input.title,
      draft: clone(input.draft),
      folderId: input.folderId ?? existing.folderId,
      starred: input.starred ?? existing.starred,
      updatedAt: now,
      lastOpenedAt: now,
      trashedAt: null
    };
    next.records[existingIndex] = record;
    return { snapshot: next, record };
  }

  const record: DocsLibraryRecord = {
    id: input.id ?? id("doc"),
    title: input.title,
    folderId: input.folderId ?? null,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    trashedAt: null,
    starred: input.starred ?? false,
    draft: clone(input.draft)
  };
  next.records.unshift(record);
  return { snapshot: next, record };
}

export function duplicateDocsRecord(
  snapshot: DocsWorkspaceSnapshot,
  documentId: string
): { snapshot: DocsWorkspaceSnapshot; record: DocsLibraryRecord | null } {
  const source = snapshot.records.find((item) => item.id === documentId);
  if (!source) return { snapshot, record: null };

  return upsertDocsRecord(snapshot, {
    title: `${source.title} copy`,
    draft: source.draft,
    folderId: source.folderId
  });
}

export function trashDocsRecord(snapshot: DocsWorkspaceSnapshot, documentId: string) {
  const next = clone(snapshot);
  const record = next.records.find((item) => item.id === documentId);
  if (record) {
    record.trashedAt = new Date().toISOString();
    record.updatedAt = record.trashedAt;
  }
  return next;
}

export function restoreDocsRecord(snapshot: DocsWorkspaceSnapshot, documentId: string) {
  const next = clone(snapshot);
  const record = next.records.find((item) => item.id === documentId);
  if (record) {
    record.trashedAt = null;
    record.updatedAt = new Date().toISOString();
  }
  return next;
}

export function permanentlyDeleteDocsRecord(
  snapshot: DocsWorkspaceSnapshot,
  documentId: string
) {
  const next = clone(snapshot);
  next.records = next.records.filter((item) => item.id !== documentId);
  next.versions = next.versions.filter((item) => item.documentId !== documentId);
  next.grants = next.grants.filter((item) => item.documentId !== documentId);
  next.comments = next.comments.filter((item) => item.documentId !== documentId);
  next.suggestions = next.suggestions.filter((item) => item.documentId !== documentId);
  return next;
}

export function addDocsVersion(
  snapshot: DocsWorkspaceSnapshot,
  input: Omit<DocsVersion, "id" | "createdAt">
): { snapshot: DocsWorkspaceSnapshot; version: DocsVersion } {
  const next = clone(snapshot);
  const version: DocsVersion = {
    ...clone(input),
    id: id("version"),
    createdAt: new Date().toISOString()
  };
  next.versions.unshift(version);
  next.versions = next.versions.slice(0, 100);
  return { snapshot: next, version };
}

export function addDocsShareGrant(
  snapshot: DocsWorkspaceSnapshot,
  input: Omit<DocsShareGrant, "id" | "createdAt">
) {
  const next = clone(snapshot);
  const existing = next.grants.find(
    (item) =>
      item.documentId === input.documentId &&
      item.principal.toLowerCase() === input.principal.toLowerCase()
  );
  if (existing) {
    existing.role = input.role;
    return next;
  }

  next.grants.push({
    ...input,
    id: id("grant"),
    createdAt: new Date().toISOString()
  });
  return next;
}

export function removeDocsShareGrant(snapshot: DocsWorkspaceSnapshot, grantId: string) {
  const next = clone(snapshot);
  next.grants = next.grants.filter((item) => item.id !== grantId);
  return next;
}

export function addDocsComment(
  snapshot: DocsWorkspaceSnapshot,
  input: Omit<DocsComment, "id" | "createdAt" | "resolvedAt" | "replies">
) {
  const next = clone(snapshot);
  const comment: DocsComment = {
    ...input,
    id: id("comment"),
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    replies: []
  };
  next.comments.unshift(comment);
  return { snapshot: next, comment };
}

export function updateDocsComment(
  snapshot: DocsWorkspaceSnapshot,
  commentId: string,
  updater: (comment: DocsComment) => void
) {
  const next = clone(snapshot);
  const comment = next.comments.find((item) => item.id === commentId);
  if (comment) updater(comment);
  return next;
}

export function extractDocsOutline(root: ParentNode): DocsOutlineEntry[] {
  return Array.from(root.querySelectorAll("h1, h2, h3, h4"))
    .map((element) => {
      const html = element as HTMLElement;
      const level = Number(html.tagName.slice(1)) as 1 | 2 | 3 | 4;
      if (!html.dataset.tamishraId) html.dataset.tamishraId = id("heading");

      return {
        id: id("outline"),
        level,
        text: html.innerText.trim() || "Untitled heading",
        blockId: html.dataset.tamishraId
      };
    });
}

export function calculateDocsProofingStats(text: string, root?: ParentNode): DocsProofingStats {
  const normalized = text.replace(/\s+/g, " ").trim();
  const words = normalized ? normalized.split(" ").length : 0;
  const sentences = normalized
    ? Math.max(1, (normalized.match(/[.!?]+(?:\s|$)/g) ?? []).length)
    : 0;

  return {
    words,
    characters: text.length,
    charactersNoSpaces: text.replace(/\s/g, "").length,
    paragraphs: root ? root.querySelectorAll("p, li, blockquote").length : 0,
    headings: root ? root.querySelectorAll("h1, h2, h3, h4").length : 0,
    sentences,
    estimatedReadingMinutes: words ? Math.max(1, Math.ceil(words / 220)) : 0
  };
}

export interface DocsCloudGateway {
  listDocuments(): Promise<DocsLibraryRecord[]>;
  getDocument(id: string): Promise<DocsLibraryRecord | null>;
  saveDocument(record: DocsLibraryRecord): Promise<DocsLibraryRecord>;
  deleteDocument(id: string): Promise<void>;
  listVersions(documentId: string): Promise<DocsVersion[]>;
  saveVersion(version: DocsVersion): Promise<DocsVersion>;
  listComments(documentId: string): Promise<DocsComment[]>;
  saveComment(comment: DocsComment): Promise<DocsComment>;
  listShareGrants(documentId: string): Promise<DocsShareGrant[]>;
  saveShareGrant(grant: DocsShareGrant): Promise<DocsShareGrant>;
}

export function addDocsSuggestion(
  snapshot: DocsWorkspaceSnapshot,
  input: Omit<DocsSuggestion, "id" | "createdAt" | "status">
) {
  const next = clone(snapshot);
  const suggestion: DocsSuggestion = {
    ...input,
    id: id("suggestion"),
    createdAt: new Date().toISOString(),
    status: "pending"
  };
  next.suggestions.unshift(suggestion);
  return { snapshot: next, suggestion };
}

export function updateDocsSuggestion(
  snapshot: DocsWorkspaceSnapshot,
  suggestionId: string,
  status: "accepted" | "rejected"
) {
  const next = clone(snapshot);
  const suggestion = next.suggestions.find((item) => item.id === suggestionId);
  if (suggestion) suggestion.status = status;
  return next;
}

export function createDocsFolder(
  snapshot: DocsWorkspaceSnapshot,
  name: string
): { snapshot: DocsWorkspaceSnapshot; folder: DocsFolder } {
  const next = clone(snapshot);
  const now = new Date().toISOString();
  const folder: DocsFolder = {
    id: id("folder"),
    name: name.trim() || "New folder",
    createdAt: now,
    updatedAt: now,
    trashedAt: null
  };
  next.folders.push(folder);
  return { snapshot: next, folder };
}

export function renameDocsFolder(
  snapshot: DocsWorkspaceSnapshot,
  folderId: string,
  name: string
) {
  const next = clone(snapshot);
  const folder = next.folders.find((item) => item.id === folderId);
  if (folder) {
    folder.name = name.trim() || folder.name;
    folder.updatedAt = new Date().toISOString();
  }
  return next;
}

export function moveDocsRecordToFolder(
  snapshot: DocsWorkspaceSnapshot,
  documentId: string,
  folderId: string | null
) {
  const next = clone(snapshot);
  const record = next.records.find((item) => item.id === documentId);
  if (record) {
    record.folderId = folderId;
    record.updatedAt = new Date().toISOString();
  }
  return next;
}

export function deleteDocsFolder(
  snapshot: DocsWorkspaceSnapshot,
  folderId: string
) {
  const next = clone(snapshot);
  next.folders = next.folders.filter((item) => item.id !== folderId);
  next.records = next.records.map((item) =>
    item.folderId === folderId ? { ...item, folderId: null } : item
  );
  return next;
}

function newestById<T extends { id: string }>(
  left: T[],
  right: T[],
  timestamp: (item: T) => string
) {
  const map = new Map<string, T>();
  [...left, ...right].forEach((item) => {
    const existing = map.get(item.id);
    if (!existing || timestamp(item) >= timestamp(existing)) {
      map.set(item.id, clone(item));
    }
  });
  return Array.from(map.values());
}

export function mergeDocsWorkspaces(
  local: DocsWorkspaceSnapshot,
  remote: DocsWorkspaceSnapshot
): DocsWorkspaceSnapshot {
  return {
    records: newestById(local.records, remote.records, (item) => item.updatedAt),
    folders: newestById(local.folders, remote.folders, (item) => item.updatedAt),
    versions: newestById(local.versions, remote.versions, (item) => item.createdAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100),
    grants: newestById(local.grants, remote.grants, (item) => item.createdAt),
    comments: newestById(local.comments, remote.comments, (item) =>
      item.resolvedAt ?? item.createdAt
    ),
    suggestions: newestById(local.suggestions, remote.suggestions, (item) => item.createdAt)
  };
}
