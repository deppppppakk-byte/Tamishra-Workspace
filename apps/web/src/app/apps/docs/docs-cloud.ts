"use client";

import type { DocsWorkspaceSnapshot } from "@tamishra/docs-engine";

export type DocsCloudSnapshot = {
  revision: number;
  updatedAt: string | null;
  workspace: DocsWorkspaceSnapshot;
};

function apiBase() {
  const explicit = process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const gateway = process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim();
  if (gateway) return gateway.replace(/\/$/, "");

  return "/api/workspace";
}

export async function pullDocsCloudWorkspace(): Promise<DocsCloudSnapshot | null> {
  const response = await fetch(`${apiBase()}/v1/docs/workspace`, {
    method: "GET",
    credentials: "include",
    headers: { accept: "application/json" },
    cache: "no-store"
  });

  if (response.status === 401) return null;
  if (!response.ok) {
    throw new Error(`Cloud pull failed (${response.status})`);
  }

  return response.json() as Promise<DocsCloudSnapshot>;
}

export async function pushDocsCloudWorkspace(
  workspace: DocsWorkspaceSnapshot,
  revision?: number | null
): Promise<DocsCloudSnapshot | null> {
  const response = await fetch(`${apiBase()}/v1/docs/workspace`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      workspace,
      revision: revision ?? null
    })
  });

  if (response.status === 401) return null;

  if (response.status === 409) {
    const error = await response.json() as { currentRevision?: number };
    throw Object.assign(new Error("revision_conflict"), {
      status: 409,
      currentRevision: Number(error.currentRevision ?? 0)
    });
  }

  if (!response.ok) {
    throw new Error(`Cloud push failed (${response.status})`);
  }

  return response.json() as Promise<DocsCloudSnapshot>;
}
