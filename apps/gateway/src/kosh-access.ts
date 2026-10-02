import type { IncomingMessage, ServerResponse } from "node:http";
import {
  koshHasPermission,
  koshPermissionsForRole,
  type KoshRepositoryPermission,
  type KoshRepositoryRole
} from "@tamishra/permissions";
import {
  getWorkspaceIdentityAuthorization,
  getWorkspaceIdentityUser
} from "./identity.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  getKoshAccessStore,
  type KoshAccessSubjectType,
  type KoshTeamMemberRole
} from "./kosh-access-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import {
  getKoshStore,
  type StoredKoshRepository
} from "./kosh-store.js";

const accessStore = getKoshAccessStore();
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();

type JsonBody = Record<string, unknown>;

export type KoshAccessIdentity = NonNullable<
  Awaited<ReturnType<typeof getWorkspaceIdentityAuthorization>>
>;

type KoshRequestIdentity = NonNullable<
  Awaited<ReturnType<typeof resolveKoshIdentity>>
>;

export type KoshAccessDecision = {
  allowed: boolean;
  role: KoshRepositoryRole | null;
  permission: KoshRepositoryPermission;
  source:
    | "public"
    | "user-grant"
    | "team-grant"
    | "organization"
    | "legacy"
    | "none";
  legacy: boolean;
  userId: string | null;
};

const roleRank: Record<KoshRepositoryRole, number> = {
  reader: 1,
  reviewer: 2,
  contributor: 3,
  maintainer: 4,
  owner: 5
};

const repositoryRoles = new Set<KoshRepositoryRole>([
  "owner",
  "maintainer",
  "contributor",
  "reviewer",
  "reader"
]);

