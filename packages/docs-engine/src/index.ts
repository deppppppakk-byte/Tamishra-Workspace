import {
  createDocument,
  createId,
  type DocumentBlock,
  type InlineNode,
  type PageConfig,
  type TamishraDocument,
  type TextMarks
} from "@tamishra/document-model";

function readMarks(element: HTMLElement): TextMarks | undefined {
  const marks: TextMarks = {};
  const style = element.style;

  if (element.tagName === "STRONG" || element.tagName === "B" || style.fontWeight === "bold" || Number(style.fontWeight) >= 600) {
    marks.bold = true;
  }
  if (element.tagName === "EM" || element.tagName === "I" || style.fontStyle === "italic") {
    marks.italic = true;
  }
  if (element.tagName === "U" || style.textDecoration.includes("underline")) {
    marks.underline = true;
  }
  if (element.tagName === "S" || element.tagName === "STRIKE" || style.textDecoration.includes("line-through")) {
    marks.strike = true;
  }
  if (element.tagName === "SUP") marks.superscript = true;
  if (element.tagName === "SUB") marks.subscript = true;
  if (style.color) marks.color = style.color;
  if (style.backgroundColor) marks.highlight = style.backgroundColor;
  if (style.fontFamily) marks.fontFamily = style.fontFamily;

  const size = Number.parseFloat(style.fontSize);
  if (Number.isFinite(size) && size > 0) marks.fontSizePt = size;

  return Object.keys(marks).length ? marks : undefined;
}

function inlineFromNode(node: Node, inheritedMarks?: TextMarks): InlineNode[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    if (!text) return [];

    return [{
      id: createId("text"),
      type: "text",
      text,
      marks: inheritedMarks
    }];
  }

  if (!(node instanceof HTMLElement)) return [];

  const ownMarks = readMarks(node);
  const marks = { ...(inheritedMarks ?? {}), ...(ownMarks ?? {}) };

  if (node.tagName === "A") {
    const children = Array.from(node.childNodes)
      .flatMap((child) => inlineFromNode(child, marks))
      .filter((item): item is Extract<InlineNode, { type: "text" }> => item.type === "text");

    return [{
      id: node.dataset.tamishraId || createId("link"),
      type: "link",
      href: node.getAttribute("href") ?? "",
      children
    }];
  }

  if (node.dataset.bookmark) {
    return [{
      id: node.dataset.tamishraId || createId("bookmark"),
      type: "bookmark",
      name: node.dataset.bookmark
    }];
  }

  return Array.from(node.childNodes).flatMap((child) => inlineFromNode(child, marks));
}

function paragraphFromElement(element: HTMLElement): DocumentBlock {
  const align = element.style.textAlign;
  const alignment =
    align === "center" || align === "right" || align === "justify"
      ? align
      : align === "left"
        ? "left"
        : undefined;

  return {
    id: element.dataset.tamishraId || createId("paragraph"),
    type: "paragraph",
    children: inlineFromNode(element),
    style: element.dataset.style,
    alignment
  };
}

