export type WorkspaceAppStatus = "advanced" | "functional" | "foundation";

export type WorkspaceApp = {
  id: string;
  name: string;
  shortName: string;
  description: string;
  status: WorkspaceAppStatus;
  href: string;
  nativeExtension?: string;
};

export const workspaceApps: WorkspaceApp[] = [
  { id: "docs", name: "Tamishra Docs", shortName: "D", description: "Write, format, review and publish documents.", status: "advanced", href: "/apps/docs", nativeExtension: ".tmdoc" },
  { id: "sheets", name: "Tamishra Sheets", shortName: "S", description: "Calculate, analyze and visualize structured data.", status: "functional", href: "/apps/sheets", nativeExtension: ".tmsh" },
  { id: "slides", name: "Tamishra Slides", shortName: "P", description: "Create visual presentations and present anywhere.", status: "advanced", href: "/apps/slides", nativeExtension: ".tmsl" },
  { id: "pdf", name: "Tamishra PDF", shortName: "PDF", description: "Read, annotate, organize and export PDF files.", status: "foundation", href: "/apps/pdf" },
  { id: "chat", name: "Tamishra Chat", shortName: "C", description: "Direct messages, groups, channels and threaded conversations.", status: "functional", href: "/apps/chat" },
  { id: "mail", name: "Tamishra Patra", shortName: "PA", description: "Tamishra-native email, inbox, threads and delivery.", status: "functional", href: "/apps/mail" },
  { id: "meet", name: "Tamishra Meet", shortName: "V", description: "Meetings, screen sharing, chat, recording and attendance.", status: "advanced", href: "/apps/meet" },
  { id: "notes", name: "Tamishra Notes", shortName: "N", description: "Capture ideas, checklists, meeting notes and knowledge.", status: "foundation", href: "/apps/notes" },
  { id: "forms", name: "Tamishra Forms", shortName: "F", description: "Build forms, surveys, quizzes and response flows.", status: "foundation", href: "/apps/forms" },
  { id: "files", name: "Tamishra Files", shortName: "FL", description: "Organize, search, open, favorite and recover workspace files.", status: "functional", href: "/apps/files" }
];

export function workspaceAppById(id: string) {
  return workspaceApps.find((app) => app.id === id) ?? null;
}
