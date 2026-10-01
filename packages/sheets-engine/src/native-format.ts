import {
  normalizeWorkbook,
  type Workbook
} from "./index";

export const TMSHEET_EXTENSION = ".tmsheet";
export const TMSHEET_MIME_TYPE = "application/vnd.tamishra.spreadsheet";
export const TMSHEET_FORMAT_VERSION = 1;
export const TMSHEET_MAGIC = "TMSHEET\n";

export type TamishraSheetManifest = {
  format: "Tamishra Sheet";
  extension: ".tmsheet";
  mimeType: typeof TMSHEET_MIME_TYPE;
  formatVersion: typeof TMSHEET_FORMAT_VERSION;
  producer: "Tamishra Sheets";
  workbookId: string;
  title: string;
  createdAt: string;
  exportedAt: string;
};

export type TamishraSheetPackage = {
  manifest: TamishraSheetManifest;
  workbook: Workbook;
};

type TamishraSheetEnvelope = {
  checksum: string;
  payload: TamishraSheetPackage;
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

export function createTamishraSheetPackage(
  workbook: Workbook
): TamishraSheetPackage {
  const now = new Date().toISOString();

  return {
    manifest: {
      format: "Tamishra Sheet",
      extension: TMSHEET_EXTENSION,
      mimeType: TMSHEET_MIME_TYPE,
      formatVersion: TMSHEET_FORMAT_VERSION,
      producer: "Tamishra Sheets",
      workbookId: workbook.id,
      title: workbook.title,
      createdAt: workbook.updatedAt || now,
      exportedAt: now
    },
    workbook: JSON.parse(JSON.stringify(workbook)) as Workbook
  };
}

export function serializeTamishraSheet(
  packageData: TamishraSheetPackage
): Uint8Array {
  const canonicalPayload = stableJson(packageData);
  const envelope: TamishraSheetEnvelope = {
    checksum: fnv1a32(canonicalPayload),
    payload: packageData
  };

  return new TextEncoder().encode(
    TMSHEET_MAGIC + JSON.stringify(envelope)
  );
}

export function parseTamishraSheet(
  input: ArrayBuffer | Uint8Array
): TamishraSheetPackage {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);

  if (!text.startsWith(TMSHEET_MAGIC)) {
    throw new Error("This is not a Tamishra .tmsheet file.");
  }

  let envelope: TamishraSheetEnvelope;

  try {
    envelope = JSON.parse(
      text.slice(TMSHEET_MAGIC.length)
    ) as TamishraSheetEnvelope;
  } catch {
    throw new Error("The Tamishra spreadsheet package is damaged or unreadable.");
  }

  const payload = envelope?.payload;
  const manifest = payload?.manifest;

  if (!payload || !manifest) {
    throw new Error("The Tamishra spreadsheet manifest is missing.");
  }

  if (
    manifest.format !== "Tamishra Sheet" ||
    manifest.extension !== TMSHEET_EXTENSION
  ) {
    throw new Error("Unsupported Tamishra spreadsheet format.");
  }

  if (manifest.formatVersion > TMSHEET_FORMAT_VERSION) {
    throw new Error(
      `This .tmsheet file uses format version ${manifest.formatVersion}, but this Tamishra Sheets build supports up to version ${TMSHEET_FORMAT_VERSION}.`
    );
  }

  if (manifest.formatVersion < 1) {
    throw new Error("Invalid Tamishra spreadsheet format version.");
  }

  const checksum = fnv1a32(stableJson(payload));
  if (checksum !== envelope.checksum) {
    throw new Error("The Tamishra spreadsheet failed its integrity check.");
  }

  const normalized = normalizeWorkbook(payload.workbook);
  if (!normalized) {
    throw new Error("The Tamishra spreadsheet workbook is invalid.");
  }

  return {
    manifest,
    workbook: normalized
  };
}

export function tamishraSheetFilename(title: string) {
  const safe =
    title
      .trim()
      .replace(/[^a-z0-9-_]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "spreadsheet";

  return safe + TMSHEET_EXTENSION;
}
