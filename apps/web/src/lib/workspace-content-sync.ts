"use client";

import { workspaceApi } from "./workspace-api";

export type WorkspaceContentNamespace = "notes" | "forms";

type CloudContentResponse = {
  persistence: "postgres" | "ephemeral-memory";
  revision: number;
  updatedAt: string | null;
  state: unknown;
};

type SyncRuntime = {
  revision: number | null;
  known: boolean;
  unauthenticated: boolean;
};

const runtimes = new Map<WorkspaceContentNamespace, SyncRuntime>();

function runtimeFor(namespace: WorkspaceContentNamespace) {
  let runtime = runtimes.get(namespace);
  if (!runtime) {
    runtime = {
      revision: null,
      known: false,
      unauthenticated: false
    };
    runtimes.set(namespace, runtime);
  }
  return runtime;
}

function statusOf(error: unknown) {
  return Number((error as { status?: number } | undefined)?.status ?? 0);
}

export async function hydrateWorkspaceContent<T>(
  namespace: WorkspaceContentNamespace,
  local: T,
  normalize: (value: unknown) => T,
  merge: (local: T, remote: T) => T
) {
  const runtime = runtimeFor(namespace);

  try {
    const remote = await workspaceApi<CloudContentResponse>(
      `/v1/content/${namespace}`,
      { cache: "no-store" }
    );

    runtime.revision = remote.revision;
    runtime.known = true;
    runtime.unauthenticated = false;

    return {
      state: merge(local, normalize(remote.state)),
      cloudAvailable: true,
      persistence: remote.persistence
    };
  } catch (error) {
    if (statusOf(error) === 401) {
      runtime.unauthenticated = true;
      runtime.known = true;
    }

    return {
      state: local,
      cloudAvailable: false,
      persistence: null
    };
  }
}

export async function pushWorkspaceContent<T>(
  namespace: WorkspaceContentNamespace,
  local: T,
  normalize: (value: unknown) => T,
  merge: (local: T, remote: T) => T,
  attempt = 0
): Promise<{
  state: T;
  cloudAvailable: boolean;
  persistence: "postgres" | "ephemeral-memory" | null;
}> {
  const runtime = runtimeFor(namespace);

  if (runtime.unauthenticated) {
    return {
      state: local,
      cloudAvailable: false,
      persistence: null
    };
  }

  if (!runtime.known) {
    const hydrated = await hydrateWorkspaceContent(
      namespace,
      local,
      normalize,
      merge
    );
    if (!hydrated.cloudAvailable) return hydrated;
    local = hydrated.state;
  }

  try {
    const saved = await workspaceApi<CloudContentResponse>(
      `/v1/content/${namespace}`,
      {
        method: "PUT",
        body: JSON.stringify({
          revision: runtime.revision,
          state: local
        })
      }
    );

    runtime.revision = saved.revision;
    runtime.known = true;
    runtime.unauthenticated = false;

    return {
      state: merge(local, normalize(saved.state)),
      cloudAvailable: true,
      persistence: saved.persistence
    };
  } catch (error) {
    const status = statusOf(error);

    if (status === 401) {
      runtime.unauthenticated = true;
      return {
        state: local,
        cloudAvailable: false,
        persistence: null
      };
    }

    if (status === 409 && attempt === 0) {
      runtime.known = false;
      const hydrated = await hydrateWorkspaceContent(
        namespace,
        local,
        normalize,
        merge
      );
      if (!hydrated.cloudAvailable) return hydrated;
      return pushWorkspaceContent(
        namespace,
        hydrated.state,
        normalize,
        merge,
        1
      );
    }

    return {
      state: local,
      cloudAvailable: false,
      persistence: null
    };
  }
}
