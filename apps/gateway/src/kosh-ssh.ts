import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { evaluateKoshRepositoryAccess } from "./kosh-access.js";
import { getWorkspaceIdentityAuthorization } from "./identity.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";
import { scheduleAutomationEvent } from "./kosh-automation-service.js";
import { dispatchKoshWebhooks } from "./kosh-webhooks.js";

const platformStore = getKoshPlatformStore();
const repositoryStore = getKoshStore();

type JsonBody = Record<string, unknown>;

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  limit = 64 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
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

function constantTimeEquals(leftValue: string, rightValue: string) {
  const left = Buffer.from(leftValue);
  const right = Buffer.from(rightValue);
  return left.length === right.length && timingSafeEqual(left, right);
}

function serviceToken(request: IncomingMessage) {
  const header = request.headers["x-kosh-ssh-service-token"];
  return Array.isArray(header) ? header[0]?.trim() ?? "" : String(header ?? "").trim();
}

function requireServiceAuthentication(
  request: IncomingMessage,
  response: ServerResponse
) {
  const expected = process.env.KOSH_SSH_SERVICE_TOKEN?.trim();
  if (!expected) {
    sendJson(response, 503, { error: "kosh_ssh_service_token_required" });
    return false;
  }

  if (!constantTimeEquals(serviceToken(request), expected)) {
    sendJson(response, 401, { error: "ssh_service_authentication_required" });
    return false;
  }

  return true;
}

function routeError(response: ServerResponse, error: unknown) {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
  sendJson(response, status, {
    error: error instanceof Error ? error.message : "kosh_ssh_error"
  });
}

function validRepositorySegment(value: string, maxLength: number) {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
  );
}

