import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { homedir, hostname, arch } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const controller = (process.env.KOSH_CLOUD_CONTROLLER_URL ?? "http://127.0.0.1:4100/v1/kosh/cloud")
  .trim()
  .replace(/\/+$/, "");
const enrollmentSecret = process.env.KOSH_CLOUD_NODE_ENROLLMENT_SECRET?.trim() ?? "";
const nodeName = process.env.KOSH_NODE_NAME?.trim() || hostname();
const nodeRegion = process.env.KOSH_NODE_REGION?.trim() || "local";
const nodePublicUrl = process.env.KOSH_NODE_PUBLIC_URL?.trim().replace(/\/$/, "") || null;
const totalSlots = Math.max(1, Math.min(128, Number(process.env.KOSH_NODE_TOTAL_SLOTS ?? 2) || 2));
const pollMs = Math.max(2_000, Number(process.env.KOSH_NODE_POLL_MS ?? 5_000) || 5_000);
const heartbeatMs = Math.max(5_000, Number(process.env.KOSH_NODE_HEARTBEAT_MS ?? 15_000) || 15_000);
const proxyPort = Math.max(1, Math.min(65535, Number(process.env.KOSH_NODE_PROXY_PORT ?? 8080) || 8080));
const proxyHost = process.env.KOSH_NODE_PROXY_HOST?.trim() || "127.0.0.1";
const stateRoot = process.env.KOSH_NODE_STATE_DIR?.trim() || join(homedir(), ".kosh", "node-agent");
const statePath = join(stateRoot, "identity.json");

const capabilities = ["docker", "http-containers", "git"];

type NodeIdentity = { nodeId: string; nodeToken: string };
type Assignment = {
  id: string;
  slug: string;
  name: string;
  image: string;
  containerPort: number;
  state: "assigned" | "starting" | "running" | "stopping";
  nodeId: string;
  assignmentGeneration: number;
};

type ApiResult<T> = T & { error?: string };

type RouteTarget = {
  port: number;
  generation: number;
};

const routes = new Map<string, RouteTarget>();
let identity: NodeIdentity | null = null;
let stopping = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function docker(args: string[], timeout = 120_000) {
  const result = await execFileAsync("docker", args, {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8"
  });
  return String(result.stdout).trim();
}

async function api<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    nodeToken?: string;
    enrollment?: boolean;
  } = {}
) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.nodeToken) headers.authorization = `Bearer ${options.nodeToken}`;
  if (options.enrollment) headers["x-kosh-cloud-enrollment"] = enrollmentSecret;

  const response = await fetch(controller + path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15_000)
  });
  const text = await response.text();
  let parsed: ApiResult<T>;
  try {
    parsed = (text ? JSON.parse(text) : {}) as ApiResult<T>;
  } catch {
    parsed = {} as ApiResult<T>;
  }
  if (!response.ok) {
    throw Object.assign(new Error(parsed.error || `controller_http_${response.status}`), {
      status: response.status
    });
  }
  return parsed;
}

async function loadIdentity() {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as NodeIdentity;
    if (parsed.nodeId && parsed.nodeToken?.startsWith("kosh_node_")) return parsed;
  } catch {}
  return null;
}

