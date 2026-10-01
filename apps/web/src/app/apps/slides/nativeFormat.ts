export const TMSL_EXTENSION = ".tmsl";
export const TMSL_MIME = "application/x-tamishra-slides";
export const TMSL_FORMAT = "tamishra.slides";
export const TMSL_CONTAINER_VERSION = 1;

const MAGIC = new Uint8Array([0x54, 0x4d, 0x53, 0x4c, 0x01, 0x00, 0x0d, 0x0a]);
const HEADER_SIZE_BYTES = 4;

type CompressionMode = "gzip" | "none";

export type TmslPreview = {
  background?: string;
  title?: string;
  subtitle?: string;
};

export type TmslHeader = {
  format: typeof TMSL_FORMAT;
  containerVersion: number;
  schemaVersion: number;
  mime: typeof TMSL_MIME;
  compression: CompressionMode;
  checksum: string;
  createdAt: string;
  modifiedAt: string;
  generator: string;
  title: string;
  slideCount: number;
  preview?: TmslPreview;
};

export type TamishraSlidesDocument<TSlide = unknown> = {
  schemaVersion: number;
  title: string;
  slides: TSlide[];
  metadata?: {
    createdAt?: string;
    modifiedAt?: string;
    appVersion?: string;
  };
};

export type DecodedTmsl<TSlide = unknown> = {
  header: TmslHeader;
  document: TamishraSlidesDocument<TSlide>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const equalMagic = (bytes: Uint8Array) => {
  if (bytes.byteLength < MAGIC.byteLength) return false;
  return MAGIC.every((value, index) => bytes[index] === value);
};

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const sha256 = async (bytes: Uint8Array) => {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return bytesToHex(new Uint8Array(digest));
};

const streamToUint8Array = async (stream: ReadableStream<Uint8Array>) => {
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
};

const compress = async (bytes: Uint8Array): Promise<{
  bytes: Uint8Array;
  compression: CompressionMode;
}> => {
  if (typeof CompressionStream === "undefined") {
    return { bytes, compression: "none" };
  }

  const input = new Blob([toArrayBuffer(bytes)]).stream();
  const compressed = input.pipeThrough(new CompressionStream("gzip"));
  return {
    bytes: await streamToUint8Array(compressed),
    compression: "gzip"
  };
};

const decompress = async (
  bytes: Uint8Array,
  compression: CompressionMode
): Promise<Uint8Array> => {
  if (compression === "none") return bytes;
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot open compressed TMSL files.");
  }

  const input = new Blob([toArrayBuffer(bytes)]).stream();
  const decompressed = input.pipeThrough(new DecompressionStream("gzip"));
  return streamToUint8Array(decompressed);
};

const concat = (...parts: Uint8Array[]) => {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }

  return output;
};

const safeFileName = (value: string) =>
  (value.trim() || "presentation").replace(/[^a-z0-9-_]+/gi, "-");

const extractPreview = (slides: unknown[]): TmslPreview | undefined => {
  const first = slides[0];
  if (!first || typeof first !== "object") return undefined;

  const slide = first as {
    background?: unknown;
    elements?: unknown;
  };
  const elements = Array.isArray(slide.elements) ? slide.elements : [];
  const texts = elements
    .filter((element): element is { type?: unknown; text?: unknown; hidden?: unknown } =>
      Boolean(element) && typeof element === "object"
    )
    .filter((element) => element.type === "text" && element.hidden !== true)
    .map((element) => typeof element.text === "string" ? element.text.trim() : "")
    .filter(Boolean);

  return {
    background: typeof slide.background === "string" ? slide.background : undefined,
    title: texts[0]?.slice(0, 180),
    subtitle: texts[1]?.slice(0, 240)
  };
};

