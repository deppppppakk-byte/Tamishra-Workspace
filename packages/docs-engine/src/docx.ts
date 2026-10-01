export type DocsImportWarning = {
  code: string;
  message: string;
};

export type DocsImportResult = {
  html: string;
  warnings: DocsImportWarning[];
};

export type DocsDocxAdapter = {
  importDocx(file: ArrayBuffer): Promise<DocsImportResult>;
  exportDocx(input: {
    title: string;
    html: string;
    headerText?: string;
    footerText?: string;
  }): Promise<Blob>;
};

let adapter: DocsDocxAdapter | null = null;

export function registerDocsDocxAdapter(next: DocsDocxAdapter) {
  adapter = next;
}

export function getDocsDocxAdapter() {
  return adapter;
}

export async function importDocsDocx(file: ArrayBuffer) {
  if (!adapter) {
    throw new Error("DOCX adapter is not registered.");
  }
  return adapter.importDocx(file);
}

export async function exportDocsDocx(input: {
  title: string;
  html: string;
  headerText?: string;
  footerText?: string;
}) {
  if (!adapter) {
    throw new Error("DOCX adapter is not registered.");
  }
  return adapter.exportDocx(input);
}
