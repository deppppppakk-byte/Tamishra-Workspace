"use client";

import {
  emptyWorkspaceFileIndex,
  type WorkspaceFileIndex
} from "@tamishra/file-core";

const STORAGE_KEY = "tamishra.workspace.files.v1";

export function loadWorkspaceFileIndex(): WorkspaceFileIndex {
  if (typeof localStorage === "undefined") return emptyWorkspaceFileIndex();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyWorkspaceFileIndex();

    const parsed = JSON.parse(raw) as Partial<WorkspaceFileIndex>;
    return {
      version: 1,
      records: Array.isArray(parsed.records) ? parsed.records : []
    };
  } catch {
    return emptyWorkspaceFileIndex();
  }
}

export function saveWorkspaceFileIndex(index: WorkspaceFileIndex) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(index));
  window.dispatchEvent(
    new CustomEvent("tamishra:files-changed", { detail: index })
  );
}

export function mutateWorkspaceFileIndex(
  updater: (current: WorkspaceFileIndex) => WorkspaceFileIndex
) {
  const next = updater(loadWorkspaceFileIndex());
  saveWorkspaceFileIndex(next);
  return next;
}

export function watchWorkspaceFileIndex(
  listener: (index: WorkspaceFileIndex) => void
) {
  const handleCustom = (event: Event) => {
    const custom = event as CustomEvent<WorkspaceFileIndex>;
    listener(custom.detail ?? loadWorkspaceFileIndex());
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) listener(loadWorkspaceFileIndex());
  };

  window.addEventListener("tamishra:files-changed", handleCustom);
  window.addEventListener("storage", handleStorage);

  return () => {
    window.removeEventListener("tamishra:files-changed", handleCustom);
    window.removeEventListener("storage", handleStorage);
  };
}
