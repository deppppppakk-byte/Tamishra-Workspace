import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? process.env.KOSH_PLUGIN_PORT ?? 4310);
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = Math.max(1000, Math.min(30000, Number(process.env.KOSH_PLUGIN_TIMEOUT_MS ?? 12000)));
const SERVER_NAME = "kosh";
const SERVER_VERSION = "0.2.0";
const DEFAULT_PROTOCOL_VERSION = "2026-01-26";

function normalizeOrigin(value, name = "origin") {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${name} must be an http(s) URL without embedded credentials`);
  }
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS in production`);
  }
  return parsed.toString().replace(/\/$/, "");
}

const KOSH_ORIGIN = normalizeOrigin(process.env.KOSH_ORIGIN?.trim() || "http://localhost:4100", "KOSH_ORIGIN");
const PUBLIC_ORIGIN = normalizeOrigin(process.env.KOSH_PLUGIN_PUBLIC_ORIGIN?.trim() || `http://localhost:${PORT}`, "KOSH_PLUGIN_PUBLIC_ORIGIN");
const OAUTH_ISSUER = normalizeOrigin(process.env.KOSH_OAUTH_ISSUER?.trim() || KOSH_ORIGIN, "KOSH_OAUTH_ISSUER");
const RESOURCE = `${PUBLIC_ORIGIN}/mcp`;
const SERVICE_TOKEN = process.env.KOSH_PLUGIN_TOKEN?.trim() || "";
const ASSERTION_SECRET = process.env.KOSH_PLUGIN_ASSERTION_SECRET?.trim() || "";

if (SERVICE_TOKEN && !SERVICE_TOKEN.startsWith("kosh_pat_")) {
  throw new Error("KOSH_PLUGIN_TOKEN must be a Kosh personal API token");
}
if (process.env.NODE_ENV === "production" && SERVICE_TOKEN) {
  throw new Error("KOSH_PLUGIN_TOKEN is development-only; production MCP must use OAuth");
}
if (process.env.NODE_ENV === "production" && ASSERTION_SECRET.length < 32) {
  throw new Error("KOSH_PLUGIN_ASSERTION_SECRET must be at least 32 characters in production");
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false
};

const objectOutput = {
  type: "object",
  properties: {
    data: {}
  },
  required: ["data"],
  additionalProperties: false
};

const repositoryProperties = {
  namespace: { type: "string", minLength: 1, maxLength: 64 },
  repository: { type: "string", minLength: 1, maxLength: 100 }
};

const tools = [
  {
    name: "discover_kosh",
    title: "Discover Kosh",
    description: "Read the public Kosh API contract and supported capabilities.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: objectOutput,
    annotations: readOnlyAnnotations
  },
  {
    name: "list_repositories",
    title: "List Kosh repositories",
    description: "List repositories visible to the authenticated Kosh user.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: objectOutput,
    annotations: readOnlyAnnotations
  },
  {
    name: "get_repository",
    title: "Get Kosh repository",
    description: "Read repository metadata for one Kosh repository.",
    inputSchema: {
      type: "object",
      properties: repositoryProperties,
      required: ["namespace", "repository"],
      additionalProperties: false
    },
    outputSchema: objectOutput,
    annotations: readOnlyAnnotations
  },
  {
    name: "search_repository",
    title: "Search a Kosh repository",
    description: "Search code, paths, or commits inside one Kosh repository.",
    inputSchema: {
      type: "object",
      properties: {
        ...repositoryProperties,
        query: { type: "string", minLength: 1, maxLength: 500 },
        mode: { type: "string", enum: ["code", "paths", "commits"], default: "code" }
      },
      required: ["namespace", "repository", "query"],
      additionalProperties: false
    },
    outputSchema: objectOutput,
    annotations: readOnlyAnnotations
  },
  {
    name: "list_issues",
    title: "List Kosh issues",
    description: "List work issues visible in one Kosh repository.",
    inputSchema: {
      type: "object",
      properties: repositoryProperties,
      required: ["namespace", "repository"],
      additionalProperties: false
    },
    outputSchema: objectOutput,
    annotations: readOnlyAnnotations
  },
  {
    name: "list_workflow_runs",
    title: "List Kosh workflow runs",
    description: "List recent Automation workflow runs for one Kosh repository.",
    inputSchema: {
      type: "object",
      properties: repositoryProperties,
      required: ["namespace", "repository"],
      additionalProperties: false
    },
    outputSchema: objectOutput,
    annotations: readOnlyAnnotations
  },
  {
    name: "list_releases",
    title: "List Kosh releases",
    description: "List release resources for one Kosh repository.",
    inputSchema: {
      type: "object",
      properties: repositoryProperties,
      required: ["namespace", "repository"],
      additionalProperties: false
    },
    outputSchema: objectOutput,
    annotations: readOnlyAnnotations
  },
  {
    name: "repository_readiness",
    title: "Check Kosh repository readiness",
    description: "Read evidence-based production readiness for one Kosh repository.",
    inputSchema: {
      type: "object",
      properties: repositoryProperties,
      required: ["namespace", "repository"],
      additionalProperties: false
    },
    outputSchema: objectOutput,
    annotations: readOnlyAnnotations
  }
];

