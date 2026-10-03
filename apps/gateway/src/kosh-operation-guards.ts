import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshPlatformStore, type StoredKoshPlatformResource } from "./kosh-platform-store.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const platformStore = getKoshPlatformStore();
const repositoryStore = getKoshStore();

type GuardMode = "once" | "lease";
type GuardPermission = "repository.merge" | "releases.manage" | "repository.manage";
type GuardSpec = {
  operation: string;
  semanticKey: string;
  mode: GuardMode;
  permission: GuardPermission;
};

type RequestIdentity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;
type GuardContext = {
  repository: StoredKoshRepository;
  identity: RequestIdentity;
  guard: StoredKoshPlatformResource;
  spec: GuardSpec;
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

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function requestHeader(request: IncomingMessage, name: string) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0]?.trim() ?? "" : String(value ?? "").trim();
}

function guardSpec(pathname: string): GuardSpec | null {
  const execute = pathname.match(
    /^\/v1\/kosh\/repos\/[^/]+\/[^/]+\/systems\/deployments\/requests\/([^/]+)\/execute$/
  );
  if (execute) {
    return {
      operation: "deployment.execute",
      semanticKey: "deployment-execute:" + decodeURIComponent(execute[1]),
      mode: "once",
      permission: "releases.manage"
    };
  }

  const restore = pathname.match(
    /^\/v1\/kosh\/repos\/[^/]+\/[^/]+\/systems\/recovery\/backups\/([^/]+)\/activate$/
  );
  if (restore) {
    return {
      operation: "recovery.activate",
      semanticKey: "recovery-activate:" + decodeURIComponent(restore[1]),
      mode: "once",
      permission: "repository.manage"
    };
  }

  if (/^\/v1\/kosh\/repos\/[^/]+\/[^/]+\/merge-queue\/process$/.test(pathname)) {
    return {
      operation: "merge-queue.process",
      semanticKey: "merge-queue-process",
      mode: "lease",
      permission: "repository.merge"
    };
  }

  return null;
}

function idempotencyFingerprint(request: IncomingMessage) {
  const idempotency = clean(requestHeader(request, "idempotency-key"), 160);
  if (!idempotency) return null;
  if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotency)) {
    throw Object.assign(new Error("invalid_idempotency_key"), { status: 400 });
  }
  return createHash("sha256").update(idempotency).digest("hex").slice(0, 24);
}

function operationKey(spec: GuardSpec) {
  return "operation:" + createHash("sha256")
    .update(spec.semanticKey)
    .digest("hex")
    .slice(0, 40);
}

function repositoryRoute(pathname: string) {
  const match = pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})(?:\/|$)/
  );
  return match ? { namespace: match[1], slug: match[2] } : null;
}

async function authorize(
  request: IncomingMessage,
  namespace: string,
  slug: string,
  permission: GuardPermission
) {
  const repository = await repositoryStore.get(namespace, slug);
  if (!repository) {
    throw Object.assign(new Error("repository_not_found"), { status: 404 });
  }
  const authorization = await authorizeKoshRepositoryRequest(request, repository, permission);
  if (!authorization.identity || !authorization.decision.allowed) {
    throw Object.assign(
      new Error(authorization.identity ? "repository_permission_denied" : "authentication_required"),
      { status: authorization.identity ? 403 : 401 }
    );
  }
  return { repository, identity: authorization.identity };
}

async function audit(
  repositoryId: string,
  actor: { id: string; displayName: string },
  eventType: string,
  guard: StoredKoshPlatformResource,
  metadata: Record<string, unknown> = {}
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType: "operation_guard",
    resourceId: guard.id,
    metadata
  });
}

function leaseExpiry() {
  const configured = Number(process.env.KOSH_OPERATION_GUARD_LEASE_SECONDS ?? 300);
  const seconds = Number.isFinite(configured)
    ? Math.max(30, Math.min(3600, Math.floor(configured)))
    : 300;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function guardExpired(guard: StoredKoshPlatformResource) {
  const expires = Date.parse(String(guard.payload.expiresAt ?? ""));
  return Number.isFinite(expires) && expires <= Date.now();
}

async function createGuard(
  request: IncomingMessage,
  repository: StoredKoshRepository,
  identity: RequestIdentity,
  spec: GuardSpec
) {
  const key = operationKey(spec);
  const idempotencyKeyHash = idempotencyFingerprint(request);
  const make = () => platformStore.createResource({
    repositoryId: repository.id,
    namespace: repository.namespace,
    type: "deployment_policy",
    key,
    name: "Operation guard: " + spec.operation,
    state: "processing",
    payload: {
      kind: "operation_guard",
      operation: spec.operation,
      semanticKey: spec.semanticKey,
      mode: spec.mode,
      requestId: randomUUID(),
      idempotencyKeyHash,
      acquiredAt: new Date().toISOString(),
      expiresAt: leaseExpiry()
    },
    createdByUserId: identity.user.id,
    createdByName: identity.user.displayName
  });

  try {
    return await make();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "platform_resource_exists") throw error;
  }

  const existing = (await platformStore.listResources("deployment_policy", repository.id))
    .find((item) => item.key === key && item.payload.kind === "operation_guard");
  if (!existing) {
    throw Object.assign(new Error("operation_guard_conflict"), { status: 409 });
  }

  if (existing.state === "completed" && spec.mode === "once") {
    throw Object.assign(new Error("operation_already_completed"), {
      status: 409,
      operationId: existing.id
    });
  }

  if (existing.state === "processing" && !guardExpired(existing)) {
    throw Object.assign(new Error("operation_in_progress"), {
      status: 423,
      operationId: existing.id
    });
  }

  if (spec.mode === "once") {
    throw Object.assign(new Error("operation_state_uncertain"), {
      status: 409,
      operationId: existing.id
    });
  }

  await platformStore.deleteResource(existing.id);
  try {
    return await make();
  } catch (error) {
    if (error instanceof Error && error.message === "platform_resource_exists") {
      throw Object.assign(new Error("operation_in_progress"), { status: 423 });
    }
    throw error;
  }
}

