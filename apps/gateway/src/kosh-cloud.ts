import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshCloudStore } from "./kosh-cloud-store.js";

const store = getKoshCloudStore();
type JsonBody = Record<string, unknown>;

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

async function readJson(request: IncomingMessage, maxBytes = 64 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonBody)
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function cleanSlug(value: unknown) {
  return cleanText(value, 100)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanUrl(value: unknown) {
  const input = cleanText(value, 500);
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw Object.assign(new Error("invalid_public_url"), { status: 400 });
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw Object.assign(new Error("invalid_public_url"), { status: 400 });
  }
  return url.toString().replace(/\/$/, "");
}

function stringArray(value: unknown, maxItems = 32) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 80)).filter(Boolean))].slice(0, maxItems);
}

function stringMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 32)
      .map(([key, item]) => [cleanText(key, 60), cleanText(item, 120)])
      .filter(([key]) => Boolean(key))
  );
}

function bearer(request: IncomingMessage) {
  const value = String(request.headers.authorization ?? "").trim();
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function enrollmentAllowed(request: IncomingMessage) {
  const expected = process.env.KOSH_CLOUD_NODE_ENROLLMENT_SECRET?.trim() ?? "";
  if (!expected) return process.env.NODE_ENV !== "production";
  const actual = String(request.headers["x-kosh-cloud-enrollment"] ?? "").trim();
  return safeEqual(actual, expected);
}

async function requireAdmin(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const identity = await resolveKoshIdentity(request, "repo:write");
  if (!identity) {
    sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
    return null;
  }
  const admin = identity.memberships.some(
    (item) =>
      !item.membership.disabled &&
      (item.membership.role === "owner" || item.membership.role === "admin")
  );
  if (!admin) {
    sendJson(response, 403, { error: "cloud_admin_required" }, origin, allowedOrigins);
    return null;
  }
  return identity;
}

async function requireNode(
  request: IncomingMessage,
  response: ServerResponse,
  nodeId: string,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const node = await store.authenticateNode(nodeId, bearer(request));
  if (!node) {
    sendJson(response, 401, { error: "node_authentication_required" }, origin, allowedOrigins);
    return null;
  }
  return node;
}

function errorStatus(error: unknown) {
  return Number((error as { status?: number })?.status ?? 500);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "kosh_cloud_error";
}

export async function handleKoshCloudRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/kosh/cloud")) return false;

  if (process.env.KOSH_CLOUD_ENABLED?.trim().toLowerCase() !== "true") {
    sendJson(response, 503, { error: "kosh_cloud_disabled" }, origin, allowedOrigins);
    return true;
  }

  try {
    await store.ready();

    if (request.method === "GET" && url.pathname === "/v1/kosh/cloud") {
      const identity = await requireAdmin(request, response, origin, allowedOrigins);
      if (!identity) return true;
      const [nodes, deployments] = await Promise.all([store.listNodes(), store.listDeployments()]);
      sendJson(
        response,
        200,
        {
          product: "Kosh Cloud",
          controller: true,
          persistence: store.kind,
          nodes: {
            total: nodes.length,
            online: nodes.filter((node) => node.state === "online").length,
            draining: nodes.filter((node) => node.state === "draining").length,
            offline: nodes.filter((node) => node.state === "offline").length
          },
          deployments: {
            total: deployments.length,
            running: deployments.filter((deployment) => deployment.state === "running").length,
            pending: deployments.filter((deployment) => deployment.state === "pending").length
          }
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/kosh/cloud/nodes/register") {
      if (!enrollmentAllowed(request)) {
        sendJson(response, 403, { error: "node_enrollment_denied" }, origin, allowedOrigins);
        return true;
      }
      const body = await readJson(request);
      const name = cleanText(body.name, 100);
      if (!name) throw Object.assign(new Error("node_name_required"), { status: 400 });
      const totalSlots = Math.max(1, Math.min(1024, Math.floor(Number(body.totalSlots) || 1)));
      const registration = await store.registerNode({
        name,
        region: cleanText(body.region, 80) || "unknown",
        architecture: cleanText(body.architecture, 40) || "unknown",
        publicUrl: cleanUrl(body.publicUrl),
        totalSlots,
        capabilities: stringArray(body.capabilities),
        labels: stringMap(body.labels)
      });
      sendJson(
        response,
        201,
        {
          node: registration.node,
          nodeToken: registration.token,
          note: "Store this token on the node. It is returned only during enrollment."
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    const nodeHeartbeat = url.pathname.match(/^\/v1\/kosh\/cloud\/nodes\/([^/]+)\/heartbeat$/);
    if (request.method === "POST" && nodeHeartbeat) {
      const node = await requireNode(request, response, nodeHeartbeat[1], origin, allowedOrigins);
      if (!node) return true;
      const body = await readJson(request);
      const totalSlots = Math.max(1, Math.min(1024, Math.floor(Number(body.totalSlots) || node.totalSlots)));
      const usedSlots = Math.max(0, Math.min(totalSlots, Math.floor(Number(body.usedSlots) || 0)));
      const updated = await store.heartbeat(node.id, {
        totalSlots,
        usedSlots,
        publicUrl: body.publicUrl === undefined ? node.publicUrl : cleanUrl(body.publicUrl),
        capabilities: body.capabilities === undefined ? node.capabilities : stringArray(body.capabilities),
        labels: body.labels === undefined ? node.labels : stringMap(body.labels)
      });
      sendJson(response, 200, { node: updated }, origin, allowedOrigins);
      return true;
    }

    const nodeAssignments = url.pathname.match(/^\/v1\/kosh\/cloud\/nodes\/([^/]+)\/assignments$/);
    if (request.method === "GET" && nodeAssignments) {
      const node = await requireNode(request, response, nodeAssignments[1], origin, allowedOrigins);
      if (!node) return true;
      const assignments = await store.assignmentsForNode(node.id);
      sendJson(response, 200, { assignments }, origin, allowedOrigins);
      return true;
    }

    const nodeDeploymentStatus = url.pathname.match(
      /^\/v1\/kosh\/cloud\/nodes\/([^/]+)\/deployments\/([^/]+)\/status$/
    );
    if (request.method === "POST" && nodeDeploymentStatus) {
      const node = await requireNode(request, response, nodeDeploymentStatus[1], origin, allowedOrigins);
      if (!node) return true;
      const body = await readJson(request);
      const state = cleanText(body.state, 20);
      if (!new Set(["starting", "running", "stopped", "failed"]).has(state)) {
        throw Object.assign(new Error("invalid_deployment_state"), { status: 400 });
      }
      const generation = Math.floor(Number(body.assignmentGeneration));
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw Object.assign(new Error("assignment_generation_required"), { status: 400 });
      }
      const deployment = await store.updateDeploymentFromNode({
        deploymentId: nodeDeploymentStatus[2],
        nodeId: node.id,
        assignmentGeneration: generation,
        state: state as "starting" | "running" | "stopped" | "failed",
        routeUrl: cleanUrl(body.routeUrl),
        message: cleanText(body.message, 1000) || null
      });
      if (!deployment) {
        sendJson(response, 404, { error: "deployment_not_found" }, origin, allowedOrigins);
        return true;
      }
      sendJson(response, 200, { deployment }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/kosh/cloud/nodes") {
      const identity = await requireAdmin(request, response, origin, allowedOrigins);
      if (!identity) return true;
      sendJson(response, 200, { nodes: await store.listNodes() }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "GET" && url.pathname === "/v1/kosh/cloud/deployments") {
      const identity = await requireAdmin(request, response, origin, allowedOrigins);
      if (!identity) return true;
      sendJson(
        response,
        200,
        { deployments: await store.listDeployments() },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/kosh/cloud/deployments") {
      const identity = await requireAdmin(request, response, origin, allowedOrigins);
      if (!identity) return true;
      const body = await readJson(request);
      const name = cleanText(body.name, 120);
      const slug = cleanSlug(body.slug || name);
      const image = cleanText(body.image, 500);
      const containerPort = Math.floor(Number(body.containerPort));
      if (!name || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(slug)) {
        throw Object.assign(new Error("invalid_deployment_name"), { status: 400 });
      }
      if (!image || /\s/.test(image)) {
        throw Object.assign(new Error("invalid_container_image"), { status: 400 });
      }
      if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
        throw Object.assign(new Error("invalid_container_port"), { status: 400 });
      }
      const deployment = await store.createDeployment({
        slug,
        name,
        image,
        containerPort,
        createdByUserId: identity.user.id
      });
      const scheduled = await store.scheduleDeployment(deployment.id);
      sendJson(response, 201, { deployment: scheduled ?? deployment }, origin, allowedOrigins);
      return true;
    }

    const scheduleMatch = url.pathname.match(/^\/v1\/kosh\/cloud\/deployments\/([^/]+)\/schedule$/);
    if (request.method === "POST" && scheduleMatch) {
      const identity = await requireAdmin(request, response, origin, allowedOrigins);
      if (!identity) return true;
      const deployment = await store.scheduleDeployment(scheduleMatch[1]);
      if (!deployment) {
        sendJson(response, 404, { error: "pending_deployment_not_found" }, origin, allowedOrigins);
        return true;
      }
      sendJson(response, 200, { deployment }, origin, allowedOrigins);
      return true;
    }

    sendJson(response, 404, { error: "kosh_cloud_route_not_found" }, origin, allowedOrigins);
    return true;
  } catch (error) {
    console.error("Kosh Cloud request failed", error);
    sendJson(
      response,
      errorStatus(error),
      { error: errorMessage(error) },
      origin,
      allowedOrigins
    );
    return true;
  }
}
