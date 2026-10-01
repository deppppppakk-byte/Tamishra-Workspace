"use client";

import {
  createBlockShelf,
  normalizeBlockShelf,
  type TamishraBlock,
  type TamishraBlockShelf
} from "@tamishra/blocks-core";

const STORAGE_KEY = "tamishra.workspace.blocks.v1";
const HANDOFF_KEY = "tamishra.workspace.block-handoff.v1";
const CHANNEL_NAME = "tamishra.workspace.blocks";

type BlockHandoff = {
  blockId: string;
  targetApp: string;
  createdAt: string;
};

export function loadWorkspaceBlockShelf(): TamishraBlockShelf {
  if (typeof window === "undefined") return createBlockShelf();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeBlockShelf(JSON.parse(raw)) : createBlockShelf();
  } catch {
    return createBlockShelf();
  }
}

export function saveWorkspaceBlockShelf(shelf: TamishraBlockShelf) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(shelf));
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: "changed" });
    channel.close();
  } catch {
    // Storage still works where BroadcastChannel is unavailable.
  }
}

export function mutateWorkspaceBlockShelf(
  recipe: (current: TamishraBlockShelf) => TamishraBlockShelf
) {
  const next = recipe(loadWorkspaceBlockShelf());
  saveWorkspaceBlockShelf(next);
  return next;
}

export function subscribeWorkspaceBlocks(callback: () => void) {
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
    // Same-tab callers can refresh after mutations.
  }

  return () => {
    window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}

export function queueBlockHandoff(blockId: string, targetApp: string) {
  const handoff: BlockHandoff = {
    blockId,
    targetApp,
    createdAt: new Date().toISOString()
  };
  sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
}

export function consumeBlockHandoff(targetApp: string): TamishraBlock | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    const handoff = JSON.parse(raw) as Partial<BlockHandoff>;
    if (
      handoff.targetApp !== targetApp ||
      typeof handoff.blockId !== "string"
    ) {
      return null;
    }

    sessionStorage.removeItem(HANDOFF_KEY);
    return (
      loadWorkspaceBlockShelf().blocks.find(
        (block) => block.id === handoff.blockId
      ) ?? null
    );
  } catch {
    sessionStorage.removeItem(HANDOFF_KEY);
    return null;
  }
}
