import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  getWorkspaceIdentityAuthorization,
  resolveWorkspaceAuthorization
} from "./identity.js";
import { authenticateKoshOAuthAccessToken } from "./kosh-oauth-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";

const platformStore = getKoshPlatformStore();

const KOSH_NO_LOGIN_USER_ID = "kosh-no-login-owner";
const KOSH_NO_LOGIN_ORGANIZATION_ID = "kosh-no-login-organization";
const KOSH_NO_LOGIN_MEMBERSHIP_ID = "kosh-no-login-membership";
const KOSH_NO_LOGIN_SESSION_ID = "kosh-no-login-session";
const KOSH_NO_LOGIN_CREATED_AT = "2026-01-01T00:00:00.000Z";

function koshNoLoginEnabled() {
  const mode = (process.env.KOSH_AUTH_MODE ?? "").trim().toLowerCase();
  return mode === "none" || mode === "off" || mode === "disabled";
}

function koshNoLoginIdentity() {
  const now = new Date().toISOString();
  return {
    user: {
      id: KOSH_NO_LOGIN_USER_ID,
      email: "kosh-owner@local.invalid",
      displayName: "Kosh Owner",
      emailVerified: true,
      disabled: false,
      createdAt: KOSH_NO_LOGIN_CREATED_AT,
      updatedAt: now
    },
    session: {
      id: KOSH_NO_LOGIN_SESSION_ID,
      userId: KOSH_NO_LOGIN_USER_ID,
      tokenHash: "",
      createdAt: KOSH_NO_LOGIN_CREATED_AT,
      expiresAt: "9999-12-31T23:59:59.999Z",
      lastSeenAt: now,
      userAgent: null,
      ipHash: null,
      revokedAt: null
    },
    memberships: [
      {
        membership: {
          id: KOSH_NO_LOGIN_MEMBERSHIP_ID,
          userId: KOSH_NO_LOGIN_USER_ID,
          organizationId: KOSH_NO_LOGIN_ORGANIZATION_ID,
          role: "owner" as const,
          joinedAt: KOSH_NO_LOGIN_CREATED_AT,
          disabled: false
        },
        organization: {
          id: KOSH_NO_LOGIN_ORGANIZATION_ID,
          name: "Tamishra Kosh",
          slug: "tamishra",
          createdAt: KOSH_NO_LOGIN_CREATED_AT,
          updatedAt: now
        }
      }
    ],
    authType: "session" as const,
    apiToken: null
  };
}

export const koshApiScopeCatalog = [
  {
    id: "repo:read",
    name: "Repository read",
    description: "Read repositories and repository-scoped Kosh data available to the token owner."
  },
  {
    id: "repo:write",
    name: "Repository write",
    description: "Create or change repository-scoped Kosh data when the token owner also has the required repository role."
  },
  {
    id: "*",
    name: "Full API",
    description: "Allow every Kosh API scope granted to the token owner. Use only for trusted automation."
  }
] as const;

export type KoshApiScope = (typeof koshApiScopeCatalog)[number]["id"];

const koshApiScopeIds = new Set<string>(
  koshApiScopeCatalog.map((scope) => scope.id)
);

export function normalizeKoshApiScopes(value: unknown): KoshApiScope[] {
  const values = Array.isArray(value) ? value.map(String) : ["repo:read"];
  const unique = [...new Set(values.map((scope) => scope.trim()).filter(Boolean))];
  if (!unique.length) return ["repo:read"];
  const invalid = unique.find((scope) => !koshApiScopeIds.has(scope));
  if (invalid) {
    throw Object.assign(new Error("invalid_api_token_scope"), {
      status: 400,
      scope: invalid
    });
  }
  if (unique.includes("*")) return ["*"];
  // A writer must also be able to read the resources it changes.
  if (unique.includes("repo:write") && !unique.includes("repo:read")) {
    unique.unshift("repo:read");
  }
  return unique as KoshApiScope[];
}

export function koshApiTokenDefaultExpiry() {
  const configured = Number(process.env.KOSH_API_TOKEN_DEFAULT_DAYS ?? 90);
  const days = Number.isFinite(configured)
    ? Math.max(1, Math.min(365, configured))
    : 90;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function validateKoshApiTokenExpiry(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return koshApiTokenDefaultExpiry();
  }
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error("invalid_token_expiry"), { status: 400 });
  }
  const now = Date.now();
  if (date.getTime() <= now + 60_000) {
    throw Object.assign(new Error("token_expiry_must_be_future"), { status: 400 });
  }
  const configured = Number(process.env.KOSH_API_TOKEN_MAX_DAYS ?? 365);
  const maxDays = Number.isFinite(configured)
    ? Math.max(1, Math.min(3650, configured))
    : 365;
  if (date.getTime() > now + maxDays * 24 * 60 * 60 * 1000) {
    throw Object.assign(new Error("token_expiry_too_far"), {
      status: 400,
      maxDays
    });
  }
  return date.toISOString();
}

function bearerToken(request: IncomingMessage) {
  const authorization = request.headers.authorization?.trim() ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
}

function safeEqualText(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function oauthResourceRequestAllowed(request: IncomingMessage, resource: string) {
  const requestResource = String(request.headers["x-kosh-oauth-resource"] ?? "").trim();
  if (!requestResource || requestResource !== resource) return false;

  const expectedAssertion = process.env.KOSH_PLUGIN_ASSERTION_SECRET?.trim() ?? "";
  if (!expectedAssertion) return process.env.NODE_ENV !== "production";
  const actualAssertion = String(request.headers["x-kosh-plugin-assertion"] ?? "");
  return safeEqualText(actualAssertion, expectedAssertion);
}

export async function resolveKoshIdentity(
  request: IncomingMessage,
  requiredScope?: string
) {
  if (koshNoLoginEnabled()) {
    return koshNoLoginIdentity();
  }

  const sessionIdentity = await resolveWorkspaceAuthorization(request);
  if (sessionIdentity) {
    return {
      ...sessionIdentity,
      authType: "session" as const,
      apiToken: null
    };
  }

  const token = bearerToken(request);
  if (token.startsWith("kosh_oat_")) {
    const oauthAccess = await authenticateKoshOAuthAccessToken(token);
    if (!oauthAccess || !oauthResourceRequestAllowed(request, oauthAccess.resource)) return null;
    if (requiredScope && !oauthAccess.scopes.includes(requiredScope)) return null;

    const authorization = await getWorkspaceIdentityAuthorization(oauthAccess.userId);
    if (!authorization) return null;

    return {
      ...authorization,
      session: null,
      authType: "oauth-token" as const,
      apiToken: null,
      oauthAccess
    };
  }

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
