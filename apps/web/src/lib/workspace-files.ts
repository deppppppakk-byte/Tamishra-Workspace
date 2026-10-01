"use client";

import {
  emptyWorkspaceFileIndex,
  mergeWorkspaceFileIndexes,
  type WorkspaceFileIndex
} from "@tamishra/file-core";
import { workspaceApiBase } from "./workspace-api";

const STORAGE_KEY = "tamishra.workspace.files.v1";

let cloudRevision: number | null = null;
let cloudKnown = false;
let cloudUnavailable = false;
let pushTimer: number | null = null;
let hydratePromise: Promise<WorkspaceFileIndex> | null = null;

type CloudFileIndexResponse = {
  persistence: "postgres" | "ephemeral-memory";
  revision: number;
  updatedAt: string | null;
  index: WorkspaceFileIndex;
};

function normalizeIndex(value: unknown): WorkspaceFileIndex {
  if (!value || typeof value !== "object") return emptyWorkspaceFileIndex();
  const candidate = value as Partial<WorkspaceFileIndex>;
  return {
    version: 1,
    records: Array.isArray(candidate.records) ? candidate.records : []
  };
}

function persistLocal(index: WorkspaceFileIndex) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(index));
  window.dispatchEvent(
    new CustomEvent("tamishra:files-changed", { detail: index })
  );
}

export function loadWorkspaceFileIndex(): WorkspaceFileIndex {
  if (typeof localStorage === "undefined") return emptyWorkspaceFileIndex();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeIndex(JSON.parse(raw)) : emptyWorkspaceFileIndex();
  } catch {
    return emptyWorkspaceFileIndex();
  }
}

async function fetchCloudIndex() {
  const response = await fetch(`${workspaceApiBase}/v1/files/index`, {
    method: "GET",
    credentials: "include",
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (response.status === 401) {
    cloudKnown = true;
    cloudUnavailable = true;
    return null;
  }

  if (!response.ok) {
    throw new Error(`Workspace Files cloud pull failed (${response.status})`);
  }

  return response.json() as Promise<CloudFileIndexResponse>;
}

export async function syncWorkspaceFileIndexFromCloud() {
  if (typeof window === "undefined") return emptyWorkspaceFileIndex();
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    const local = loadWorkspaceFileIndex();

    try {
      const remote = await fetchCloudIndex();
      if (!remote) return local;

      cloudKnown = true;
      cloudUnavailable = false;
      cloudRevision = remote.revision;

      const merged = mergeWorkspaceFileIndexes(
        local,
        normalizeIndex(remote.index)
      );
      persistLocal(merged);
      return merged;
    } catch {
      cloudKnown = true;
      cloudUnavailable = true;
      return local;
    } finally {
      hydratePromise = null;
    }
  })();

  return hydratePromise;
}

async function pushCurrentIndex(attempt = 0): Promise<void> {
  if (!cloudKnown) {
    await syncWorkspaceFileIndexFromCloud();
  }

  if (cloudUnavailable) return;

  const index = loadWorkspaceFileIndex();
  const response = await fetch(`${workspaceApiBase}/v1/files/index`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      revision: cloudRevision,
      index
    })
  });

  if (response.status === 401) {
    cloudUnavailable = true;
    return;
  }

  if (response.status === 409 && attempt === 0) {
    cloudKnown = false;
    cloudUnavailable = false;
    await syncWorkspaceFileIndexFromCloud();
    return pushCurrentIndex(1);
  }

  if (!response.ok) return;

  const saved = await response.json() as CloudFileIndexResponse;
  cloudRevision = saved.revision;
  cloudUnavailable = false;

  const merged = mergeWorkspaceFileIndexes(
    loadWorkspaceFileIndex(),
    normalizeIndex(saved.index)
  );
  persistLocal(merged);
}

function scheduleCloudPush() {
  if (typeof window === "undefined") return;
  if (pushTimer !== null) window.clearTimeout(pushTimer);

  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    void pushCurrentIndex();
  }, 1000);
}

export function saveWorkspaceFileIndex(index: WorkspaceFileIndex) {
  persistLocal(index);
  scheduleCloudPush();
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
