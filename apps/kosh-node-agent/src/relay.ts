import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket, { type RawData } from "ws";

const execFileAsync = promisify(execFile);
const controller = (process.env.KOSH_CLOUD_CONTROLLER_URL ?? "http://127.0.0.1:4100/v1/kosh/cloud")
  .trim()
  .replace(/\/+$/, "");
const stateRoot = process.env.KOSH_NODE_STATE_DIR?.trim() || join(homedir(), ".kosh", "node-agent");
const statePath = join(stateRoot, "identity.json");
const maxBodyBytes = Math.max(
  1024 * 1024,
  Math.min(64 * 1024 * 1024, Math.floor((Number(process.env.KOSH_CLOUD_RELAY_MAX_BODY_MB ?? 8) || 8) * 1024 * 1024))
);
const maxInflight = Math.max(1, Math.min(64, Number(process.env.KOSH_CLOUD_RELAY_MAX_INFLIGHT ?? 16) || 16));

type NodeIdentity = { nodeId: string; nodeToken: string };
type RelayRequest = {
  type: "http-request";
  requestId: string;
  deploymentId: string;
  assignmentGeneration: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

type RelayResponse = {
  type: "http-response";
  requestId: string;
  status: number;
  headers?: Record<string, string>;
  bodyBase64?: string;
  error?: string;
};

let stopped = false;
let inflight = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function docker(args: string[], timeout = 20_000) {
  const result = await execFileAsync("docker", args, {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    encoding: "utf8"
  });
  return String(result.stdout).trim();
}

async function loadIdentity() {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as NodeIdentity;
    if (parsed.nodeId && parsed.nodeToken?.startsWith("kosh_node_")) return parsed;
  } catch {}
  return null;
}

function relayBase() {
  const configured = process.env.KOSH_CLOUD_RELAY_URL?.trim().replace(/\/$/, "");
  if (configured) return configured;
  return controller.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
}

async function findTarget(deploymentId: string, generation: number) {
  const output = await docker([
    "ps",
    "--filter",
    "label=kosh.managed=true",
    "--filter",
    `label=kosh.deployment.id=${deploymentId}`,
    "--filter",
    `label=kosh.assignment.generation=${generation}`,
    "--format",
    "{{.ID}}"
  ]);
  const containerId = output.split(/\r?\n/).filter(Boolean)[0];
  if (!containerId) throw new Error("relay_assignment_not_running");
  const portOutput = await docker(["port", containerId]);
  const match = portOutput.match(/127\.0\.0\.1:(\d+)|0\.0\.0\.0:(\d+)|\[::\]:(\d+)/);
  const port = Number(match?.[1] || match?.[2] || match?.[3]);
  if (!Number.isInteger(port) || port < 1) throw new Error("relay_container_port_unavailable");
  return port;
}

function responseHeaders(headers: import("node:http").IncomingHttpHeaders) {
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
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!allowed.has(name.toLowerCase()) || value === undefined) continue;
    output[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return output;
}

async function proxyRequest(message: RelayRequest): Promise<RelayResponse> {
  if (!message.requestId || !message.deploymentId || !Number.isSafeInteger(message.assignmentGeneration)) {
    throw new Error("invalid_relay_request");
  }
  const port = await findTarget(message.deploymentId, message.assignmentGeneration);
  const body = message.bodyBase64 ? Buffer.from(message.bodyBase64, "base64") : Buffer.alloc(0);
  if (body.length > maxBodyBytes) throw new Error("relay_request_too_large");

  return new Promise<RelayResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method: message.method || "GET",
        path: message.path || "/",
        headers: {
          ...(message.headers ?? {}),
          host: `127.0.0.1:${port}`,
          ...(body.length ? { "content-length": String(body.length) } : {})
        }
      },
      (upstream) => {
        const chunks: Buffer[] = [];
        let total = 0;
        upstream.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.length;
          if (total > maxBodyBytes) {
            upstream.destroy(new Error("relay_response_too_large"));
            return;
          }
          chunks.push(buffer);
        });
        upstream.on("end", () => {
          const output = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
          resolve({
            type: "http-response",
            requestId: message.requestId,
            status: upstream.statusCode ?? 502,
            headers: responseHeaders(upstream.headers),
            bodyBase64: output.length ? output.toString("base64") : ""
          });
        });
        upstream.on("error", reject);
      }
    );
    request.setTimeout(30_000, () => request.destroy(new Error("relay_local_timeout")));
    request.on("error", reject);
    if (body.length) request.write(body);
    request.end();
  });
}

function send(websocket: WebSocket, response: RelayResponse) {
  if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(response));
}

function handleMessage(websocket: WebSocket, raw: RawData) {
  let message: RelayRequest;
  try {
    message = JSON.parse(raw.toString()) as RelayRequest;
  } catch {
    return;
  }
  if (message.type !== "http-request" || !message.requestId) return;
  if (inflight >= maxInflight) {
    send(websocket, {
      type: "http-response",
      requestId: message.requestId,
      status: 503,
      error: "relay_node_busy"
    });
    return;
  }

  inflight += 1;
  void proxyRequest(message)
    .then((response) => send(websocket, response))
    .catch((error) =>
      send(websocket, {
        type: "http-response",
        requestId: message.requestId,
        status: 502,
        error: error instanceof Error ? error.message : "relay_proxy_failed"
      })
    )
    .finally(() => {
      inflight -= 1;
    });
}

async function connect(identity: NodeIdentity) {
  const url = `${relayBase()}/relay/nodes/${encodeURIComponent(identity.nodeId)}`;
  return new Promise<void>((resolve) => {
    const websocket = new WebSocket(url, {
      headers: { authorization: `Bearer ${identity.nodeToken}` },
      handshakeTimeout: 15_000,
      maxPayload: maxBodyBytes * 2 + 1024 * 1024
    });
    let opened = false;
    websocket.on("open", () => {
      opened = true;
      console.log("Kosh Relay connected", { nodeId: identity.nodeId });
    });
    websocket.on("message", (data) => handleMessage(websocket, data));
    websocket.on("error", (error) => {
      if (opened) console.warn("Kosh Relay connection error", error.message);
    });
    websocket.on("close", (code) => {
      if (opened) console.warn("Kosh Relay disconnected", { code });
      resolve();
    });
  });
}

async function relayLoop() {
  let retryMs = 2_000;
  while (!stopped) {
    const identity = await loadIdentity();
    if (!identity) {
      await sleep(1_000);
      continue;
    }
    try {
      await connect(identity);
      retryMs = 2_000;
    } catch (error) {
      console.warn("Kosh Relay connect failed", error instanceof Error ? error.message : String(error));
    }
    if (!stopped) {
      await sleep(retryMs);
      retryMs = Math.min(30_000, retryMs * 2);
    }
  }
}

function shutdown() {
  stopped = true;
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

void relayLoop().catch((error) => {
  console.error("Kosh Relay stopped unexpectedly", error);
});
