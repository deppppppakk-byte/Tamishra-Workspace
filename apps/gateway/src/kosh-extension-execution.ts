import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshMaintenanceStore } from "./kosh-maintenance-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const maintenanceStore = getKoshMaintenanceStore();
const allowedCapabilities = new Set([
  "asset-preview",
  "automation-step",
  "code-intelligence",
  "deployment-gate",
  "project-panel",
  "storage-adapter",
  "webhook-transform"
]);
const allowedPermissions = new Set([
  "network.egress",
  "repository.manage",
  "repository.read",
  "repository.write",
  "storage.read",
  "storage.write"
]);

type JsonBody = Record<string, unknown>;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes = 128 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(value);
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

function requireAllowedOrigin(
  request: IncomingMessage,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
  if (request.method !== "POST") {
    throw Object.assign(new Error("method_not_allowed"), { status: 405 });
  }
}

function manifestFor(resource: Awaited<ReturnType<typeof platformStore.getResource>>) {
  const payload = resource?.payload;
  const manifest = payload?.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw Object.assign(new Error("extension_manifest_missing"), { status: 409 });
  }
  const value = manifest as Record<string, unknown>;
  const capabilities = Array.isArray(value.capabilities)
    ? [...new Set(value.capabilities.map(String))].filter((item) => allowedCapabilities.has(item))
    : [];
  const permissions = Array.isArray(value.permissions)
    ? [...new Set(value.permissions.map(String))].filter((item) => allowedPermissions.has(item))
    : [];
  return {
    id: clean(value.id, 100),
    name: clean(value.name, 160),
    version: clean(value.version, 80),
    runtime: clean(value.runtime, 40),
    entrypoint: clean(value.entrypoint, 240) || null,
    capabilities,
    permissions,
    assetKinds: Array.isArray(value.assetKinds)
      ? [...new Set(value.assetKinds.map((item) => clean(item, 100)).filter(Boolean))].slice(0, 64)
      : []
  };
}

function requiredRepositoryPermission(permissions: string[]) {
  if (
    permissions.includes("repository.manage") ||
    permissions.includes("repository.write") ||
    permissions.includes("storage.write")
  ) {
    return "repository.manage" as const;
  }
  return "repository.read" as const;
}

export async function handleKoshExtensionExecutionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/extensions\/([^/]+)\/execute$/
  );
  if (!match) return false;

  try {
    requireAllowedOrigin(request, origin, allowedOrigins);
    await Promise.all([platformStore.ready(), maintenanceStore.ready()]);
    const repository = await repositoryStore.get(match[1], match[2]);
    if (!repository) {
      sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
      return true;
    }
    const extension = await platformStore.getResource(decodeURIComponent(match[3]));
    if (!extension || extension.type !== "extension" || extension.repositoryId !== null) {
      sendJson(response, 404, { error: "extension_not_found" }, origin, allowedOrigins);
      return true;
    }
    if (extension.state !== "enabled") {
      sendJson(response, 409, { error: "extension_not_enabled" }, origin, allowedOrigins);
      return true;
    }
    const manifest = manifestFor(extension);
    if (manifest.runtime !== "declarative") {
      sendJson(response, 409, { error: "unsupported_extension_runtime" }, origin, allowedOrigins);
      return true;
    }
    if (manifest.permissions.includes("network.egress") && process.env.KOSH_EXTENSION_ALLOW_NETWORK !== "true") {
      sendJson(response, 409, { error: "extension_network_egress_disabled" }, origin, allowedOrigins);
      return true;
    }
    const authorization = await authorizeKoshRepositoryRequest(
      request,
      repository,
      requiredRepositoryPermission(manifest.permissions)
    );
    if (!authorization.identity || !authorization.decision.allowed) {
      sendJson(
        response,
        authorization.identity ? 403 : 401,
        { error: authorization.identity ? "repository_permission_denied" : "authentication_required" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const body = await readJson(request);
    const capability = clean(body.capability, 100);
    if (!capability || !manifest.capabilities.includes(capability)) {
      sendJson(response, 400, { error: "extension_capability_not_declared" }, origin, allowedOrigins);
      return true;
    }
    const input = body.input && typeof body.input === "object" && !Array.isArray(body.input)
      ? body.input as Record<string, unknown>
      : {};
    const timeoutSeconds = Math.max(1, Math.min(300, Number(body.timeoutSeconds) || 30));
    const memoryMb = Math.max(64, Math.min(1024, Number(body.memoryMb) || 256));
    const job = await maintenanceStore.enqueue({
      repositoryId: repository.id,
      kind: "extension_execute",
      priority: 25,
      maxAttempts: 2,
      dedupeKey: clean(body.dedupeKey, 240) || null,
      payload: {
        extension: {
          resourceId: extension.id,
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          entrypoint: manifest.entrypoint,
          capability,
          permissions: manifest.permissions,
          assetKinds: manifest.assetKinds
        },
        repository: {
          id: repository.id,
          namespace: repository.namespace,
          slug: repository.slug
        },
        executionPolicy: {
          timeoutSeconds,
          memoryMb,
          networkEgress: manifest.permissions.includes("network.egress")
        },
        input,
        requestedBy: {
          userId: authorization.identity.user.id,
          displayName: authorization.identity.user.displayName
        }
      }
    });
    await platformStore.appendAudit({
      repositoryId: repository.id,
      actorUserId: authorization.identity.user.id,
      actorName: authorization.identity.user.displayName,
      eventType: "extension_execution_enqueued",
      resourceType: "extension",
      resourceId: extension.id,
      metadata: {
        jobId: job.id,
        extensionId: manifest.id,
        extensionVersion: manifest.version,
        capability,
        permissions: manifest.permissions,
        providerConfigured: Boolean(process.env.KOSH_EXTENSION_RUNTIME_HOOK?.trim())
      }
    });
    sendJson(response, 202, {
      job,
      isolation: {
        gatewayExecutesExtensionCode: false,
        providerConfigured: Boolean(process.env.KOSH_EXTENSION_RUNTIME_HOOK?.trim()),
        timeoutSeconds,
        memoryMb,
        networkEgress: manifest.permissions.includes("network.egress")
      }
    }, origin, allowedOrigins);
    return true;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "extension_execution_error" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