function json(response, status, payload, protocolVersion = DEFAULT_PROTOCOL_VERSION) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("mcp-protocol-version", protocolVersion);
  response.end(JSON.stringify(payload));
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data })
    }
  };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request_too_large"), { status: 413 });
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function incomingBearer(request) {
  const header = String(request.headers.authorization ?? "").trim();
  if (/^Bearer\s+/i.test(header)) return header;
  return SERVICE_TOKEN ? `Bearer ${SERVICE_TOKEN}` : "";
}

async function introspectOAuthToken(authorization) {
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const response = await fetch(`${OAUTH_ISSUER}/v1/kosh/oauth/introspect`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    redirect: "error"
  });
  if (!response.ok) return false;
  const payload = await response.json().catch(() => null);
  return Boolean(payload?.active && payload?.resource === RESOURCE && String(payload?.scope ?? "").split(/\s+/).includes("repo:read"));
}

async function requireOAuth(request) {
  const authorization = incomingBearer(request);
  if (!authorization || !(await introspectOAuthToken(authorization))) {
    throw Object.assign(new Error("kosh_oauth_required"), { status: 401 });
  }
  return authorization;
}

async function callKosh(request, path, authenticated = true) {
  const authorization = authenticated ? await requireOAuth(request) : incomingBearer(request);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref();
  try {
    const headers = { accept: "application/json" };
    if (authenticated && authorization) {
      headers.authorization = authorization;
      headers["x-kosh-mcp-resource"] = RESOURCE;
      headers["x-kosh-plugin-assertion"] = ASSERTION_SECRET;
    }
    const response = await fetch(KOSH_ORIGIN + path, {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text.slice(0, 4000) };
      }
    }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload
        ? String(payload.error)
        : `kosh_http_${response.status}`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function requiredString(args, key, maxLength) {
  const value = typeof args?.[key] === "string" ? args[key].trim() : "";
  if (!value || value.length > maxLength) throw new Error(`invalid_${key}`);
  return value;
}

function repositoryPath(args) {
  const namespace = requiredString(args, "namespace", 64);
  const repository = requiredString(args, "repository", 100);
  return `/v1/kosh/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}`;
}

async function executeTool(request, name, args = {}) {
  switch (name) {
    case "discover_kosh":
      return callKosh(request, "/v1/kosh/api", false);
    case "list_repositories":
      return callKosh(request, "/v1/kosh/api/repositories");
    case "get_repository":
      return callKosh(request, repositoryPath(args));
    case "search_repository": {
      const query = requiredString(args, "query", 500);
      const mode = ["code", "paths", "commits"].includes(args?.mode) ? args.mode : "code";
      return callKosh(
        request,
        `${repositoryPath(args)}/platform/search?q=${encodeURIComponent(query)}&mode=${encodeURIComponent(mode)}`
      );
    }
    case "list_issues":
      return callKosh(request, `${repositoryPath(args)}/work/issues`);
    case "list_workflow_runs":
      return callKosh(request, `${repositoryPath(args)}/automation/runs`);
    case "list_releases":
      return callKosh(request, `${repositoryPath(args)}/platform/resources?type=release`);
    case "repository_readiness":
      return callKosh(request, `${repositoryPath(args)}/systems/readiness`);
    default:
      throw Object.assign(new Error("unknown_tool"), { status: 404 });
  }
}

function toolResult(data) {
  const structured = { data };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2).slice(0, 50000) }],
    structuredContent: structured
  };
}