const teamMemberRoles = new Set<KoshTeamMemberRole>([
  "maintainer",
  "member"
]);

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  allowedOrigins?: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins?.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 256 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function slug(value: unknown) {
  return clean(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function strongestRole(
  candidates: Array<{
    role: KoshRepositoryRole;
    source: KoshAccessDecision["source"];
  }>
) {
  return candidates.sort(
    (left, right) => roleRank[right.role] - roleRank[left.role]
  )[0] ?? null;
}

function requiredApiScope(permission: KoshRepositoryPermission) {
  return permission === "repository.read" ? "repo:read" : "repo:write";
}

function membershipForNamespace(
  identity: KoshAccessIdentity,
  namespace: string,
  organizationId: string | null
) {
  if (organizationId) {
    return identity.memberships.find(
      (item) => item.organization.id === organizationId
    ) ?? null;
  }

  return identity.memberships.find(
    (item) => item.organization.slug === namespace
  ) ?? null;
}

function organizationRole(
  membership: KoshAccessIdentity["memberships"][number] | null,
  repository: StoredKoshRepository
): KoshRepositoryRole | null {
  if (!membership || membership.membership.disabled) return null;

  if (membership.membership.role === "owner") return "owner";
  if (membership.membership.role === "admin") return "maintainer";

  if (
    membership.membership.role === "member" &&
    repository.visibility === "internal"
  ) {
    return "reader";
  }

  return null;
}

function legacyMode() {
  const configured = process.env.KOSH_ACCESS_LEGACY_MODE?.trim().toLowerCase();
  if (configured === "authenticated" || configured === "deny") {
    return configured;
  }
  return process.env.NODE_ENV === "production" ? "deny" : "authenticated";
}

export async function evaluateKoshRepositoryAccess(
  identity: KoshAccessIdentity | null,
  repository: StoredKoshRepository,
  permission: KoshRepositoryPermission
): Promise<KoshAccessDecision> {
  await accessStore.ready();

  if (
    !identity &&
    repository.visibility === "public" &&
    permission === "repository.read"
  ) {
    return {
      allowed: true,
      role: "reader",
      permission,
      source: "public",
      legacy: false,
      userId: null
    };
  }

  if (!identity) {
    return {
      allowed: false,
      role: null,
      permission,
      source: "none",
      legacy: false,
      userId: null
    };
  }

  const [binding, grants, userTeams] = await Promise.all([
    accessStore.getNamespaceBinding(repository.namespace),
    accessStore.listRepositoryGrants(repository.id),
    accessStore.listUserTeams(identity.user.id)
  ]);

  const candidates: Array<{
    role: KoshRepositoryRole;
    source: KoshAccessDecision["source"];
  }> = [];

  const userGrant = grants.find(
    (grant) =>
      grant.subjectType === "user" &&
      grant.subjectId === identity.user.id
  );
  if (userGrant) {
    candidates.push({ role: userGrant.role, source: "user-grant" });
  }

  const teamIds = new Set(userTeams.map((membership) => membership.teamId));
  for (const grant of grants) {
    if (grant.subjectType === "team" && teamIds.has(grant.subjectId)) {
      candidates.push({ role: grant.role, source: "team-grant" });
    }
  }

  const organizationMembership = membershipForNamespace(
    identity,
    repository.namespace,
    binding?.organizationId ?? null
  );
  const inheritedRole = organizationRole(
    organizationMembership,
    repository
  );
  if (inheritedRole) {
    candidates.push({ role: inheritedRole, source: "organization" });
  }

  const effective = strongestRole(candidates);

  if (effective) {
    return {
      allowed: koshHasPermission(effective.role, permission),
      role: effective.role,
      permission,
      source: effective.source,
      legacy: false,
      userId: identity.user.id
    };
  }

  const isLegacyRepository = !binding && grants.length === 0;
  if (isLegacyRepository && legacyMode() === "authenticated") {
    const role: KoshRepositoryRole = "maintainer";
    return {
      allowed: koshHasPermission(role, permission),
      role,
      permission,
      source: "legacy",
      legacy: true,
      userId: identity.user.id
    };
  }

  if (
    repository.visibility === "public" &&
    permission === "repository.read"
  ) {
    return {
      allowed: true,
      role: "reader",
      permission,
      source: "public",
      legacy: false,
      userId: identity.user.id
    };
  }

  return {
    allowed: false,
    role: null,
    permission,
    source: "none",
    legacy: isLegacyRepository,
    userId: identity.user.id
  };
}

export async function authorizeKoshRepositoryRequest(
  request: IncomingMessage,
  repository: StoredKoshRepository,
  permission: KoshRepositoryPermission
) {
  const identity = await resolveKoshIdentity(
    request,
    requiredApiScope(permission)
  );
  const decision = await evaluateKoshRepositoryAccess(
    identity,
    repository,
    permission
  );
  return { identity, decision };
}

export async function authorizeKoshPersonalToken(
  token: string,
  repository: StoredKoshRepository,
  permission: KoshRepositoryPermission
) {
  if (!token.startsWith("kosh_pat_")) {
    return {
      identity: null,
      decision: {
        allowed: false,
        role: null,
        permission,
        source: "none",
        legacy: false,
        userId: null
      } satisfies KoshAccessDecision
    };
  }

  await platformStore.ready();
  const apiToken = await platformStore.authenticateApiToken(token);
  if (!apiToken) {
    return {
      identity: null,
      decision: {
        allowed: false,
        role: null,
        permission,
        source: "none",
        legacy: false,
        userId: null
      } satisfies KoshAccessDecision
    };
  }

  const scope = requiredApiScope(permission);
  if (
    !apiToken.scopes.includes("*") &&
    !apiToken.scopes.includes(scope)
  ) {
    return {
      identity: null,
      decision: {
        allowed: false,
        role: null,
        permission,
        source: "none",
        legacy: false,
        userId: apiToken.userId
      } satisfies KoshAccessDecision
    };
  }

  const authorization = await getWorkspaceIdentityAuthorization(apiToken.userId);
  if (!authorization) {
    return {
      identity: null,
      decision: {
        allowed: false,
        role: null,
        permission,
        source: "none",
        legacy: false,
        userId: apiToken.userId
      } satisfies KoshAccessDecision
    };
  }

  const identity: KoshRequestIdentity = {
    ...authorization,
    session: null,
    authType: "api-token",
    apiToken
  };

  return {
    identity,
    decision: await evaluateKoshRepositoryAccess(
      identity,
      repository,
      permission
    )
  };
}

export function permissionForKoshRepositoryRequest(
  url: URL,
  method: string
): KoshRepositoryPermission {
  const path = url.pathname;
  const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  if (!mutating) return "repository.read";

  if (/\/change-requests\/\d+\/reviews$/.test(path)) {
    return "repository.review";
  }

  if (
    /\/change-requests\/\d+\/merge$/.test(path) ||
    path.endsWith("/merge-queue/process")
  ) {
    return "repository.merge";
  }

  if (
    /\/policies\//.test(path) ||
    /\/access(?:\/|$)/.test(path)
  ) {
    return "repository.manage";
  }

  if (/\/automation\//.test(path)) {
    if (/\/workflows\/[^/]+\/runs$/.test(path)) {
      return "automation.run";
    }
    return "automation.manage";
  }

  if (/\/platform\/packages$/.test(path)) {
    return "packages.publish";
  }

  if (/\/platform\/releases\//.test(path)) {
    return "releases.manage";
  }

  if (/\/platform\/secrets(?:\/|$)/.test(path)) {
    return "security.manage";
  }

  return "repository.write";
}

export async function listKoshRepositoriesVisibleTo(
  identity: KoshAccessIdentity
) {
  const repositories = await repositoryStore.list();
  const visible: Array<{
    repository: StoredKoshRepository;
    access: KoshAccessDecision;
  }> = [];

  for (const repository of repositories) {
    const access = await evaluateKoshRepositoryAccess(
      identity,
      repository,
      "repository.read"
    );
    if (access.allowed) {
      visible.push({ repository, access });
    }
  }

  return visible;
}

export async function ensureKoshNamespaceForCreation(
  identity: KoshAccessIdentity,
  namespace: string
) {
  await accessStore.ready();

  const current = await accessStore.getNamespaceBinding(namespace);
  if (current) {
    const membership = identity.memberships.find(
      (item) => item.organization.id === current.organizationId
    );
    if (
      !membership ||
      !["owner", "admin"].includes(membership.membership.role)
    ) {
      throw Object.assign(new Error("namespace_admin_required"), {
        status: 403
      });
    }
    return current;
  }

  const direct = identity.memberships.find(
    (item) =>
      item.organization.slug === namespace &&
      ["owner", "admin"].includes(item.membership.role)
  );

  const candidates = identity.memberships.filter(
    (item) => ["owner", "admin"].includes(item.membership.role)
  );
  const selected = direct ?? (candidates.length === 1 ? candidates[0] : null);

  if (!selected) {
    throw Object.assign(new Error("namespace_binding_required"), {
      status: 409
    });
  }

  return accessStore.bindNamespace({
    namespace,
    organizationId: selected.organization.id,
    createdByUserId: identity.user.id,
    createdByName: identity.user.displayName
  });
}

export async function koshNamespaceAuthority(
  identity: KoshAccessIdentity,
  namespace: string
) {
  const binding = await accessStore.getNamespaceBinding(namespace);
  const membership = membershipForNamespace(
    identity,
    namespace,
    binding?.organizationId ?? null
  );

  return {
    binding,
    membership,
    canManage:
      Boolean(membership) &&
      (membership!.membership.role === "owner" ||
        membership!.membership.role === "admin")
  };
}

export async function bootstrapKoshRepositoryOwner(
  repositoryId: string,
  identity: KoshAccessIdentity
) {
  await accessStore.ready();
  const grants = await accessStore.listRepositoryGrants(repositoryId);
  if (grants.length > 0) return grants;

  await accessStore.putRepositoryGrant({
    repositoryId,
    subjectType: "user",
    subjectId: identity.user.id,
    role: "owner",
    createdByUserId: identity.user.id,
    createdByName: identity.user.displayName
  });

  return accessStore.listRepositoryGrants(repositoryId);
}

function routeError(
  response: ServerResponse,
  error: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;

  sendJson(
    response,
    status,
    {
      error:
        error instanceof Error ? error.message : "kosh_access_error"
    },
    origin,
    allowedOrigins
  );
}

export async function handleKoshAccessRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const globalAccessRoute = url.pathname.startsWith("/v1/kosh/access");
  const repositoryMatch = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/access(.*)$/
  );

  if (!globalAccessRoute && !repositoryMatch) return false;

  const identity = await resolveKoshIdentity(
    request,
    request.method === "GET" ? "repo:read" : "repo:write"
  );
  if (!identity) {
    sendJson(
      response,
      401,
      { error: "authentication_required" },
      origin,
      allowedOrigins
    );
    return true;
  }

  try {
    await accessStore.ready();

    if (repositoryMatch) {
      const namespace = repositoryMatch[1];
      const repositorySlug = repositoryMatch[2];
      const tail = repositoryMatch[3] || "";
      const repository = await repositoryStore.get(namespace, repositorySlug);

      if (!repository) {
        throw Object.assign(new Error("repository_not_found"), { status: 404 });
      }

      const access = await evaluateKoshRepositoryAccess(
        identity,
        repository,
        "repository.read"
      );
      if (!access.allowed) {
        throw Object.assign(new Error("repository_access_denied"), {
          status: 403
        });
      }

      const permissions = access.role
        ? [...koshPermissionsForRole(access.role)]
        : [];

      if (request.method === "GET" && (tail === "" || tail === "/me")) {
        const canManage = access.role
          ? koshHasPermission(access.role, "access.manage")
          : false;
        const namespaceAccess = await koshNamespaceAuthority(
          identity,
          namespace
        );
        const [grants, teams, binding] = canManage
          ? await Promise.all([
              accessStore.listRepositoryGrants(repository.id),
              accessStore.listTeams(namespace),
              accessStore.getNamespaceBinding(namespace)
            ])
          : [[], [], null];

        const hydratedTeams = namespaceAccess.canManage
          ? await Promise.all(
              teams.map(async (team) => ({
                ...team,
                members: await accessStore.listTeamMembers(team.id)
              }))
            )
          : teams.map((team) => ({ ...team, members: [] }));

        sendJson(
          response,
          200,
          {
            repository: {
              id: repository.id,
              namespace: repository.namespace,
              slug: repository.slug,
              visibility: repository.visibility
            },
            role: access.role,
            source: access.source,
            legacy: access.legacy,
            permissions,
            namespaceAdmin: namespaceAccess.canManage,
            binding,
            grants,
            teams: hydratedTeams
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (
        tail === "/grants" &&
        request.method === "POST"
      ) {
        if (!access.role || !koshHasPermission(access.role, "access.manage")) {
          throw Object.assign(new Error("access_manage_required"), {
            status: 403
          });
        }

        const body = await readJson(request);
        const subjectType = clean(
          body.subjectType,
          20
        ) as KoshAccessSubjectType;
        const subjectId = clean(body.subjectId, 240);
        const role = clean(body.role, 40) as KoshRepositoryRole;

        if (
          !["user", "team"].includes(subjectType) ||
          !subjectId ||
          !repositoryRoles.has(role)
        ) {
          throw Object.assign(new Error("invalid_repository_grant"), {
            status: 400
          });
        }

        if (subjectType === "user") {
          const user = await getWorkspaceIdentityUser(subjectId);
          if (!user) {
            throw Object.assign(new Error("grant_user_not_found"), {
              status: 404
            });
          }
        } else {
          const team = await accessStore.getTeam(subjectId);
          if (!team || team.namespace !== namespace) {
            throw Object.assign(new Error("grant_team_not_found"), {
              status: 404
            });
          }
        }

        const grant = await accessStore.putRepositoryGrant({
          repositoryId: repository.id,
          subjectType,
          subjectId,
          role,
          createdByUserId: identity.user.id,
          createdByName: identity.user.displayName
        });

        await platformStore.appendAudit({
          repositoryId: repository.id,
          actorUserId: identity.user.id,
          actorName: identity.user.displayName,
          eventType: "repository_access_grant_updated",
          resourceType: "repository_access",
          resourceId: grant.id,
          metadata: {
            subjectType,
            subjectId,
            role
          }
        });

        sendJson(response, 201, grant, origin, allowedOrigins);
        return true;
      }

      const grantMatch = tail.match(/^\/grants\/([^/]+)$/);
      if (grantMatch && request.method === "DELETE") {
        if (!access.role || !koshHasPermission(access.role, "access.manage")) {
          throw Object.assign(new Error("access_manage_required"), {
            status: 403
          });
        }

        const grantId = decodeURIComponent(grantMatch[1]);
        const currentGrants = await accessStore.listRepositoryGrants(
          repository.id
        );
        const targetGrant = currentGrants.find(
          (grant) => grant.id === grantId
        );
        if (!targetGrant) {
          throw Object.assign(new Error("repository_grant_not_found"), {
            status: 404
          });
        }

        const binding = await accessStore.getNamespaceBinding(namespace);
        const explicitOwners = currentGrants.filter(
          (grant) => grant.role === "owner"
        );
        if (
          !binding &&
          targetGrant.role === "owner" &&
          explicitOwners.length <= 1
        ) {
          throw Object.assign(new Error("last_repository_owner_required"), {
            status: 409
          });
        }

        const deleted = await accessStore.deleteRepositoryGrant(
          repository.id,
          grantId
        );
        if (!deleted) {
          throw Object.assign(new Error("repository_grant_not_found"), {
            status: 404
          });
        }

        sendJson(
          response,
          200,
          { deleted: true },
          origin,
          allowedOrigins
        );
        return true;
      }

      sendJson(
        response,
        404,
        { error: "kosh_access_route_not_found" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const namespaceBindMatch = url.pathname.match(
      /^\/v1\/kosh\/access\/namespaces\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/bind$/
    );
    if (namespaceBindMatch && request.method === "POST") {
      if (identity.authType !== "session") {
        throw Object.assign(new Error("interactive_session_required"), {
          status: 403
        });
      }

      const namespace = namespaceBindMatch[1];
      const body = await readJson(request);
      const organizationId = clean(body.organizationId, 240);
      const membership = identity.memberships.find(
        (item) => item.organization.id === organizationId
      );

      if (
        !membership ||
        !["owner", "admin"].includes(membership.membership.role)
      ) {
        throw Object.assign(
          new Error("organization_admin_required"),
          { status: 403 }
        );
      }

      const binding = await accessStore.bindNamespace({
        namespace,
        organizationId,
        createdByUserId: identity.user.id,
        createdByName: identity.user.displayName
      });

      await platformStore.appendAudit({
        repositoryId: null,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "kosh_namespace_bound",
        resourceType: "namespace",
        resourceId: namespace,
        metadata: { organizationId }
      });

      sendJson(response, 201, binding, origin, allowedOrigins);
      return true;
    }

    if (
      url.pathname === "/v1/kosh/access/summary" &&
      request.method === "GET"
    ) {
      const visible = await listKoshRepositoriesVisibleTo(identity);
      const organizationIds = new Set(
        identity.memberships.map((item) => item.organization.id)
      );
      const bindings = (await accessStore.listNamespaceBindings()).filter(
        (binding) => organizationIds.has(binding.organizationId)
      );
      sendJson(
        response,
        200,
        {
          repositories: visible.map((item) => ({
            ...item.repository,
            access: item.access
          })),
          organizations: identity.memberships,
          bindings,
          legacyMode: legacyMode(),
          persistence: accessStore.kind
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      url.pathname === "/v1/kosh/access/teams" &&
      request.method === "GET"
    ) {
      const namespace = clean(url.searchParams.get("namespace"), 64);
      if (!namespace) {
        throw Object.assign(new Error("namespace_required"), { status: 400 });
      }
      const authority = await koshNamespaceAuthority(identity, namespace);
      if (!authority.canManage) {
        throw Object.assign(new Error("namespace_admin_required"), {
          status: 403
        });
      }

      const teams = await accessStore.listTeams(namespace);
      const hydrated = await Promise.all(
        teams.map(async (team) => ({
          ...team,
          members: await accessStore.listTeamMembers(team.id)
        }))
      );

      sendJson(
        response,
        200,
        { teams: hydrated },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      url.pathname === "/v1/kosh/access/teams" &&
      request.method === "POST"
    ) {
      const body = await readJson(request);
      const namespace = clean(body.namespace, 64);
      const teamSlug = slug(body.slug || body.name);
      const name = clean(body.name, 160);

      if (!namespace || !teamSlug || !name) {
        throw Object.assign(new Error("invalid_team"), { status: 400 });
      }

      const authority = await koshNamespaceAuthority(identity, namespace);
      if (!authority.canManage) {
        throw Object.assign(new Error("namespace_admin_required"), {
          status: 403
        });
      }

      const team = await accessStore.createTeam({
        namespace,
        slug: teamSlug,
        name,
        description: clean(body.description, 1000),
        createdByUserId: identity.user.id,
        createdByName: identity.user.displayName
      });

      await accessStore.putTeamMember({
        teamId: team.id,
        userId: identity.user.id,
        role: "maintainer",
        addedByUserId: identity.user.id,
        addedByName: identity.user.displayName
      });

      sendJson(response, 201, team, origin, allowedOrigins);
      return true;
    }

    const teamMatch = url.pathname.match(
      /^\/v1\/kosh\/access\/teams\/([^/]+)$/
    );
    if (teamMatch && request.method === "DELETE") {
      const team = await accessStore.getTeam(
        decodeURIComponent(teamMatch[1])
      );
      if (!team) {
        throw Object.assign(new Error("team_not_found"), { status: 404 });
      }

      const authority = await koshNamespaceAuthority(identity, team.namespace);
      if (!authority.canManage) {
        throw Object.assign(new Error("namespace_admin_required"), {
          status: 403
        });
      }

      const deleted = await accessStore.deleteTeam(team.id);
      sendJson(response, 200, { deleted }, origin, allowedOrigins);
      return true;
    }

    const memberMatch = url.pathname.match(
      /^\/v1\/kosh\/access\/teams\/([^/]+)\/members(?:\/([^/]+))?$/
    );
    if (memberMatch) {
      const team = await accessStore.getTeam(
        decodeURIComponent(memberMatch[1])
      );
      if (!team) {
        throw Object.assign(new Error("team_not_found"), { status: 404 });
      }

      const authority = await koshNamespaceAuthority(identity, team.namespace);
      if (!authority.canManage) {
        throw Object.assign(new Error("namespace_admin_required"), {
          status: 403
        });
      }

      if (request.method === "GET" && !memberMatch[2]) {
        sendJson(
          response,
          200,
          { members: await accessStore.listTeamMembers(team.id) },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (request.method === "POST" && !memberMatch[2]) {
        const body = await readJson(request);
        const userId = clean(body.userId, 240);
        const role = clean(body.role, 30) as KoshTeamMemberRole;
        if (!userId || !teamMemberRoles.has(role)) {
          throw Object.assign(new Error("invalid_team_member"), {
            status: 400
          });
        }

        const target = await getWorkspaceIdentityAuthorization(userId);
        if (!target) {
          throw Object.assign(new Error("team_user_not_found"), {
            status: 404
          });
        }

        const binding = await accessStore.getNamespaceBinding(team.namespace);
        if (binding) {
          const belongs = target.memberships.some(
            (item) => item.organization.id === binding.organizationId
          );
          if (!belongs) {
            throw Object.assign(
              new Error("team_user_outside_namespace_organization"),
              { status: 409 }
            );
          }
        }

        const member = await accessStore.putTeamMember({
          teamId: team.id,
          userId,
          role,
          addedByUserId: identity.user.id,
          addedByName: identity.user.displayName
        });

        sendJson(response, 201, member, origin, allowedOrigins);
        return true;
      }

      if (request.method === "DELETE" && memberMatch[2]) {
        const deleted = await accessStore.deleteTeamMember(
          team.id,
          decodeURIComponent(memberMatch[2])
        );
        if (!deleted) {
          throw Object.assign(new Error("team_member_not_found"), {
            status: 404
          });
        }
        sendJson(
          response,
          200,
          { deleted: true },
          origin,
          allowedOrigins
        );
        return true;
      }
    }

    sendJson(
      response,
      404,
      { error: "kosh_access_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
