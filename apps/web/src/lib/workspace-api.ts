const configuredBase =
  process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
  process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
  "/api/workspace";

export const workspaceApiBase = configuredBase.replace(/\/$/, "");

export async function workspaceApi<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(
    workspaceApiBase + (path.startsWith("/") ? path : "/" + path),
    {
      ...init,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {})
      }
    }
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      typeof body?.error === "string" ? body.error : "workspace_request_failed"
    ) as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = typeof body?.error === "string" ? body.error : undefined;
    throw error;
  }

  return body as T;
}

export type WorkspaceSessionResponse =
  | { authenticated: false }
  | {
      authenticated: true;
      user: {
        id: string;
        email: string;
        displayName: string;
        emailVerified: boolean;
      };
      session: {
        id: string;
        createdAt: string;
        expiresAt: string;
        lastSeenAt: string;
        current: boolean;
      };
      memberships: Array<{
        membership: {
          id: string;
          organizationId: string;
          role: "owner" | "admin" | "member" | "guest";
        };
        organization: {
          id: string;
          name: string;
          slug: string;
        };
      }>;
      persistence: "postgres" | "ephemeral-memory";
    };
