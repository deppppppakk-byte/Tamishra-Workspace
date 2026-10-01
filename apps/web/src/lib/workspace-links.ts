"use client";

import {
  emptyWorkspaceLinkIndex,
  normalizeWorkspaceLinkIndex,
  removeWorkspaceConsumerLinks,
  upsertWorkspaceLink,
  type WorkspaceLinkIndex,
  type WorkspaceLinkInput
} from "@tamishra/link-core";
import type { TamishraBlock } from "@tamishra/blocks-core";

const STORAGE_KEY = "tamishra.workspace.links.v1";
const CHANNEL_NAME = "tamishra.workspace.links";

export function loadWorkspaceLinkIndex(): WorkspaceLinkIndex {
  if (typeof window === "undefined") return emptyWorkspaceLinkIndex();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw
      ? normalizeWorkspaceLinkIndex(JSON.parse(raw))
      : emptyWorkspaceLinkIndex();
  } catch {
    return emptyWorkspaceLinkIndex();
  }
}

export function saveWorkspaceLinkIndex(index: WorkspaceLinkIndex) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(index));

  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: "changed" });
    channel.close();
  } catch {
    // Storage remains the fallback synchronization channel.
  }
}

export function mutateWorkspaceLinkIndex(
  updater: (current: WorkspaceLinkIndex) => WorkspaceLinkIndex
) {
  const next = updater(loadWorkspaceLinkIndex());
  saveWorkspaceLinkIndex(next);
  return next;
}

export function registerWorkspaceConsumerLink(input: {
  block: TamishraBlock;
  targetApp: WorkspaceLinkInput["targetApp"];
  targetResourceId: string;
  targetLocator?: string;
  targetTitle?: string;
  targetHref: string;
  consumerVersion?: number;
}) {
  const binding = input.block.binding;
  if (!binding || binding.mode !== "live") return null;

  const next = mutateWorkspaceLinkIndex((current) =>
    upsertWorkspaceLink(current, {
      blockId: input.block.id,
      sourceApp: binding.source.app,
      sourceResourceId: binding.source.resourceId,
      sourceLocator: binding.source.locator,
      sourceTitle: input.block.title,
      targetApp: input.targetApp,
      targetResourceId: input.targetResourceId,
      targetLocator: input.targetLocator,
      targetTitle: input.targetTitle,
      targetHref: input.targetHref,
      blockVersion: input.consumerVersion ?? input.block.version,
      lastSyncedAt: binding.lastSyncedAt
    })
  );

  return next;
}

export function unregisterWorkspaceConsumerLink(filter: {
  blockId?: string;
  targetApp?: WorkspaceLinkInput["targetApp"];
  targetResourceId?: string;
  targetLocator?: string;
}) {
  return mutateWorkspaceLinkIndex((current) =>
    removeWorkspaceConsumerLinks(current, filter)
  );
}

export function syncWorkspaceConsumerLinkVersion(
  block: TamishraBlock,
  filter: {
    targetApp: WorkspaceLinkInput["targetApp"];
    targetResourceId: string;
    targetLocator?: string;
  }
) {
  const binding = block.binding;
  if (!binding || binding.mode !== "live") return;

  mutateWorkspaceLinkIndex((current) => {
    const edge = current.edges.find(
      (item) =>
        item.blockId === block.id &&
        item.targetApp === filter.targetApp &&
        item.targetResourceId === filter.targetResourceId &&
        (filter.targetLocator === undefined ||
          item.targetLocator === filter.targetLocator)
    );
    if (!edge) return current;

    return upsertWorkspaceLink(current, {
      ...edge,
      blockVersion: block.version,
      lastSyncedAt: binding.lastSyncedAt
    });
  });
}

export function subscribeWorkspaceLinks(callback: () => void) {
  if (typeof window === "undefined") return () => undefined;

  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);

  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", callback);
  } catch {
    // Storage event remains available cross-tab.
  }

  return () => {
    window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}
