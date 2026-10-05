import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import postgres from "postgres";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshCloudStore } from "./kosh-cloud-store.js";

const store = getKoshCloudStore();
const relaySockets = new Map<string, WebSocket>();
const pending = new Map<
  string,
  {
    nodeId: string;
    resolve: (message: RelayHttpResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

type RelayHttpResponse = {
  type: "http-response";
  requestId: string;
  status: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  error?: string;
};

type RelayDeployment = {
  id: string;
  slug: string;
  node_id: string | null;
  assignment_generation: string | number;
  state: string;
  exposure: "private" | "public";
};

function cloudEnabled() {
  return process.env.KOSH_CLOUD_ENABLED?.trim().toLowerCase() === "true";
}

function maxBodyBytes() {
  const mb = Number(process.env.KOSH_CLOUD_RELAY_MAX_BODY_MB ?? 8);
  return Math.max(1, Math.min(64, Number.isFinite(mb) ? Math.floor(mb) : 8)) * 1024 * 1024;
}

function relayTimeoutMs() {
  const value = Number(process.env.KOSH_CLOUD_RELAY_TIMEOUT_MS ?? 30_000);
  return Math.max(5_000, Math.min(120_000, Number.isFinite(value) ? Math.floor(value) : 30_000));
}

function bearer(request: IncomingMessage) {
  const value = String(request.headers.authorization ?? "").trim();
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : "";
}

function rejectUpgrade(socket: import("node:stream").Duplex, status = 401) {
  const label = status === 503 ? "Service Unavailable" : "Unauthorized";
  socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function safeRequestHeaders(request: IncomingMessage) {
  const allowed = new Set([
    "accept",
    "accept-encoding",
    "accept-language",
    "content-type",
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
    "range",
    "user-agent",
    "x-requested-with"
  ]);
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!allowed.has(name.toLowerCase()) || value === undefined) continue;
    output[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return output;
}

function safeResponseHeaders(headers: Record<string, string> | undefined) {
  const allowed = new Set([
    "cache-control",
    "content-disposition",
    "content-language",
    "content-type",
    "etag",
    "expires",
    "last-modified",
    "location",
    "vary"
  ]);
  return Object.entries(headers ?? {}).filter(([name]) => allowed.has(name.toLowerCase()));
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes()) {
      throw Object.assign(new Error("relay_request_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
}

async function readSmallJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 8 * 1024) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(buffer);
  }
  if (!chunks.length) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

async function requireCloudAdmin(request: IncomingMessage) {
  const identity = await resolveKoshIdentity(request, "repo:read");
  if (!identity) return false;
  return identity.memberships.some(
    (item) =>
      !item.membership.disabled &&
      (item.membership.role === "owner" || item.membership.role === "admin")
  );
}

let relaySql: ReturnType<typeof postgres> | null = null;
let exposureReady: Promise<void> | null = null;
function getRelaySql() {
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw Object.assign(new Error("kosh_cloud_database_required"), { status: 503 });
  }
  relaySql ??= postgres(databaseUrl, { max: 2, prepare: false });
  return relaySql;
}

async function ensureExposureSchema() {
  if (!exposureReady) {
    const database = getRelaySql();
    exposureReady = database`
      ALTER TABLE kosh_cloud_deployments
      ADD COLUMN IF NOT EXISTS exposure TEXT NOT NULL DEFAULT 'private'
    `.then(() => undefined).catch((error) => {
      exposureReady = null;
      throw error;
    });
  }
  await exposureReady;
}

async function findDeployment(slug: string) {
  await ensureExposureSchema();
  const database = getRelaySql();
  const rows = await database<RelayDeployment[]>`
    SELECT id, slug, node_id, assignment_generation, state,
           CASE WHEN exposure='public' THEN 'public' ELSE 'private' END AS exposure
    FROM kosh_cloud_deployments
    WHERE slug=${slug}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function setExposure(deploymentId: string, exposure: "private" | "public") {
  await ensureExposureSchema();
  const database = getRelaySql();
  const rows = await database<{ id: string; slug: string; exposure: string }[]>`
    UPDATE kosh_cloud_deployments
    SET exposure=${exposure}, updated_at=NOW()
    WHERE id=${deploymentId}
    RETURNING id, slug, exposure
  `;
  return rows[0] ?? null;
}

async function getExposure(deploymentId: string) {
  await ensureExposureSchema();
  const database = getRelaySql();
  const rows = await database<{ id: string; slug: string; exposure: string }[]>`
    SELECT id, slug, CASE WHEN exposure='public' THEN 'public' ELSE 'private' END AS exposure
    FROM kosh_cloud_deployments
    WHERE id=${deploymentId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function settlePending(nodeId: string, error: Error) {
  for (const [id, item] of pending) {
    if (item.nodeId !== nodeId) continue;
    clearTimeout(item.timer);
    pending.delete(id);
    item.reject(error);
  }
}

function handleRelayMessage(nodeId: string, data: RawData) {
  let message: RelayHttpResponse;
  try {
    message = JSON.parse(data.toString()) as RelayHttpResponse;
  } catch {
    return;
  }
  if (message.type !== "http-response" || !message.requestId) return;
  const item = pending.get(message.requestId);
  if (!item || item.nodeId !== nodeId) return;
  clearTimeout(item.timer);
  pending.delete(message.requestId);
  if (message.error) item.reject(new Error(message.error));
  else item.resolve(message);
}

async function authenticateRelayUpgrade(request: IncomingMessage, nodeId: string) {
  if (!cloudEnabled()) return false;
  const node = await store.authenticateNode(nodeId, bearer(request));
  return Boolean(node);
}

function bindRelaySocket(websocket: WebSocket, nodeId: string) {
  const old = relaySockets.get(nodeId);
  if (old && old !== websocket) old.close(1012, "replaced by newer Kosh Relay session");
  relaySockets.set(nodeId, websocket);
  let alive = true;

  websocket.on("pong", () => {
    alive = true;
  });
  websocket.on("message", (data) => handleRelayMessage(nodeId, data));
  websocket.on("close", () => {
    if (relaySockets.get(nodeId) === websocket) relaySockets.delete(nodeId);
    settlePending(nodeId, new Error("kosh_relay_node_disconnected"));
  });
  websocket.on("error", () => undefined);

  const pingTimer = setInterval(() => {
    if (websocket.readyState !== WebSocket.OPEN) {
      clearInterval(pingTimer);
      return;
    }
    if (!alive) {
      websocket.terminate();
      clearInterval(pingTimer);
      return;
    }
    alive = false;
    websocket.ping();
  }, 25_000);
  pingTimer.unref?.();
  websocket.once("close", () => clearInterval(pingTimer));
}

export function attachKoshCloudRelay(server: Server) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxBodyBytes() * 2 + 1024 * 1024
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://kosh-cloud.local");
    const match = url.pathname.match(/^\/v1\/kosh\/cloud\/relay\/nodes\/([^/]+)$/);
    if (!match) return;
    const nodeId = match[1];
    void authenticateRelayUpgrade(request, nodeId)
      .then((allowed) => {
        if (!allowed) {
          rejectUpgrade(socket, cloudEnabled() ? 401 : 503);
          return;
        }
        wss.handleUpgrade(request, socket, head, (websocket) => {
          bindRelaySocket(websocket, nodeId);
        });
      })
      .catch(() => rejectUpgrade(socket, 401));
  });
}

function relayRequest(nodeId: string, payload: Record<string, unknown>) {
  const websocket = relaySockets.get(nodeId);
  if (!websocket || websocket.readyState !== WebSocket.OPEN) {
    throw Object.assign(new Error("kosh_relay_node_unavailable"), { status: 503 });
  }
  const requestId = randomUUID();
  const envelope = { ...payload, type: "http-request", requestId };
  return new Promise<RelayHttpResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Object.assign(new Error("kosh_relay_timeout"), { status: 504 }));
    }, relayTimeoutMs());
    timer.unref?.();
    pending.set(requestId, { nodeId, resolve, reject, timer });
    websocket.send(JSON.stringify(envelope), (error) => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(requestId);
      reject(error);
    });
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