async function acquireGuard(request: IncomingMessage, spec: GuardSpec): Promise<GuardContext> {
  const url = new URL(request.url ?? "/", "http://kosh.local");
  const route = repositoryRoute(url.pathname);
  if (!route) throw Object.assign(new Error("repository_not_found"), { status: 404 });
  await platformStore.ready();
  const { repository, identity } = await authorize(request, route.namespace, route.slug, spec.permission);
  const guard = await createGuard(request, repository, identity, spec);
  await audit(repository.id, identity.user, "operation_guard_acquired", guard, {
    operation: spec.operation,
    semanticKey: spec.semanticKey,
    mode: spec.mode
  });
  return { repository, identity, guard, spec };
}

async function finalizeGuard(context: GuardContext, statusCode: number) {
  const { guard, repository, identity, spec } = context;
  if (spec.mode === "lease") {
    await platformStore.deleteResource(guard.id).catch(() => false);
    await audit(repository.id, identity.user, "operation_guard_released", guard, {
      operation: spec.operation,
      statusCode
    });
    return;
  }

  if (statusCode >= 200 && statusCode < 400) {
    const updated = await platformStore.updateResource(guard.id, {
      state: "completed",
      payload: {
        ...guard.payload,
        completedAt: new Date().toISOString(),
        statusCode
      }
    });
    await audit(repository.id, identity.user, "operation_guard_completed", updated ?? guard, {
      operation: spec.operation,
      statusCode
    });
    return;
  }

  if (statusCode >= 400 && statusCode < 500) {
    await platformStore.deleteResource(guard.id).catch(() => false);
    await audit(repository.id, identity.user, "operation_guard_released_after_rejection", guard, {
      operation: spec.operation,
      statusCode
    });
    return;
  }

  const updated = await platformStore.updateResource(guard.id, {
    state: "uncertain",
    payload: {
      ...guard.payload,
      failedAt: new Date().toISOString(),
      statusCode
    }
  });
  await audit(repository.id, identity.user, "operation_guard_uncertain", updated ?? guard, {
    operation: spec.operation,
    statusCode
  });
}

export async function runWithKoshOperationGuard(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => Promise<boolean>,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (request.method !== "POST") return next();
  const url = new URL(request.url ?? "/", "http://kosh.local");
  const spec = guardSpec(url.pathname);
  if (!spec) return next();

  let context: GuardContext | null = null;
  try {
    context = await acquireGuard(request, spec);
    response.setHeader("x-kosh-operation-id", context.guard.id);
    let handled = false;
    try {
      handled = await next();
    } catch (error) {
      await finalizeGuard(context, 500).catch(() => undefined);
      throw error;
    }
    await finalizeGuard(context, handled ? response.statusCode : 404);
    return handled;
  } catch (error) {
    const value = error as { status?: number; operationId?: string };
    const status = Number(value?.status) || 500;
    if (!response.headersSent) {
      sendJson(
        response,
        status,
        {
          error: error instanceof Error ? error.message : "operation_guard_error",
          operationId: value?.operationId ?? context?.guard.id ?? null
        },
        origin,
        allowedOrigins
      );
    } else if (!response.writableEnded) {
      response.end();
    }
    return true;
  }
}

export async function handleKoshOperationGuardRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/operations(?:\/([^/]+))?$/
  );
  if (!match) return false;

  try {
    const { repository, identity } = await authorize(
      request,
      match[1],
      match[2],
      "repository.manage"
    );
    await platformStore.ready();
    const operations = (await platformStore.listResources("deployment_policy", repository.id))
      .filter((item) => item.payload.kind === "operation_guard")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    if (request.method === "GET" && !match[3]) {
      sendJson(response, 200, { operations }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "DELETE" && match[3]) {
      if (identity.authType !== "session") {
        throw Object.assign(new Error("interactive_session_required"), { status: 403 });
      }
      if (origin && !allowedOrigins.has(origin)) {
        throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
      }
      const id = decodeURIComponent(match[3]);
      const operation = operations.find((item) => item.id === id);
      if (!operation) {
        throw Object.assign(new Error("operation_guard_not_found"), { status: 404 });
      }
      if (operation.state === "processing" && !guardExpired(operation)) {
        throw Object.assign(new Error("active_operation_guard_cannot_be_cleared"), { status: 409 });
      }
      await platformStore.deleteResource(id);
      await audit(repository.id, identity.user, "operation_guard_cleared", operation, {
        operation: operation.payload.operation,
        previousState: operation.state
      });
      sendJson(response, 200, { cleared: true, id }, origin, allowedOrigins);
      return true;
    }

    sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
    return true;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: unknown }).status) || 500
      : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "operation_guard_error" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
