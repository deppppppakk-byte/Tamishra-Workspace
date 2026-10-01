export type NoteBlockMode = "rich-text" | "checklist";

export type TamishraNote = {
  id: string;
  title: string;
  html: string;
  plainText: string;
  notebook: string;
  tags: string[];
  pinned: boolean;
  archivedAt: string | null;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type NotesSnapshot = {
  version: 1;
  notes: TamishraNote[];
  notebooks: string[];
  deleted: Record<string, string>;
};

export const TMNOTE_EXTENSION = ".tmnt";
export const TMNOTE_MIME_TYPE = "application/vnd.tamishra.note";
export const TMNOTE_FORMAT_VERSION = 1;
export const TMNOTE_MAGIC = "TMNT\n";

type NativeEnvelope = {
  checksum: string;
  payload: {
    format: "Tamishra Note";
    version: number;
    exportedAt: string;
    note: TamishraNote;
  };
};

export function createNotesSnapshot(): NotesSnapshot {
  return {
    version: 1,
    notes: [],
    notebooks: ["Notes"],
    deleted: {}
  };
}

export function createNote(input?: Partial<Pick<TamishraNote, "title" | "html" | "notebook">>): TamishraNote {
  const now = new Date().toISOString();
  const html = input?.html ?? "<p><br></p>";
  return {
    id: createId("note"),
    title: input?.title?.trim() || "Untitled note",
    html,
    plainText: stripHtml(html),
    notebook: input?.notebook?.trim() || "Notes",
    tags: [],
    pinned: false,
    archivedAt: null,
    trashedAt: null,
    createdAt: now,
    updatedAt: now
  };
}

export function upsertNote(snapshot: NotesSnapshot, note: TamishraNote): NotesSnapshot {
  const notes = snapshot.notes.filter((item) => item.id !== note.id);
  return {
    ...snapshot,
    notebooks: Array.from(new Set([...snapshot.notebooks, note.notebook])).sort(),
    notes: [{ ...note, updatedAt: new Date().toISOString() }, ...notes]
  };
}

export function normalizeNotesSnapshot(value: unknown): NotesSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createNotesSnapshot();
  }

  const candidate = value as Partial<NotesSnapshot>;
  const notes = Array.isArray(candidate.notes)
    ? candidate.notes.filter((note): note is TamishraNote =>
        Boolean(
          note &&
          typeof note === "object" &&
          typeof note.id === "string" &&
          typeof note.title === "string" &&
          typeof note.html === "string" &&
          typeof note.updatedAt === "string"
        )
      )
    : [];

  const notebooks = Array.isArray(candidate.notebooks)
    ? candidate.notebooks.filter(
        (notebook): notebook is string =>
          typeof notebook === "string" && notebook.trim().length > 0
      )
    : [];

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

  return {
    version: 1,
    notes: notes.filter((note) => !(note.id in deleted)),
    notebooks: Array.from(
      new Set([
        "Notes",
        ...notebooks,
        ...notes.map((note) => note.notebook).filter(Boolean)
      ])
    ).sort(),
    deleted
  };
}

export function mergeNotesSnapshots(
  local: NotesSnapshot,
  remote: NotesSnapshot
): NotesSnapshot {
  const deleted: Record<string, string> = {
    ...remote.deleted,
    ...local.deleted
  };
  for (const [id, deletedAt] of Object.entries(remote.deleted)) {
    const localDeletedAt = deleted[id];
    if (!localDeletedAt || deletedAt.localeCompare(localDeletedAt) > 0) {
      deleted[id] = deletedAt;
    }
  }

  const byId = new Map<string, TamishraNote>();

  for (const note of [...remote.notes, ...local.notes]) {
    if (deleted[note.id]) continue;
    const current = byId.get(note.id);
    if (!current || note.updatedAt.localeCompare(current.updatedAt) >= 0) {
      byId.set(note.id, note);
    }
  }

  return {
    version: 1,
    notebooks: Array.from(
      new Set([
        "Notes",
        ...remote.notebooks,
        ...local.notebooks,
        ...Array.from(byId.values()).map((note) => note.notebook)
      ])
    ).sort(),
    notes: Array.from(byId.values()).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    ),
    deleted
  };
}

export function searchNotes(snapshot: NotesSnapshot, query: string) {
  const normalized = query.trim().toLowerCase();
  const active = snapshot.notes.filter((note) => !note.trashedAt);
  if (!normalized) return active;
  return active.filter((note) =>
    [note.title, note.plainText, note.notebook, ...note.tags]
      .join(" ")
      .toLowerCase()
      .includes(normalized)
  );
}

export function stripHtml(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

export function serializeTamishraNote(note: TamishraNote) {
  const payload: NativeEnvelope["payload"] = {
    format: "Tamishra Note",
    version: TMNOTE_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    note
  };
  const canonical = stableJson(payload);
  const envelope: NativeEnvelope = {
    checksum: fnv1a32(canonical),
    payload
  };
  return new TextEncoder().encode(TMNOTE_MAGIC + JSON.stringify(envelope));
}

export function parseTamishraNote(input: ArrayBuffer | Uint8Array) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.startsWith(TMNOTE_MAGIC)) {
    throw new Error("This is not a Tamishra .tmnt note.");
  }

  let envelope: NativeEnvelope;
  try {
    envelope = JSON.parse(text.slice(TMNOTE_MAGIC.length)) as NativeEnvelope;
  } catch {
    throw new Error("The Tamishra note is damaged or unreadable.");
  }

  if (
    envelope?.payload?.format !== "Tamishra Note" ||
    envelope.payload.version > TMNOTE_FORMAT_VERSION ||
    !envelope.payload.note?.id
  ) {
    throw new Error("Unsupported Tamishra note format.");
  }

  if (fnv1a32(stableJson(envelope.payload)) !== envelope.checksum) {
    throw new Error("The Tamishra note failed its integrity check.");
  }

  return envelope.payload.note;
}

export function tamishraNoteFilename(title: string) {
  const safe =
    title
      .trim()
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "note";
  return safe + TMNOTE_EXTENSION;
}

function createId(prefix: string) {
  const random =
    typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}_${random}`;
}

function fnv1a32(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}
