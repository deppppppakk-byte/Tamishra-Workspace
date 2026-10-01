export type TamishraBlockKind =
  | "rich-text"
  | "visual"
  | "table"
  | "chart"
  | "form"
  | "reference"
  | "custom";

export type TamishraBlockSourceApp =
  | "docs"
  | "sheets"
  | "slides"
  | "notes"
  | "forms"
  | "files"
  | "workspace";

export type TamishraBlock<TPayload = unknown> = {
  id: string;
  title: string;
  kind: TamishraBlockKind;
  sourceApp: TamishraBlockSourceApp;
  payload: TPayload;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type TamishraBlockShelf = {
  version: 1;
  blocks: TamishraBlock[];
  deleted: Record<string, string>;
};

export const TMBLOCK_EXTENSION = ".tmblk";
export const TMBLOCK_MIME_TYPE = "application/x-tamishra-block";
export const TMBLOCK_FORMAT_VERSION = 1;
export const TMBLOCK_MAGIC = "TMBL\n";

type NativeEnvelope = {
  checksum: string;
  payload: {
    format: "Tamishra Block";
    version: number;
    exportedAt: string;
    block: TamishraBlock;
  };
};

export function createBlockShelf(): TamishraBlockShelf {
  return { version: 1, blocks: [], deleted: {} };
}

export function createBlock<TPayload>(input: {
  title?: string;
  kind: TamishraBlockKind;
  sourceApp: TamishraBlockSourceApp;
  payload: TPayload;
  tags?: string[];
}): TamishraBlock<TPayload> {
  const now = new Date().toISOString();
  return {
    id: createId("block"),
    title: input.title?.trim() || "Untitled block",
    kind: input.kind,
    sourceApp: input.sourceApp,
    payload: input.payload,
    tags: uniqueStrings(input.tags ?? []),
    createdAt: now,
    updatedAt: now,
    version: 1
  };
}

export function normalizeBlockShelf(value: unknown): TamishraBlockShelf {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createBlockShelf();
  }

  const candidate = value as Partial<TamishraBlockShelf>;
  const deleted =
    candidate.deleted &&
    typeof candidate.deleted === "object" &&
    !Array.isArray(candidate.deleted)
      ? Object.fromEntries(
          Object.entries(candidate.deleted).filter(
            ([id, deletedAt]) => id.length > 0 && typeof deletedAt === "string"
          )
        )
      : {};

  const blocks = Array.isArray(candidate.blocks)
    ? candidate.blocks
        .filter(isTamishraBlock)
        .filter((block) => !(block.id in deleted))
    : [];

  return {
    version: 1,
    blocks: [...blocks].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    ),
    deleted
  };
}

export function upsertBlock(
  shelf: TamishraBlockShelf,
  block: TamishraBlock
): TamishraBlockShelf {
  const updatedAt = new Date().toISOString();
  const next = { ...block, updatedAt };
  const deleted = { ...shelf.deleted };
  delete deleted[block.id];

  return {
    version: 1,
    deleted,
    blocks: [next, ...shelf.blocks.filter((item) => item.id !== block.id)]
  };
}

export function deleteBlock(
  shelf: TamishraBlockShelf,
  id: string
): TamishraBlockShelf {
  const deletedAt = new Date().toISOString();
  return {
    version: 1,
    blocks: shelf.blocks.filter((item) => item.id !== id),
    deleted: { ...shelf.deleted, [id]: deletedAt }
  };
}

export function searchBlocks(
  shelf: TamishraBlockShelf,
  query: string,
  kinds?: TamishraBlockKind[]
) {
  const normalized = query.trim().toLowerCase();
  return shelf.blocks.filter((block) => {
    if (kinds?.length && !kinds.includes(block.kind)) return false;
    if (!normalized) return true;
    return [
      block.title,
      block.kind,
      block.sourceApp,
      ...block.tags
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalized);
  });
}

export function serializeTamishraBlock(block: TamishraBlock) {
  const payload: NativeEnvelope["payload"] = {
    format: "Tamishra Block",
    version: TMBLOCK_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    block
  };
  const canonical = stableJson(payload);
  const envelope: NativeEnvelope = {
    checksum: fnv1a32(canonical),
    payload
  };
  return new TextEncoder().encode(TMBLOCK_MAGIC + JSON.stringify(envelope));
}

export function parseTamishraBlock(input: ArrayBuffer | Uint8Array) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  if (!text.startsWith(TMBLOCK_MAGIC)) {
    throw new Error("This is not a Tamishra .tmblk block.");
  }

  let envelope: NativeEnvelope;
  try {
    envelope = JSON.parse(text.slice(TMBLOCK_MAGIC.length)) as NativeEnvelope;
  } catch {
    throw new Error("The Tamishra block is damaged or unreadable.");
  }

  if (
    envelope?.payload?.format !== "Tamishra Block" ||
    envelope.payload.version > TMBLOCK_FORMAT_VERSION ||
    !isTamishraBlock(envelope.payload.block)
  ) {
    throw new Error("Unsupported Tamishra block format.");
  }

  if (fnv1a32(stableJson(envelope.payload)) !== envelope.checksum) {
    throw new Error("The Tamishra block failed its integrity check.");
  }

  return envelope.payload.block;
}

export function tamishraBlockFilename(title: string) {
  const safe =
    title
      .trim()
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "block";
  return safe + TMBLOCK_EXTENSION;
}

function isTamishraBlock(value: unknown): value is TamishraBlock {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const block = value as Partial<TamishraBlock>;
  return Boolean(
    typeof block.id === "string" &&
    typeof block.title === "string" &&
    typeof block.kind === "string" &&
    typeof block.sourceApp === "string" &&
    Array.isArray(block.tags) &&
    typeof block.createdAt === "string" &&
    typeof block.updatedAt === "string" &&
    typeof block.version === "number" &&
    "payload" in block
  );
}

function uniqueStrings(values: string[]) {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean))
  );
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
