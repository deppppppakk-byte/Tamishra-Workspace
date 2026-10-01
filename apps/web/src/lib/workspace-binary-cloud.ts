"use client";

import type { WorkspaceBinaryAsset } from "./workspace-binary-store";
import { workspaceApi } from "./workspace-api";

const MAX_CLOUD_PDF_BYTES = 16 * 1024 * 1024;

type CloudAssetResponse = {
  persistence: "postgres" | "ephemeral-memory";
  asset: {
    id: string;
    revision: number;
    name: string;
    type: string;
    size: number;
    bytesBase64?: string;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  };
};

type CloudRuntime = {
  revision: number;
  metadata: Record<string, unknown>;
};

const runtime = new Map<string, CloudRuntime>();

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function statusOf(error: unknown) {
  return Number((error as { status?: number } | undefined)?.status ?? 0);
}

export async function fetchCloudBinaryAsset(id: string) {
  try {
    const response = await workspaceApi<CloudAssetResponse>(
      `/v1/assets/${encodeURIComponent(id)}`,
      { cache: "no-store" }
    );

    runtime.set(id, {
      revision: response.asset.revision,
      metadata: response.asset.metadata ?? {}
    });

    if (!response.asset.bytesBase64) return null;

    return {
      persistence: response.persistence,
      metadata: response.asset.metadata ?? {},
      asset: {
        id: response.asset.id,
        name: response.asset.name,
        type: response.asset.type,
        size: response.asset.size,
        bytes: base64ToArrayBuffer(response.asset.bytesBase64),
        createdAt: response.asset.createdAt,
        updatedAt: response.asset.updatedAt
      } satisfies WorkspaceBinaryAsset
    };
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 404) return null;
    throw error;
  }
}

export async function uploadCloudPdfAsset(
  asset: WorkspaceBinaryAsset,
  metadata: Record<string, unknown> = {}
) {
  if (asset.size > MAX_CLOUD_PDF_BYTES) {
    return {
      uploaded: false,
      reason: "too_large" as const,
      persistence: null
    };
  }

  let current = runtime.get(asset.id);
  if (!current) {
    const remote = await fetchCloudBinaryAsset(asset.id).catch(() => null);
    current = runtime.get(asset.id);
    if (remote && current) {
      return {
        uploaded: true,
        reason: null,
        persistence: remote.persistence
      };
    }
  }

  try {
    const response = await workspaceApi<CloudAssetResponse>(
      `/v1/assets/${encodeURIComponent(asset.id)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          revision: current?.revision ?? 0,
          name: asset.name,
          type: asset.type,
          bytesBase64: arrayBufferToBase64(asset.bytes),
          metadata
        })
      }
    );

    runtime.set(asset.id, {
      revision: response.asset.revision,
      metadata: response.asset.metadata ?? {}
    });

    return {
      uploaded: true,
      reason: null,
      persistence: response.persistence
    };
  } catch (error) {
    if (statusOf(error) === 409) {
      const remote = await fetchCloudBinaryAsset(asset.id);
      const refreshed = runtime.get(asset.id);
      if (!refreshed) {
        return { uploaded: false, reason: "conflict" as const, persistence: null };
      }

      const response = await workspaceApi<CloudAssetResponse>(
        `/v1/assets/${encodeURIComponent(asset.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            revision: refreshed.revision,
            name: asset.name,
            type: asset.type,
            bytesBase64: arrayBufferToBase64(asset.bytes),
            metadata: remote?.metadata ?? metadata
          })
        }
      );

      runtime.set(asset.id, {
        revision: response.asset.revision,
        metadata: response.asset.metadata ?? {}
      });

      return {
        uploaded: true,
        reason: null,
        persistence: response.persistence
      };
    }

    if (statusOf(error) === 401) {
      return { uploaded: false, reason: "unauthenticated" as const, persistence: null };
    }

    return { uploaded: false, reason: "network" as const, persistence: null };
  }
}

export async function updateCloudPdfMetadata(
  id: string,
  metadata: Record<string, unknown>
) {
  let current = runtime.get(id);
  if (!current) {
    await fetchCloudBinaryAsset(id).catch(() => null);
    current = runtime.get(id);
  }
  if (!current) {
    return { saved: false, metadata, persistence: null };
  }

  try {
    const response = await workspaceApi<CloudAssetResponse>(
      `/v1/assets/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          revision: current.revision,
          metadata
        })
      }
    );

    runtime.set(id, {
      revision: response.asset.revision,
      metadata: response.asset.metadata ?? {}
    });

    return {
      saved: true,
      metadata: response.asset.metadata ?? {},
      persistence: response.persistence
    };
  } catch (error) {
    if (statusOf(error) === 409) {
      const remote = await fetchCloudBinaryAsset(id).catch(() => null);
      const refreshed = runtime.get(id);
      if (!refreshed) {
        return { saved: false, metadata, persistence: null };
      }

      const localStamp = String(metadata.annotationsUpdatedAt ?? "");
      const remoteStamp = String(remote?.metadata.annotationsUpdatedAt ?? "");

      if (remoteStamp.localeCompare(localStamp) > 0) {
        return {
          saved: true,
          metadata: remote?.metadata ?? {},
          persistence: remote?.persistence ?? null
        };
      }

      const response = await workspaceApi<CloudAssetResponse>(
        `/v1/assets/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            revision: refreshed.revision,
            metadata
          })
        }
      );

      runtime.set(id, {
        revision: response.asset.revision,
        metadata: response.asset.metadata ?? {}
      });

      return {
        saved: true,
        metadata: response.asset.metadata ?? {},
        persistence: response.persistence
      };
    }

    return { saved: false, metadata, persistence: null };
  }
}

export async function deleteCloudBinaryAsset(id: string) {
  try {
    await workspaceApi<{ deleted: boolean }>(
      `/v1/assets/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    runtime.delete(id);
    return true;
  } catch {
    return false;
  }
}