export function decodeTmslHeader(
  source: ArrayBuffer | Uint8Array
): TmslHeader {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);

  if (!equalMagic(bytes)) {
    throw new Error("Not a Tamishra Slides (.tmsl) file.");
  }

  const headerOffset = MAGIC.byteLength;
  const minimumLength = headerOffset + HEADER_SIZE_BYTES;
  if (bytes.byteLength < minimumLength) {
    throw new Error("TMSL file is incomplete.");
  }

  const headerLength = new DataView(
    bytes.buffer,
    bytes.byteOffset + headerOffset,
    HEADER_SIZE_BYTES
  ).getUint32(0, false);
  const headerStart = minimumLength;
  const headerEnd = headerStart + headerLength;

  if (headerLength <= 0 || headerEnd > bytes.byteLength) {
    throw new Error("TMSL header is invalid.");
  }

  return JSON.parse(
    decoder.decode(bytes.subarray(headerStart, headerEnd))
  ) as TmslHeader;
}

export async function encodeTmsl<TSlide>(
  document: TamishraSlidesDocument<TSlide>
): Promise<Uint8Array> {
  const normalized: TamishraSlidesDocument<TSlide> = {
    ...document,
    schemaVersion: document.schemaVersion || 1,
    metadata: {
      ...document.metadata,
      modifiedAt: new Date().toISOString(),
      appVersion: document.metadata?.appVersion ?? "Tamishra Slides"
    }
  };

  const rawPayload = encoder.encode(JSON.stringify(normalized));
  const checksum = await sha256(rawPayload);
  const packed = await compress(rawPayload);

  const now = new Date().toISOString();
  const header: TmslHeader = {
    format: TMSL_FORMAT,
    containerVersion: TMSL_CONTAINER_VERSION,
    schemaVersion: normalized.schemaVersion,
    mime: TMSL_MIME,
    compression: packed.compression,
    checksum,
    createdAt: normalized.metadata?.createdAt ?? now,
    modifiedAt: normalized.metadata?.modifiedAt ?? now,
    generator: "Tamishra Slides",
    title: normalized.title,
    slideCount: normalized.slides.length,
    preview: extractPreview(normalized.slides)
  };

  const headerBytes = encoder.encode(JSON.stringify(header));
  const headerLength = new Uint8Array(HEADER_SIZE_BYTES);
  new DataView(headerLength.buffer).setUint32(0, headerBytes.byteLength, false);

  return concat(MAGIC, headerLength, headerBytes, packed.bytes);
}

export async function decodeTmsl<TSlide>(
  source: ArrayBuffer | Uint8Array
): Promise<DecodedTmsl<TSlide>> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);

  if (!equalMagic(bytes)) {
    throw new Error("Not a Tamishra Slides (.tmsl) file.");
  }

  const headerOffset = MAGIC.byteLength;
  const minimumLength = headerOffset + HEADER_SIZE_BYTES;
  const headerLength = new DataView(
    bytes.buffer,
    bytes.byteOffset + headerOffset,
    HEADER_SIZE_BYTES
  ).getUint32(0, false);
  const headerStart = minimumLength;
  const headerEnd = headerStart + headerLength;
  const header = decodeTmslHeader(bytes);

  if (
    header.format !== TMSL_FORMAT ||
    header.mime !== TMSL_MIME ||
    header.containerVersion !== TMSL_CONTAINER_VERSION
  ) {
    throw new Error("Unsupported TMSL container version.");
  }

  const payload = await decompress(
    bytes.subarray(headerEnd),
    header.compression
  );

  const checksum = await sha256(payload);
  if (checksum !== header.checksum) {
    throw new Error("TMSL integrity check failed.");
  }

  const document = JSON.parse(
    decoder.decode(payload)
  ) as TamishraSlidesDocument<TSlide>;

  if (!document || !Array.isArray(document.slides)) {
    throw new Error("TMSL document payload is invalid.");
  }

  return { header, document };
}

export async function downloadTmsl<TSlide>(
  deckDocument: TamishraSlidesDocument<TSlide>
) {
  const bytes = await encodeTmsl(deckDocument);
  const blob = new Blob([toArrayBuffer(bytes)], { type: TMSL_MIME });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeFileName(deckDocument.title) + TMSL_EXTENSION;
  anchor.click();
  URL.revokeObjectURL(url);
}