async function saveIdentity(value: NodeIdentity) {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(statePath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await chmod(statePath, 0o600).catch(() => undefined);
}

async function enroll() {
  if (!enrollmentSecret) throw new Error("KOSH_CLOUD_NODE_ENROLLMENT_SECRET is required for first enrollment.");
  const result = await api<{ node: { id: string }; nodeToken: string }>("/nodes/register", {
    method: "POST",
    enrollment: true,
    body: {
      name: nodeName,
      region: nodeRegion,
      architecture: arch(),
      publicUrl: nodePublicUrl,
      totalSlots,
      capabilities,
      labels: {
        runtime: "docker",
        platform: process.platform,
        hostname: hostname()
      }
    }
  });
  const value = { nodeId: result.node.id, nodeToken: result.nodeToken };
  await saveIdentity(value);
  console.log("Kosh Node enrolled", { nodeId: value.nodeId, name: nodeName, region: nodeRegion });
  return value;
}

async function ensureIdentity() {
  identity ??= await loadIdentity();
  identity ??= await enroll();
  return identity;
}

async function runningManagedCount() {
  const output = await docker(["ps", "--filter", "label=kosh.managed=true", "--format", "{{.ID}}"], 15_000);
  return output ? output.split(/\r?\n/).filter(Boolean).length : 0;
}

async function heartbeat() {
  const current = await ensureIdentity();
  const usedSlots = Math.min(totalSlots, await runningManagedCount());
  try {
    await api(`/nodes/${encodeURIComponent(current.nodeId)}/heartbeat`, {
      method: "POST",
      nodeToken: current.nodeToken,
      body: {
        totalSlots,
        usedSlots,
        publicUrl: nodePublicUrl,
        capabilities,
        labels: {
          runtime: "docker",
          platform: process.platform,
          hostname: hostname()
        }
      }
    });
  } catch (error) {
    if ((error as { status?: number }).status === 401 && enrollmentSecret) {
      identity = await enroll();
      return;
    }
    throw error;
  }
}

function containerName(assignment: Assignment) {
  const safe = assignment.slug.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").slice(0, 40);
  return `kosh-${safe}-${assignment.assignmentGeneration}`.slice(0, 63);
}

async function findContainer(assignment: Assignment) {
  const output = await docker(
    [
      "ps",
      "-a",
      "--filter",
      `label=kosh.deployment.id=${assignment.id}`,
      "--filter",
      `label=kosh.assignment.generation=${assignment.assignmentGeneration}`,
      "--format",
      "{{.ID}}"
    ],
    15_000
  );
  return output.split(/\r?\n/).filter(Boolean)[0] ?? null;
}

async function isContainerRunning(containerId: string) {
  return (await docker(["inspect", "--format", "{{.State.Running}}", containerId], 15_000)) === "true";
}

async function hostPort(containerId: string, containerPort: number) {
  const output = await docker(["port", containerId, `${containerPort}/tcp`], 15_000);
  const line = output.split(/\r?\n/).filter(Boolean)[0] ?? "";
  const match = line.match(/:(\d+)$/);
  if (!match) throw new Error("container_host_port_unavailable");
  return Number(match[1]);
}

async function report(
  assignment: Assignment,
  state: "starting" | "running" | "stopped" | "failed",
  routeUrl: string | null,
  message: string | null = null
) {
  const current = await ensureIdentity();
  await api(`/nodes/${encodeURIComponent(current.nodeId)}/deployments/${encodeURIComponent(assignment.id)}/status`, {
    method: "POST",
    nodeToken: current.nodeToken,
    body: {
      assignmentGeneration: assignment.assignmentGeneration,
      state,
      routeUrl,
      message
    }
  });
}

async function ensureRunning(assignment: Assignment) {
  let containerId = await findContainer(assignment);
  if (containerId && (await isContainerRunning(containerId))) {
    const port = await hostPort(containerId, assignment.containerPort);
    routes.set(assignment.id, { port, generation: assignment.assignmentGeneration });
    if (assignment.state !== "running") {
      await report(
        assignment,
        "running",
        nodePublicUrl ? `${nodePublicUrl}/__kosh/apps/${assignment.id}` : null
      );
    }
    return;
  }

  await report(assignment, "starting", null);
  try {
    if (containerId) await docker(["rm", "-f", containerId], 30_000).catch(() => undefined);
    await docker(["pull", assignment.image], 5 * 60_000);
    containerId = await docker(
      [
        "run",
        "-d",
        "--name",
        containerName(assignment),
        "--restart",
        "unless-stopped",
        "--label",
        "kosh.managed=true",
        "--label",
        `kosh.deployment.id=${assignment.id}`,
        "--label",
        `kosh.assignment.generation=${assignment.assignmentGeneration}`,
        "-p",
        `127.0.0.1::${assignment.containerPort}`,
        assignment.image
      ],
      120_000
    );
    const port = await hostPort(containerId, assignment.containerPort);
    routes.set(assignment.id, { port, generation: assignment.assignmentGeneration });
    await report(
      assignment,
      "running",
      nodePublicUrl ? `${nodePublicUrl}/__kosh/apps/${assignment.id}` : null
    );
    console.log("Kosh deployment running", {
      deployment: assignment.slug,
      generation: assignment.assignmentGeneration,
      localPort: port
    });
  } catch (error) {
    routes.delete(assignment.id);
    await report(
      assignment,
      "failed",
      null,
      error instanceof Error ? error.message.slice(0, 1000) : "container_start_failed"
    ).catch(() => undefined);
    throw error;
  }
}

async function stopAssignment(assignment: Assignment) {
  const containerId = await findContainer(assignment);
  if (containerId) await docker(["rm", "-f", containerId], 45_000).catch(() => undefined);
  routes.delete(assignment.id);
  await report(assignment, "stopped", null);
}

async function managedContainers() {
  const ids = (await docker(["ps", "-a", "--filter", "label=kosh.managed=true", "--format", "{{.ID}}"], 15_000))
    .split(/\r?\n/)
    .filter(Boolean);
  const items: Array<{ id: string; deploymentId: string; generation: number }> = [];
  for (const id of ids) {
    const text = await docker(
      [
        "inspect",
        "--format",
        '{{ index .Config.Labels "kosh.deployment.id" }}|{{ index .Config.Labels "kosh.assignment.generation" }}',
        id
      ],
      15_000
    ).catch(() => "");
    const [deploymentId, rawGeneration] = text.split("|");
    const generation = Number(rawGeneration);
    if (deploymentId && Number.isSafeInteger(generation)) items.push({ id, deploymentId, generation });
  }
  return items;
}

async function fenceStaleContainers(assignments: Assignment[]) {
  const active = new Set(assignments.map((item) => `${item.id}:${item.assignmentGeneration}`));
  for (const container of await managedContainers()) {
    if (active.has(`${container.deploymentId}:${container.generation}`)) continue;
    console.warn("Removing stale Kosh container", container);
    await docker(["rm", "-f", container.id], 45_000).catch(() => undefined);
    routes.delete(container.deploymentId);
  }
}

async function pollOnce() {
  const current = await ensureIdentity();
  const result = await api<{ assignments: Assignment[] }>(
    `/nodes/${encodeURIComponent(current.nodeId)}/assignments`,
    { nodeToken: current.nodeToken }
  );
  const assignments = result.assignments ?? [];
  await fenceStaleContainers(assignments);
  for (const assignment of assignments) {
    if (assignment.state === "stopping") await stopAssignment(assignment);
    else await ensureRunning(assignment);
  }
}

const proxy = createServer((incoming, outgoing) => {
  const requestUrl = new URL(incoming.url ?? "/", "http://kosh-node.local");
  const match = requestUrl.pathname.match(/^\/__kosh\/apps\/([^/]+)(\/.*)?$/);
  if (!match) {
    outgoing.statusCode = 404;
    outgoing.end("Kosh Node route not found.");
    return;
  }
  const target = routes.get(match[1]);
  if (!target) {
    outgoing.statusCode = 503;
    outgoing.end("Kosh deployment is not available on this node.");
    return;
  }

  const headers = { ...incoming.headers, host: `127.0.0.1:${target.port}` };
  delete headers.connection;
  const proxied = httpRequest(
    {
      hostname: "127.0.0.1",
      port: target.port,
      method: incoming.method,
      path: (match[2] || "/") + requestUrl.search,
      headers
    },
    (upstream) => {
      outgoing.statusCode = upstream.statusCode ?? 502;
      for (const [name, value] of Object.entries(upstream.headers)) {
        if (value !== undefined && name.toLowerCase() !== "connection") outgoing.setHeader(name, value);
      }
      outgoing.setHeader("x-kosh-node-generation", String(target.generation));
      upstream.pipe(outgoing);
    }
  );
  proxied.on("error", () => {
    if (!outgoing.headersSent) outgoing.statusCode = 502;
    outgoing.end("Kosh deployment upstream unavailable.");
  });
  incoming.pipe(proxied);
});

async function main() {
  await docker(["version", "--format", "{{.Server.Version}}"], 15_000);
  await ensureIdentity();
  await heartbeat();

  proxy.listen(proxyPort, proxyHost, () => {
    console.log(`Kosh Node proxy listening on http://${proxyHost}:${proxyPort}`);
  });

  let heartbeating = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeating || stopping) return;
    heartbeating = true;
    void heartbeat()
      .catch((error) => console.error("Kosh Node heartbeat failed", error))
      .finally(() => {
        heartbeating = false;
      });
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  while (!stopping) {
    try {
      await pollOnce();
    } catch (error) {
      console.error("Kosh Node assignment poll failed", error);
    }
    await sleep(pollMs);
  }
}

function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`Kosh Node received ${signal}; stopping.`);
  proxy.close(() => undefined);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

void main().catch((error) => {
  console.error("Kosh Node failed", error);
  process.exitCode = 1;
});
