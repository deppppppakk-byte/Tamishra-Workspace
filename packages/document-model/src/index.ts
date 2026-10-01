export type PageSizeName = "A4" | "LETTER" | "LEGAL" | "A3" | "CUSTOM";
export type PageOrientation = "portrait" | "landscape";

export type PageMargins = {
  topMm: number;
  rightMm: number;
  bottomMm: number;
  leftMm: number;
};

export type PageConfig = {
  size: PageSizeName;
  orientation: PageOrientation;
  widthMm: number;
  heightMm: number;
  margins: PageMargins;
};

export type DocumentBlockBase = {
  id: string;
};

export type ParagraphBlock = DocumentBlockBase & {
  type: "paragraph";
  text: string;
  style?: string;
};

export type HeadingBlock = DocumentBlockBase & {
  type: "heading";
  level: 1 | 2 | 3 | 4;
  text: string;
};

export type DividerBlock = DocumentBlockBase & {
  type: "divider";
};

export type PageBreakBlock = DocumentBlockBase & {
  type: "page-break";
};

export type LegacyRichTextBlock = DocumentBlockBase & {
  type: "legacy-rich-text";
  html: string;
  migrationVersion: 1;
};

export type DocumentBlock =
  | ParagraphBlock
  | HeadingBlock
  | DividerBlock
  | PageBreakBlock
  | LegacyRichTextBlock;

export type DocumentSection = {
  id: string;
  page: PageConfig;
  blocks: DocumentBlock[];
  header?: DocumentBlock[];
  footer?: DocumentBlock[];
};

export type TamishraDocument = {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  sections: DocumentSection[];
};

const PAGE_SIZES: Record<Exclude<PageSizeName, "CUSTOM">, { widthMm: number; heightMm: number }> = {
  A4: { widthMm: 210, heightMm: 297 },
  LETTER: { widthMm: 215.9, heightMm: 279.4 },
  LEGAL: { widthMm: 215.9, heightMm: 355.6 },
  A3: { widthMm: 297, heightMm: 420 }
};

export const defaultMargins: PageMargins = {
  topMm: 25.4,
  rightMm: 25.4,
  bottomMm: 25.4,
  leftMm: 25.4
};

export function createId(prefix = "node"): string {
  const random =
    typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);

  return `${prefix}_${random}`;
}

export function createPageConfig(
  size: PageSizeName = "A4",
  orientation: PageOrientation = "portrait",
  margins: PageMargins = defaultMargins
): PageConfig {
  const base =
    size === "CUSTOM"
      ? { widthMm: 210, heightMm: 297 }
      : PAGE_SIZES[size];

  const dimensions =
    orientation === "portrait"
      ? base
      : { widthMm: base.heightMm, heightMm: base.widthMm };

  return {
    size,
    orientation,
    widthMm: dimensions.widthMm,
    heightMm: dimensions.heightMm,
    margins: { ...margins }
  };
}

export function createDocument(title = "Untitled document"): TamishraDocument {
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    id: createId("doc"),
    title,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    sections: [
      {
        id: createId("section"),
        page: createPageConfig(),
        blocks: []
      }
    ]
  };
}

export function withPageSize(
  page: PageConfig,
  size: PageSizeName,
  orientation: PageOrientation = page.orientation
): PageConfig {
  const next = createPageConfig(size, orientation, page.margins);

  if (size === "CUSTOM" && page.size === "CUSTOM") {
    next.widthMm = orientation === page.orientation ? page.widthMm : page.heightMm;
    next.heightMm = orientation === page.orientation ? page.heightMm : page.widthMm;
  }

  return next;
}

export function withOrientation(page: PageConfig, orientation: PageOrientation): PageConfig {
  if (page.orientation === orientation) return { ...page, margins: { ...page.margins } };

  return {
    ...page,
    orientation,
    widthMm: page.heightMm,
    heightMm: page.widthMm,
    margins: { ...page.margins }
  };
}

export function withMargins(page: PageConfig, margins: PageMargins): PageConfig {
  return {
    ...page,
    margins: { ...margins }
  };
}
