import {
  createDocument,
  createId,
  type PageConfig,
  type TamishraDocument
} from "@tamishra/document-model";

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

  section.blocks = [
    {
      id: createId("legacy"),
      type: "legacy-rich-text",
      html,
      migrationVersion: 1
    }
  ];

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
        blocks: [
          {
            id: section.blocks[0]?.id ?? createId("legacy"),
            type: "legacy-rich-text",
            html,
            migrationVersion: 1
          }
        ]
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