export async function handleKoshSshBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  if (!url.pathname.startsWith("/v1/kosh/ssh/internal")) return false;

  if (!requireServiceAuthentication(request, response)) return true;

  try {
    await Promise.all([platformStore.ready(), repositoryStore.ready()]);

    if (
      request.method === "GET" &&
      url.pathname === "/v1/kosh/ssh/internal/authorized-key"
    ) {
      const fingerprint = clean(url.searchParams.get("fingerprint"), 256);
      if (!fingerprint || !fingerprint.startsWith("SHA256:")) {
        throw Object.assign(new Error("invalid_ssh_fingerprint"), {
          status: 400
        });
      }

      const key = await platformStore.findSshKeyByFingerprint(fingerprint);
      if (!key) {
        sendJson(response, 404, { error: "ssh_key_not_found" });
        return true;
      }

      const authorization = await getWorkspaceIdentityAuthorization(key.userId);
      if (!authorization) {
        sendJson(response, 404, { error: "ssh_key_user_unavailable" });
        return true;
      }

      sendJson(response, 200, {
        key: {
          id: key.id,
          userId: key.userId,
          title: key.title,
          publicKey: key.publicKey,
          fingerprint: key.fingerprint
        },
        user: {
          id: authorization.user.id,
          displayName: authorization.user.displayName,
          email: authorization.user.email
        }
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/kosh/ssh/internal/push"
    ) {
      const body = await readJson(request);
      const userId = clean(body.userId, 240);
      const keyId = clean(body.keyId, 240);
      const namespace = clean(body.namespace, 64);
      const slug = clean(body.slug, 100);
      const rawBranches = Array.isArray(body.branches)
        ? body.branches.slice(0, 200)
        : [];

      if (
        !userId ||
        !keyId ||
        !validRepositorySegment(namespace, 64) ||
        !validRepositorySegment(slug, 100)
      ) {
        throw Object.assign(new Error("invalid_ssh_push_event"), {
          status: 400
        });
      }

      const key = await platformStore.getSshKey(userId, keyId);
      const identity = await getWorkspaceIdentityAuthorization(userId);
      const repository = await repositoryStore.get(namespace, slug);

      if (!key || !identity || !repository) {
        sendJson(response, 403, { error: "ssh_push_event_not_authorized" });
        return true;
      }

      const access = await evaluateKoshRepositoryAccess(
        identity,
        repository,
        "repository.write"
      );
      if (!access.allowed) {
        sendJson(response, 403, { error: "repository_permission_denied" });
        return true;
      }

      const branches = rawBranches
        .map((item) =>
          item && typeof item === "object"
            ? {
                name: clean((item as Record<string, unknown>).name, 240),
                sha: clean((item as Record<string, unknown>).sha, 64)
              }
            : { name: "", sha: "" }
        )
        .filter(
          (item) =>
            /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/.test(item.name) &&
            !item.name.includes("..") &&
            /^[0-9a-f]{40}$/i.test(item.sha)
        );

      for (const branch of branches) {
        await scheduleAutomationEvent(
          repository,
          "push",
          branch.name,
          branch.sha,
          { id: identity.user.id, name: identity.user.displayName },
          null
        );
        void dispatchKoshWebhooks(
          repository.id,
          "push",
          {
            namespace: repository.namespace,
            slug: repository.slug,
            branch: branch.name,
            commitSha: branch.sha,
            transport: "ssh"
          }
        ).catch(() => undefined);
      }

      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "ssh_git_push_completed",
        resourceType: "repository",
        resourceId: repository.id,
        metadata: {
          namespace,
          slug,
          keyId,
          branches
        }
      });

      sendJson(response, 200, {
        accepted: true,
        branchCount: branches.length
      });
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/kosh/ssh/internal/authorize"
    ) {
      const body = await readJson(request);
      const userId = clean(body.userId, 240);
      const keyId = clean(body.keyId, 240);
      const namespace = clean(body.namespace, 64);
      const slug = clean(body.slug, 100);
      const operation = clean(body.operation, 40);

      if (
        !userId ||
        !keyId ||
        !validRepositorySegment(namespace, 64) ||
        !validRepositorySegment(slug, 100) ||
        !["upload-pack", "receive-pack"].includes(operation)
      ) {
        throw Object.assign(new Error("invalid_ssh_authorization_request"), {
          status: 400
        });
      }

      const key = await platformStore.getSshKey(userId, keyId);
      if (!key) {
        sendJson(response, 403, { error: "ssh_key_not_authorized" });
        return true;
      }

      const identity = await getWorkspaceIdentityAuthorization(userId);
      if (!identity) {
        sendJson(response, 403, { error: "ssh_user_not_authorized" });
        return true;
      }

      const repository = await repositoryStore.get(namespace, slug);
      if (!repository) {
        sendJson(response, 404, { error: "repository_not_found" });
        return true;
      }

      const permission =
        operation === "receive-pack"
          ? "repository.write"
          : "repository.read";

      const access = await evaluateKoshRepositoryAccess(
        identity,
        repository,
        permission
      );

      if (!access.allowed) {
        await platformStore.appendAudit({
          repositoryId: repository.id,
          actorUserId: identity.user.id,
          actorName: identity.user.displayName,
          eventType: "ssh_git_access_denied",
          resourceType: "repository",
          resourceId: repository.id,
          metadata: {
            namespace,
            slug,
            operation,
            permission,
            role: access.role,
            source: access.source,
            keyId
          }
        });

        sendJson(response, 403, {
          error: "repository_permission_denied",
          permission,
          role: access.role
        });
        return true;
      }

      await platformStore.touchSshKey(userId, keyId);
      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "ssh_git_access_authorized",
        resourceType: "repository",
        resourceId: repository.id,
        metadata: {
          namespace,
          slug,
          operation,
          permission,
          role: access.role,
          source: access.source,
          keyId
        }
      });

      sendJson(response, 200, {
        allowed: true,
        repository: {
          id: repository.id,
          namespace: repository.namespace,
          slug: repository.slug,
          defaultBranch: repository.defaultBranch
        },
        actor: {
          id: identity.user.id,
          displayName: identity.user.displayName,
          email: identity.user.email
        },
        access: {
          role: access.role,
          source: access.source,
          permission
        }
      });
      return true;
    }

    sendJson(response, 404, { error: "kosh_ssh_internal_route_not_found" });
    return true;
  } catch (error) {
    routeError(response, error);
    return true;
  }
}
