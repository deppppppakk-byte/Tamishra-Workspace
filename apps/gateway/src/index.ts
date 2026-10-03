import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleMeetingRequest } from "./meetings.js";
import { handleIdentityRequest } from "./identity.js";
import { handlePatraRequest } from "./patra.js";
import { handleDocsRequest } from "./docs.js";
import { handleFilesRequest } from "./files.js";
import { handleContentRequest } from "./content.js";
import { handleAssetsRequest } from "./assets.js";
import { handleChatRequest } from "./chat.js";
import { handleKoshRequest } from "./kosh.js";
import { handleKoshWikiRequest } from "./kosh-wiki.js";
import { handleKoshPagesAdminRequest } from "./kosh-pages.js";
import { handleKoshWebhookRequest } from "./kosh-webhooks.js";
import { handleKoshAdministrationGate } from "./kosh-admin-gate.js";

const port = Number(process.env.WORKSPACE_GATEWAY_PORT ?? process.env.PORT ?? 4100);
const isProduction = process.env.NODE_ENV === "production";

function requireProductionValue(name: string, minimumLength = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength || /^change-me/i.test(value)) {
    throw new Error(`Production configuration requires a secure ${name} value.`);
  }
  return value;
}

function validateProductionConfiguration() {
  if (!isProduction) return;

  const coreOnly = process.env.WORKSPACE_CORE_ONLY === "true";

  if (!coreOnly) {
    requireProductionValue("WORKSPACE_DATABASE_URL", 12);
    requireProductionValue("LIVEKIT_URL", 8);
    requireProductionValue("LIVEKIT_API_KEY", 6);
    requireProductionValue("LIVEKIT_API_SECRET", 24);
  }

  requireProductionValue("WORKSPACE_IP_HASH_SECRET", 32);

  if (process.env.WORKSPACE_SESSION_COOKIE_SECURE === "false") {
    throw new Error("WORKSPACE_SESSION_COOKIE_SECURE must not be false in production.");
  }

  const allowed = process.env.WORKSPACE_ALLOWED_ORIGINS?.trim();
  if (!allowed) {
    throw new Error("WORKSPACE_ALLOWED_ORIGINS is required in production.");
  }

  if (process.env.KOSH_PUBLIC_ORIGIN?.trim()) {
    requireProductionValue("KOSH_REPO_ROOT", 2);
    requireProductionValue("KOSH_GIT_TOKEN", 24);
    requireProductionValue("KOSH_RUNNER_TOKEN", 24);
  }

  if (process.env.KOSH_SSH_PUBLIC_HOST?.trim()) {
    requireProductionValue("KOSH_SSH_SERVICE_TOKEN", 24);
    requireProductionValue("KOSH_REPO_ROOT", 2);
  }

  if (!coreOnly) {
    const liveKitUrl = process.env.LIVEKIT_URL ?? "";
    if (!/^wss:\/\//i.test(liveKitUrl)) {
      throw new Error("LIVEKIT_URL must use wss:// in production.");
    }
  }
}

validateProductionConfiguration();

const allowedOrigins = new Set(
  (
    process.env.WORKSPACE_ALLOWED_ORIGINS ??
    [
      process.env.WORKSPACE_WEB_ORIGIN ?? "http://localhost:3000",
      "http://tauri.localhost",
      "tauri://localhost",
      "https://localhost",
      "capacitor://localhost"
    ].join(",")
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function applySecurityHeaders(response: ServerResponse) {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("cross-origin-resource-policy", "same-site");
  response.setHeader(
    "permissions-policy",
    "geolocation=(), payment=(), usb=(), serial=(), interest-cohort=()"
  );
}

function applyCors(response: ServerResponse, origin?: string) {
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
}

function json(
  response: ServerResponse,
  status: number,
  body: JsonValue,
  origin?: string
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  applySecurityHeaders(response);
  applyCors(response, origin);
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse, origin?: string) {
  json(response, 404, { error: "not_found" }, origin);
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  applySecurityHeaders(response);

  const origin = request.headers.origin;
  const url = new URL(request.url ?? "/", "http://workspace.local");

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader(
        "access-control-allow-methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS"
      );
      response.setHeader(
        "access-control-allow-headers",
        "content-type,authorization,x-patra-company-provisioning-secret"
      );
      response.setHeader("vary", "origin");
    }
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    json(
      response,
      200,
      {
        service: "tamishra-workspace-gateway",
        status: "ok",
        version: process.env.WORKSPACE_RELEASE_VERSION ?? "0.9.0",
        mode: process.env.WORKSPACE_CORE_ONLY === "true" ? "core" : "full",
        persistence: process.env.WORKSPACE_DATABASE_URL ? "postgres" : "ephemeral"
      },
      origin
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/ready") {
    json(
      response,
      200,
      {
        service: "tamishra-workspace-gateway",
        status: "ready",
        production: isProduction
      },
      origin
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/workspace") {
    json(
      response,
      200,
      {
        product: "Tamishra Workspace",
        standalone: true,
        apps: [
          "docs",
          "sheets",
          "slides",
          "pdf",
          "chat",
          "mail",
          "meet",
          "notes",
          "forms",
          "files",
          "kosh"
        ]
      },
      origin
    );
    return;
  }

  if (
    await handleKoshAdministrationGate(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleKoshWebhookRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleKoshPagesAdminRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleKoshWikiRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleKoshRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleDocsRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleFilesRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleContentRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleAssetsRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handlePatraRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleIdentityRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleChatRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  if (
    await handleMeetingRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return;
  }

  notFound(response, origin);
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error) => {
    console.error("Workspace gateway request failed", error);
    if (!response.headersSent) {
      json(response, 500, { error: "internal_error" }, request.headers.origin);
    } else {
      response.end();
    }
  });
});

server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 1_000;

function shutdown(signal: string) {
  console.log(`Tamishra Workspace gateway received ${signal}; shutting down.`);
  server.close((error) => {
    if (error) {
      console.error("Gateway shutdown failed", error);
      process.exitCode = 1;
    }
  });

  setTimeout(() => {
    console.error("Gateway shutdown timed out.");
    process.exit(1);
  }, 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

server.listen(port, () => {
  console.log(`Tamishra Workspace gateway listening on :${port}`);
});