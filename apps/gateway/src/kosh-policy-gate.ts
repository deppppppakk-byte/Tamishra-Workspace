import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { evaluateKoshPolicy, type KoshPolicyTarget } from "./kosh-policy-engine.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();

type GatePermission = "repository.merge" | "releases.manage";

type GateSpec = {
  target: KoshPolicyTarget;
  action: string;
  permission: GatePermission;
  namespace: string;
  slug: string;
  resourceId?: string;
  context: Record<string, unknown>;
};

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

function repositoryRoute(pathname: string) {
  const match = pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})(\/.*)?$/
  );
  return match
    ? { namespace: match[1], slug: match[2], tail: match[3] ?? "" }
    : null;
}

function gateSpec(request: IncomingMessage, pathname: string): GateSpec | null {
  if (request.method !== "POST") return null;
  const route = repositoryRoute(pathname);
  if (!route) return null;

  const directMerge = route.tail.match(/^\/change-requests\/(\d+)\/merge$/);
  if (directMerge) {
    return {
      target: "merge",
      action: "merge.execute",
      permission: "repository.merge",
      namespace: route.namespace,
      slug: route.slug,
      context: {
        operation: "direct_merge",
        changeRequestNumber: Number(directMerge[1])
      }
    };
  }

  if (route.tail === "/merge-queue/process") {
    return {
      target: "merge",
      action: "merge.queue.process",
      permission: "repository.merge",
      namespace: route.namespace,
      slug: route.slug,
      context: { operation: "merge_queue_process" }
    };
  }

  const deployment = route.tail.match(
    /^\/systems\/deployments\/requests\/([^/]+)\/execute$/
  );
  if (deployment) {
    return {
      target: "deployment",
      action: "deployment.execute",
      permission: "releases.manage",
      namespace: route.namespace,
      slug: route.slug,
      resourceId: decodeURIComponent(deployment[1]),
      context: { operation: "deployment_execute" }
    };
  }

  return null;
}

async function authorize(request: IncomingMessage, spec: GateSpec) {
  const repository = await repositoryStore.get(spec.namespace, spec.slug);
  if (!repository) {
    throw Object.assign(new Error("repository_not_found"), { status: 404 });
  }
  const authorization = await authorizeKoshRepositoryRequest(
    request,
    repository,
    spec.permission
  );
  if (!authorization.identity || !authorization.decision.allowed) {
    throw Object.assign(
      new Error(
        authorization.identity
          ? "repository_permission_denied"
          : "authentication_required"
      ),
      { status: authorization.identity ? 403 : 401 }
    );
  }
  return { repository, authorization };
}

async function hydrateContext(
  repository: StoredKoshRepository,
  spec: GateSpec,
  role: string | null
) {
  const context: Record<string, unknown> = {
    ...spec.context,
    repository: {
      id: repository.id,
      namespace: repository.namespace,
      slug: repository.slug,
      visibility: repository.visibility,
      defaultBranch: repository.defaultBranch
    },
    actor: { role }
  };

  if (spec.resourceId && spec.target === "deployment") {
    const resource = await platformStore.getResource(spec.resourceId);
    if (
      !resource ||
      resource.repositoryId !== repository.id ||
      resource.type !== "deployment_policy" ||
      resource.payload.kind !== "request"
    ) {
      throw Object.assign(new Error("deployment_request_not_found"), {
        status: 404
      });
    }
    const approvals = Array.isArray(resource.payload.approvals)
      ? resource.payload.approvals.length
      : 0;
    const requiredApprovals = Math.max(
      0,
      Number(resource.payload.requiredApprovals) || 0
    );
    context.deployment = {
      requestId: resource.id,
      state: resource.state,
      environment: String(resource.payload.environmentName ?? ""),
      commitSha: String(resource.payload.commitSha ?? ""),
      refName: String(resource.payload.refName ?? ""),
      releaseId: resource.payload.releaseId ?? null,
      approvalCount: approvals,
      requiredApprovals,
      approved: approvals >= requiredApprovals
    };
    context.environment = String(resource.payload.environmentName ?? "");
    context.approved = approvals >= requiredApprovals;
  }

  return context;
}

async function appendGateAudit(input: {
  repositoryId: string;
  actorUserId: string;
  actorName: string;
  target: string;
  action: string;
  decision: string;
  matched: number;
  blocking: number;
}) {
  await platformStore.appendAudit({
    repositoryId: input.repositoryId,
    actorUserId: input.actorUserId,
    actorName: input.actorName,
    eventType: "policy_gate_evaluated",
    resourceType: "policy",
    resourceId: null,
    metadata: {
      target: input.target,
      action: input.action,
      decision: input.decision,
      matched: input.matched,
      blocking: input.blocking
    }
  });
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
    { error: error instanceof Error ? error.message : "kosh_policy_gate_error" },
    origin,
    allowedOrigins
  );
}

export async function handleKoshPolicyGate(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const spec = gateSpec(request, url.pathname);
  if (!spec) return false;

  try {
    await platformStore.ready();
    const { repository, authorization } = await authorize(request, spec);
    const identity = authorization.identity!;
    const context = await hydrateContext(
      repository,
      spec,
      authorization.decision.role ?? null
    );
    const result = await evaluateKoshPolicy({
      repositoryId: repository.id,
      target: spec.target,
      action: spec.action,
      context,
      includeGlobal: true
    });

    await appendGateAudit({
      repositoryId: repository.id,
      actorUserId: identity.user.id,
      actorName: identity.user.displayName,
      target: spec.target,
      action: spec.action,
      decision: result.decision,
      matched: result.matched.length,
      blocking: result.blocking.length
    });

    if (result.decision === "deny" || result.decision === "require") {
      sendJson(
        response,
        result.decision === "deny" ? 403 : 409,
        {
          error:
            result.decision === "deny"
              ? "policy_denied"
              : "policy_requirement_unmet",
          policy: result
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    return false;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
