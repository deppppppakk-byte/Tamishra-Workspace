"use client";

import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType
} from "docx";
import type { DocsDocxAdapter, DocsImportResult } from "@tamishra/docs-engine";

function runsFromElement(element: Element): TextRun[] {
  const runs: TextRun[] = [];

  const walk = (node: Node, marks: {
    bold?: boolean;
    italics?: boolean;
    underline?: boolean;
    strike?: boolean;
  } = {}) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? "";
      if (!text) return;
      runs.push(new TextRun({
        text,
        bold: marks.bold,
        italics: marks.italics,
        strike: marks.strike,
        underline: marks.underline ? { type: UnderlineType.SINGLE } : undefined
      }));
      return;
    }

    if (!(node instanceof HTMLElement)) return;

    const tag = node.tagName.toLowerCase();
    const next = {
      ...marks,
      bold: marks.bold || tag === "strong" || tag === "b",
      italics: marks.italics || tag === "em" || tag === "i",
      underline: marks.underline || tag === "u",
      strike: marks.strike || tag === "s" || tag === "strike"
    };

    if (tag === "br") {
      runs.push(new TextRun({ break: 1 }));
      return;
    }

    Array.from(node.childNodes).forEach((child) => walk(child, next));
  };

  Array.from(element.childNodes).forEach((child) => walk(child));
  return runs.length ? runs : [new TextRun("")];
}

function paragraphFromElement(element: HTMLElement, list?: { ordered: boolean; level: number }) {
  const tag = element.tagName.toLowerCase();
  const heading =
    tag === "h1" ? HeadingLevel.HEADING_1 :
    tag === "h2" ? HeadingLevel.HEADING_2 :
    tag === "h3" ? HeadingLevel.HEADING_3 :
    tag === "h4" ? HeadingLevel.HEADING_4 :
    undefined;

  const align =
    element.style.textAlign === "center" ? AlignmentType.CENTER :
    element.style.textAlign === "right" ? AlignmentType.RIGHT :
    element.style.textAlign === "justify" ? AlignmentType.JUSTIFIED :
    AlignmentType.LEFT;

  return new Paragraph({
    children: runsFromElement(element),
    heading,
    alignment: align,
    bullet: list && !list.ordered ? { level: list.level } : undefined,
    numbering: list?.ordered
      ? { reference: "tamishra-numbering", level: list.level }
      : undefined
  });
}

function tableFromElement(element: HTMLTableElement) {
  const rows = Array.from(element.rows).map((row) =>
    new TableRow({
      children: Array.from(row.cells).map((cell) =>
        new TableCell({
          columnSpan: cell.colSpan > 1 ? cell.colSpan : undefined,
          rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined,
          children: [
            new Paragraph({
              children: runsFromElement(cell)
            })
          ]
        })
      )
    })
  );

  return new Table({ rows });
}

function htmlToDocxChildren(html: string) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const children: Array<Paragraph | Table> = [];

  for (const child of Array.from(parsed.body.children)) {
    const element = child as HTMLElement;
    const tag = element.tagName.toLowerCase();

    if (tag === "table") {
      children.push(tableFromElement(element as HTMLTableElement));
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      Array.from(element.children)
        .filter((item) => item.tagName.toLowerCase() === "li")
        .forEach((item) => {
          children.push(
            paragraphFromElement(item as HTMLElement, {
              ordered: tag === "ol",
              level: 0
            })
          );
        });
      continue;
    }

    if (["p", "div", "blockquote", "h1", "h2", "h3", "h4"].includes(tag)) {
      children.push(paragraphFromElement(element));
      continue;
    }

    if (tag === "hr") {
      children.push(new Paragraph({ children: [new TextRun("────────────────")] }));
      continue;
    }

    if (element.innerText.trim()) {
      children.push(paragraphFromElement(element));
    }
  }

  return children.length
    ? children
    : [new Paragraph({ children: [new TextRun("")] })];
}

export const browserDocsDocxAdapter: DocsDocxAdapter = {
  async importDocx(file): Promise<DocsImportResult> {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ arrayBuffer: file });

    return {
      html: result.value,
      warnings: result.messages.map((message, index) => ({
        code: `mammoth-${index + 1}`,
        message: message.message
      }))
    };
  },

  async exportDocx({ title, html, headerText, footerText }) {
    const document = new Document({
      numbering: {
        config: [
          {
            reference: "tamishra-numbering",
            levels: [
              {
                level: 0,
                format: "decimal",
                text: "%1.",
                alignment: AlignmentType.START
              }
            ]
          }
        ]
      },
      sections: [
        {
          headers: headerText
            ? {
                default: new Header({
                  children: [new Paragraph({ children: [new TextRun(headerText)] })]
                })
              }
            : undefined,
          footers: footerText
            ? {
                default: new Footer({
                  children: [new Paragraph({ children: [new TextRun(footerText)] })]
                })
              }
            : undefined,
          children: [
            new Paragraph({
              children: [new TextRun({ text: title, bold: true, size: 32 })],
              spacing: { after: 240 }
            }),
            ...htmlToDocxChildren(html)
          ]
        }
      ]
    });

    return Packer.toBlob(document);
  }
};