async function handleRpc(request, message) {
  const id = Object.prototype.hasOwnProperty.call(message ?? {}, "id") ? message.id : undefined;
  const method = typeof message?.method === "string" ? message.method : "";
  if (!method) return rpcError(id, -32600, "Invalid Request");

  if (method === "initialize") {
    const requestedVersion = typeof message.params?.protocolVersion === "string"
      ? message.params.protocolVersion
      : DEFAULT_PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Kosh tools are read-only. Use them to inspect repositories, work, automation, releases and readiness. Never request or expose API token values."
    });
  }

  if (method === "ping") return rpcResult(id, {});
  if (method === "notifications/initialized") return null;
  if (method === "tools/list") return rpcResult(id, { tools });

  if (method === "tools/call") {
    const name = typeof message.params?.name === "string" ? message.params.name : "";
    const args = message.params?.arguments && typeof message.params.arguments === "object"
      ? message.params.arguments
      : {};
    try {
      return rpcResult(id, toolResult(await executeTool(request, name, args)));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "tool_failed";
      return rpcResult(id, {
        content: [{ type: "text", text: messageText }],
        structuredContent: { data: null },
        isError: true
      });
    }
  }

  return rpcError(id, -32601, "Method not found", { method });
}

function protectedResourceMetadata() {
  return {
    resource: RESOURCE,
    authorization_servers: [OAUTH_ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["repo:read"],
    resource_name: "Kosh MCP"
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://kosh-plugin.local");

    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, {
        service: "kosh-chatgpt-plugin",
        status: "ok",
        koshOrigin: KOSH_ORIGIN,
        publicOrigin: PUBLIC_ORIGIN,
        oauthIssuer: OAUTH_ISSUER,
        authentication: "oauth"
      });
      return;
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource" ||
        url.pathname === "/.well-known/oauth-protected-resource/mcp")
    ) {
      json(response, 200, protectedResourceMetadata());
      return;
    }

    if (url.pathname !== "/mcp") {
      json(response, 404, { error: "not_found" });
      return;
    }

    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("allow", "POST,OPTIONS");
      response.end();
      return;
    }

    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("allow", "POST,OPTIONS");
      response.end();
      return;
    }

    if (!incomingBearer(request)) {
      response.statusCode = 401;
      response.setHeader("www-authenticate", `Bearer resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource"`);
      json(response, 401, { error: "oauth_required" });
      return;
    }

    const body = await readBody(request);
    if (!body) {
      json(response, 400, rpcError(null, -32700, "Empty request"));
      return;
    }

    if (!(await introspectOAuthToken(incomingBearer(request)))) {
      response.statusCode = 401;
      response.setHeader("www-authenticate", `Bearer resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource"`);
      json(response, 401, { error: "invalid_token" });
      return;
    }

    const protocolVersion = String(request.headers["mcp-protocol-version"] ?? DEFAULT_PROTOCOL_VERSION);
    if (Array.isArray(body)) {
      const replies = (await Promise.all(body.map((item) => handleRpc(request, item)))).filter(Boolean);
      if (!replies.length) {
        response.statusCode = 202;
        response.end();
        return;
      }
      json(response, 200, replies, protocolVersion);
      return;
    }

    const reply = await handleRpc(request, body);
    if (!reply) {
      response.statusCode = 202;
      response.end();
      return;
    }
    json(response, 200, reply, protocolVersion);
  } catch (error) {
    const status = Number(error?.status) || 500;
    json(response, status, rpcError(null, status === 413 ? -32001 : -32603, error instanceof Error ? error.message : "internal_error"));
  }
});

server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.keepAliveTimeout = 5000;

server.listen(PORT, () => {
  console.log(`Kosh ChatGPT plugin MCP server listening on :${PORT}/mcp`);
});