export async function handleKoshCloudRelayHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  const exposureMatch = url.pathname.match(
    /^\/v1\/kosh\/cloud\/deployments\/([^/]+)\/exposure$/
  );
  const appMatch = url.pathname.match(
    /^\/v1\/kosh\/cloud\/apps\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})(\/.*)?$/
  );
  if (!exposureMatch && !appMatch) return false;

  if (!cloudEnabled()) {
    sendJson(response, 503, { error: "kosh_cloud_disabled" });
    return true;
  }

  if (exposureMatch) {
    if (!(await requireCloudAdmin(request))) {
      sendJson(response, 401, { error: "cloud_admin_required" });
      return true;
    }
    try {
      if (request.method === "GET") {
        const deployment = await getExposure(exposureMatch[1]);
        if (!deployment) sendJson(response, 404, { error: "deployment_not_found" });
        else sendJson(response, 200, { deployment });
        return true;
      }
      if (request.method === "POST" || request.method === "PATCH") {
        const body = await readSmallJson(request);
        const exposure = String(body.exposure ?? "").trim().toLowerCase();
        if (exposure !== "private" && exposure !== "public") {
          sendJson(response, 400, { error: "invalid_deployment_exposure" });
          return true;
        }
        const deployment = await setExposure(exposureMatch[1], exposure);
        if (!deployment) sendJson(response, 404, { error: "deployment_not_found" });
        else sendJson(response, 200, { deployment });
        return true;
      }
      sendJson(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      sendJson(response, Number((error as { status?: number }).status ?? 500), {
        error: error instanceof Error ? error.message : "deployment_exposure_failed"
      });
    }
    return true;
  }

  const match = appMatch!;
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");

  try {
    const deployment = await findDeployment(match[1]);
    if (!deployment) {
      response.statusCode = 404;
      response.end("Kosh deployment not found.");
      return true;
    }
    if (deployment.exposure !== "public" && !(await requireCloudAdmin(request))) {
      response.statusCode = 401;
      response.end("Kosh Cloud authentication required.");
      return true;
    }
    if (deployment.state !== "running" || !deployment.node_id) {
      response.statusCode = 503;
      response.end("Kosh deployment is not running.");
      return true;
    }

    const body = await readBody(request);
    const relayResponse = await relayRequest(deployment.node_id, {
      deploymentId: deployment.id,
      assignmentGeneration: Number(deployment.assignment_generation),
      method: request.method ?? "GET",
      path: (match[2] || "/") + url.search,
      headers: safeRequestHeaders(request),
      bodyBase64: body.length ? body.toString("base64") : ""
    });

    response.statusCode = Math.max(100, Math.min(599, Number(relayResponse.status) || 502));
    for (const [name, value] of safeResponseHeaders(relayResponse.headers)) {
      response.setHeader(name, value);
    }
    response.setHeader("x-kosh-relay", "v1");
    response.setHeader("x-kosh-exposure", deployment.exposure);
    const output = relayResponse.bodyBase64
      ? Buffer.from(relayResponse.bodyBase64, "base64")
      : Buffer.alloc(0);
    if (output.length > maxBodyBytes()) {
      throw Object.assign(new Error("relay_response_too_large"), { status: 502 });
    }
    response.end(output);
  } catch (error) {
    const status = Number((error as { status?: number }).status ?? 502);
    response.statusCode = status;
    response.end(error instanceof Error ? error.message : "Kosh Relay failed.");
  }
  return true;
}