function blocksFromContainer(container: ParentNode): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];

  for (const node of Array.from(container.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent?.trim();
      if (text) {
        blocks.push({
          id: createId("paragraph"),
          type: "paragraph",
          children: [{ id: createId("text"), type: "text", text }]
        });
      }
      continue;
    }

    if (!(node instanceof HTMLElement)) continue;

    const tag = node.tagName.toLowerCase();
    const id = node.dataset.tamishraId || createId("block");

    if (/^h[1-4]$/.test(tag)) {
      blocks.push({
        id,
        type: "heading",
        level: Number(tag.slice(1)) as 1 | 2 | 3 | 4,
        children: inlineFromNode(node)
      });
      continue;
    }

    if (tag === "hr") {
      blocks.push({ id, type: "divider" });
      continue;
    }

    if (node.dataset.pageBreak === "true") {
      blocks.push({ id, type: "page-break" });
      continue;
    }

    if (tag === "img") {
      const image = node as HTMLImageElement;

      blocks.push({
        id,
        type: "image",
        src: image.getAttribute("src") ?? "",
        alt: image.getAttribute("alt") ?? "",
        widthPx: image.width || undefined,
        heightPx: image.height || undefined,
        layout: (node.dataset.layout as "inline" | "block" | "wrap-left" | "wrap-right" | "center" | undefined) ?? "inline"
      });
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      blocks.push({
        id,
        type: "list",
        ordered: tag === "ol",
        start: tag === "ol" ? Number(node.getAttribute("start") || 1) : undefined,
        level: Number(node.dataset.level || 0),
        items: Array.from(node.children)
          .filter((child) => child.tagName.toLowerCase() === "li")
          .map((item) => ({
            id: (item as HTMLElement).dataset.tamishraId || createId("list-item"),
            blocks: [{
              id: createId("paragraph"),
              type: "paragraph" as const,
              children: inlineFromNode(item)
            }]
          }))
      });
      continue;
    }

    if (tag === "table") {
      const rows = Array.from(node.querySelectorAll(":scope > tbody > tr, :scope > thead > tr, :scope > tr")).map((row) => ({
        id: (row as HTMLElement).dataset.tamishraId || createId("row"),
        cells: Array.from(row.children)
          .filter((cell) => ["td", "th"].includes(cell.tagName.toLowerCase()))
          .map((cell) => ({
            id: (cell as HTMLElement).dataset.tamishraId || createId("cell"),
            colSpan: (cell as HTMLTableCellElement).colSpan || undefined,
            rowSpan: (cell as HTMLTableCellElement).rowSpan || undefined,
            blocks: blocksFromContainer(cell)
          }))
      }));

      blocks.push({ id, type: "table", rows });
      continue;
    }

    if (tag === "p" || tag === "div" || tag === "blockquote") {
      blocks.push(paragraphFromElement(node));
      continue;
    }

    const nested = blocksFromContainer(node);
    if (nested.length) {
      blocks.push(...nested);
    } else if (node.textContent?.trim()) {
      blocks.push(paragraphFromElement(node));
    }
  }

  return blocks;
}

export function htmlToBlocks(html: string): DocumentBlock[] {
  if (typeof DOMParser === "undefined") {
    return [{
      id: createId("legacy"),
      type: "legacy-rich-text",
      html,
      migrationVersion: 1
    }];
  }

  const parsed = new DOMParser().parseFromString(`<div id="tamishra-root">${html}</div>`, "text/html");
  const root = parsed.getElementById("tamishra-root");

  if (!root) return [];

  return blocksFromContainer(root);
}

export type PersistedDocsDraft = {
  version: 2;
  document: TamishraDocument;
  editorHtml: string;
  updatedAt: string;
};

export function createDraftFromHtml(
  title: string,
  html: string,
  page?: PageConfig
): PersistedDocsDraft {
  const document = createDocument(title);
  const section = document.sections[0];

  if (page) {
    section.page = {
      ...page,
      margins: { ...page.margins }
    };
  }

  section.blocks = htmlToBlocks(html);

  document.updatedAt = new Date().toISOString();

  return {
    version: 2,
    document,
    editorHtml: html,
    updatedAt: document.updatedAt
  };
}

export function updateDraft(
  current: PersistedDocsDraft,
  changes: {
    title?: string;
    editorHtml?: string;
    page?: PageConfig;
  }
): PersistedDocsDraft {
  const now = new Date().toISOString();
  const html = changes.editorHtml ?? current.editorHtml;
  const section = current.document.sections[0];

  const document: TamishraDocument = {
    ...current.document,
    title: changes.title ?? current.document.title,
    updatedAt: now,
    revision: current.document.revision + 1,
    sections: [
      {
        ...section,
        page: changes.page
          ? { ...changes.page, margins: { ...changes.page.margins } }
          : { ...section.page, margins: { ...section.page.margins } },
        blocks: htmlToBlocks(html)
      },
      ...current.document.sections.slice(1)
    ]
  };

  return {
    version: 2,
    document,
    editorHtml: html,
    updatedAt: now
  };
}

export function migrateLegacyDraft(input: {
  title?: string;
  html?: string;
  updatedAt?: string;
}): PersistedDocsDraft {
  return createDraftFromHtml(
    input.title?.trim() || "Untitled document",
    input.html || ""
  );
}

export function mmToCssPx(mm: number): number {
  return (mm / 25.4) * 96;
}
