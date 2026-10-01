import type {
  DocsComment,
  DocsLibraryRecord,
  DocsShareGrant,
  DocsSuggestion,
  DocsVersion
} from "./workspace";

export const TMDOC_EXTENSION = ".tmdoc";
export const TMDOC_MIME_TYPE = "application/vnd.tamishra.document";
export const TMDOC_FORMAT_VERSION = 1;
export const TMDOC_MAGIC = "TMDOC\n";

export type TamishraDocumentManifest = {
  format: "Tamishra Document";
  extension: ".tmdoc";
  mimeType: typeof TMDOC_MIME_TYPE;
  formatVersion: typeof TMDOC_FORMAT_VERSION;
  producer: "Tamishra Docs";
  createdAt: string;
  exportedAt: string;
  documentId: string;
  title: string;
};

export type TamishraDocumentPackage = {
  manifest: TamishraDocumentManifest;
  record: DocsLibraryRecord;
  comments: DocsComment[];
  suggestions: DocsSuggestion[];
  versions: DocsVersion[];
  grants: DocsShareGrant[];
};

type TamishraDocumentEnvelope = {
  checksum: string;
  payload: TamishraDocumentPackage;
};

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

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);

  return `{${entries.join(",")}}`;
}

export function createTamishraDocumentPackage(input: {
  record: DocsLibraryRecord;
  comments?: DocsComment[];
  suggestions?: DocsSuggestion[];
  versions?: DocsVersion[];
  grants?: DocsShareGrant[];
}): TamishraDocumentPackage {
  const now = new Date().toISOString();

  return {
    manifest: {
      format: "Tamishra Document",
      extension: TMDOC_EXTENSION,
      mimeType: TMDOC_MIME_TYPE,
      formatVersion: TMDOC_FORMAT_VERSION,
      producer: "Tamishra Docs",
      createdAt: input.record.createdAt || now,
      exportedAt: now,
      documentId: input.record.id,
      title: input.record.title
    },
    record: structuredClone(input.record),
    comments: structuredClone(input.comments ?? []),
    suggestions: structuredClone(input.suggestions ?? []),
    versions: structuredClone(input.versions ?? []),
    grants: structuredClone(input.grants ?? [])
  };
}

export function serializeTamishraDocument(
  packageData: TamishraDocumentPackage
): Uint8Array {
  const canonicalPayload = stableJson(packageData);
  const envelope: TamishraDocumentEnvelope = {
    checksum: fnv1a32(canonicalPayload),
    payload: packageData
  };

  return new TextEncoder().encode(
    TMDOC_MAGIC + JSON.stringify(envelope)
  );
}

export function parseTamishraDocument(
  input: ArrayBuffer | Uint8Array
): TamishraDocumentPackage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  if (!text.startsWith(TMDOC_MAGIC)) {
    throw new Error("This is not a Tamishra .tmdoc file.");
  }

  let envelope: TamishraDocumentEnvelope;

  try {
    envelope = JSON.parse(text.slice(TMDOC_MAGIC.length)) as TamishraDocumentEnvelope;
  } catch {
    throw new Error("The Tamishra document package is damaged or unreadable.");
  }

  const payload = envelope?.payload;
  const manifest = payload?.manifest;

  if (!payload || !manifest) {
    throw new Error("The Tamishra document manifest is missing.");
  }

  if (manifest.format !== "Tamishra Document" || manifest.extension !== TMDOC_EXTENSION) {
    throw new Error("Unsupported Tamishra document format.");
  }

  if (manifest.formatVersion > TMDOC_FORMAT_VERSION) {
    throw new Error(
      `This .tmdoc file uses format version ${manifest.formatVersion}, but this Tamishra Docs build supports up to version ${TMDOC_FORMAT_VERSION}.`
    );
  }

  if (manifest.formatVersion < 1) {
    throw new Error("Invalid Tamishra document format version.");
  }

  if (!payload.record?.draft?.document) {
    throw new Error("The Tamishra document payload is incomplete.");
  }

  const checksum = fnv1a32(stableJson(payload));
  if (checksum !== envelope.checksum) {
    throw new Error("The Tamishra document failed its integrity check.");
  }

  return payload;
}

export function tamishraDocumentFilename(title: string) {
  const safe =
    title
      .trim()
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "document";

  return safe + TMDOC_EXTENSION;
}
