import { spawn } from "node:child_process";
import { createServer } from "node:http";

const port = 4319;
const gatewayPort = 4321;
const origin = `http://127.0.0.1:${port}`;
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
const resource = `${origin}/mcp`;
const assertion = "kosh-smoke-assertion-secret-000000000001";
const accessToken = "kosh_oat_smoke_token";

const mockGateway = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/v1/kosh/oauth/introspect") {
    const active = request.headers.authorization === `Bearer ${accessToken}` &&
      request.headers["x-kosh-oauth-resource"] === resource &&
      request.headers["x-kosh-plugin-assertion"] === assertion;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(active ? {
      active: true,
      client_id: "kosh_client_smoke",
      sub: "user-smoke",
      scope: "repo:read",
      resource
    } : { active: false }));
    return;
  }
  response.statusCode = 404;
  response.end();
});

await new Promise((resolve, reject) => {
  mockGateway.once("error", reject);
  mockGateway.listen(gatewayPort, "127.0.0.1", resolve);
});

const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    KOSH_PLUGIN_PORT: "",
    KOSH_ORIGIN: gatewayOrigin,
    KOSH_PLUGIN_PUBLIC_ORIGIN: origin,
    KOSH_OAUTH_ISSUER: gatewayOrigin,
    KOSH_PLUGIN_ASSERTION_SECRET: assertion
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Startup race.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`plugin_server_start_failed: ${stderr}`);
}

async function rpc(id, method, params = {}, authenticated = true) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2026-01-26",
      ...(authenticated ? { authorization: `Bearer ${accessToken}` } : {})
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  return response;
}

try {
  await waitForServer();

  const metadataResponse = await fetch(`${origin}/.well-known/oauth-protected-resource`);
  if (!metadataResponse.ok) throw new Error("protected_resource_metadata_missing");
  const metadata = await metadataResponse.json();
  if (metadata?.resource !== resource || metadata?.authorization_servers?.[0] !== gatewayOrigin) {
    throw new Error("protected_resource_metadata_invalid");
  }

  const unauthorized = await rpc(0, "initialize", {}, false);
  if (unauthorized.status !== 401) throw new Error(`oauth_challenge_status_${unauthorized.status}`);
  const challenge = unauthorized.headers.get("www-authenticate") ?? "";
  if (!challenge.includes("oauth-protected-resource") || !challenge.includes("repo:read")) {
    throw new Error("oauth_challenge_missing_metadata");
  }

  const initializeResponse = await rpc(1, "initialize", {
    protocolVersion: "2026-01-26",
    capabilities: {},
    clientInfo: { name: "kosh-smoke", version: "0.2.0" }
  });
  if (!initializeResponse.ok) throw new Error(`initialize_http_${initializeResponse.status}`);
  const initialized = await initializeResponse.json();
  if (initialized?.result?.serverInfo?.name !== "kosh") {
    throw new Error("initialize_server_info_missing");
  }

  const listResponse = await rpc(2, "tools/list");
  if (!listResponse.ok) throw new Error(`tools_list_http_${listResponse.status}`);
  const listed = await listResponse.json();
  const tools = listed?.result?.tools;
  if (!Array.isArray(tools) || tools.length < 8) {
    throw new Error("plugin_tools_missing");
  }
  if (tools.some((tool) => tool?.annotations?.readOnlyHint !== true)) {
    throw new Error("plugin_tool_readonly_annotation_missing");
  }

  process.stdout.write(`Kosh MCP OAuth smoke passed with ${tools.length} tools on platform PORT.\n`);
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => mockGateway.close(resolve));
}
