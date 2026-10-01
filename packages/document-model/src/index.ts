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

export type TextMarks = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  color?: string;
  highlight?: string;
  fontFamily?: string;
  fontSizePt?: number;
};

export type TextRun = {
  id: string;
  type: "text";
  text: string;
  marks?: TextMarks;
};

export type LinkInline = {
  id: string;
  type: "link";
  href: string;
  children: TextRun[];
};

export type BookmarkInline = {
  id: string;
  type: "bookmark";
  name: string;
};

export type CommentAnchorInline = {
  id: string;
  type: "comment-anchor";
  commentId: string;
  edge: "start" | "end";
};

export type InlineNode = TextRun | LinkInline | BookmarkInline | CommentAnchorInline;

export type ParagraphBlock = DocumentBlockBase & {
  type: "paragraph";
  children: InlineNode[];
  style?: string;
  alignment?: "left" | "center" | "right" | "justify";
};

export type HeadingBlock = DocumentBlockBase & {
  type: "heading";
  level: 1 | 2 | 3 | 4;
  children: InlineNode[];
};

export type DividerBlock = DocumentBlockBase & {
  type: "divider";
};

export type PageBreakBlock = DocumentBlockBase & {
  type: "page-break";
};

export type ListItem = {
  id: string;
  blocks: DocumentBlock[];
};

export type ListBlock = DocumentBlockBase & {
  type: "list";
  ordered: boolean;
  start?: number;
  level: number;
  items: ListItem[];
};

export type TableCell = {
  id: string;
  colSpan?: number;
  rowSpan?: number;
  blocks: DocumentBlock[];
};

export type TableRow = {
  id: string;
  cells: TableCell[];
};

export type TableBlock = DocumentBlockBase & {
  type: "table";
  rows: TableRow[];
};

export type ImageBlock = DocumentBlockBase & {
  type: "image";
  src: string;
  alt: string;
  caption?: string;
  widthPx?: number;
  heightPx?: number;
  rotationDeg?: number;
  layout?: "inline" | "block" | "wrap-left" | "wrap-right" | "center";
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
  | ListBlock
  | TableBlock
  | ImageBlock
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
