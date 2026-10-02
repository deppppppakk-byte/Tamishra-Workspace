import type { IncomingMessage } from "node:http";
import {
  getWorkspaceIdentityAuthorization,
  resolveWorkspaceAuthorization
} from "./identity.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";

const platformStore = getKoshPlatformStore();

function bearerToken(request: IncomingMessage) {
  const authorization = request.headers.authorization?.trim() ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
}

export async function resolveKoshIdentity(
  request: IncomingMessage,
  requiredScope?: string
) {
  const sessionIdentity = await resolveWorkspaceAuthorization(request);
  if (sessionIdentity) {
    return {
      ...sessionIdentity,
      authType: "session" as const,
      apiToken: null
    };
  }

  const token = bearerToken(request);
  if (!token.startsWith("kosh_pat_")) return null;

  await platformStore.ready();
  const apiToken = await platformStore.authenticateApiToken(token);
  if (!apiToken) return null;

  if (
    requiredScope &&
    !apiToken.scopes.includes("*") &&
    !apiToken.scopes.includes(requiredScope)
  ) {
    return null;
  }

  const authorization = await getWorkspaceIdentityAuthorization(apiToken.userId);
  if (!authorization) return null;

  return {
    ...authorization,
    session: null,
    authType: "api-token" as const,
    apiToken
  };
}
