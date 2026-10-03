import { spawn } from "node:child_process";

const port = 4319;
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [new URL("./server.mjs", import.meta.url).pathname], {
  env: {
    ...process.env,
    NODE_ENV: "test",
    KOSH_PLUGIN_PORT: String(port),
    KOSH_ORIGIN: "http://127.0.0.1:4100"
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

async function rpc(id, method, params = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "mcp-protocol-version": "2026-01-26"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  if (!response.ok) throw new Error(`rpc_http_${response.status}`);
  return response.json();
}

try {
  await waitForServer();
  const initialized = await rpc(1, "initialize", {
    protocolVersion: "2026-01-26",
    capabilities: {},
    clientInfo: { name: "kosh-smoke", version: "0.1.0" }
  });
  if (initialized?.result?.serverInfo?.name !== "kosh") {
    throw new Error("initialize_server_info_missing");
  }

  const listed = await rpc(2, "tools/list");
  const tools = listed?.result?.tools;
  if (!Array.isArray(tools) || tools.length < 8) {
    throw new Error("plugin_tools_missing");
  }
  if (tools.some((tool) => tool?.annotations?.readOnlyHint !== true)) {
    throw new Error("plugin_tool_readonly_annotation_missing");
  }

  process.stdout.write(`Kosh MCP smoke passed with ${tools.length} tools.\n`);
} finally {
  child.kill("SIGTERM");
}
