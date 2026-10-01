import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleMeetingRequest } from "./meetings.js";

const port = Number(process.env.WORKSPACE_GATEWAY_PORT ?? process.env.PORT ?? 4100);
const allowedOrigin = process.env.WORKSPACE_WEB_ORIGIN ?? "http://localhost:3000";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function json(
  response: ServerResponse,
  status: number,
  body: JsonValue,
  origin?: string
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");

  if (origin && origin === allowedOrigin) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }

  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse, origin?: string) {
  json(response, 404, { error: "not_found" }, origin);
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const origin = request.headers.origin;
  const url = new URL(request.url ?? "/", "http://workspace.local");

  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    if (origin === allowedOrigin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type,authorization");
      response.setHeader("vary", "origin");
    }
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, {
      service: "tamishra-workspace-gateway",
      status: "ok",
      version: "0.2.0"
    }, origin);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/workspace") {
    json(response, 200, {
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
        "files"
      ]
    }, origin);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/mail/providers") {
    json(response, 200, {
      providers: [
        { key: "tamishra", method: "native", status: "primary" },
        { key: "imap-smtp", method: "gateway-secret", status: "optional" }
      ]
    }, origin);
    return;
  }

  if (await handleMeetingRequest(request, response, url, origin, allowedOrigin)) {
    return;
  }

  notFound(response, origin);
}

createServer((request, response) => {
  void handle(request, response).catch((error) => {
    console.error("Workspace gateway request failed", error);
    if (!response.headersSent) {
      json(response, 500, { error: "internal_error" }, request.headers.origin);
    } else {
      response.end();
    }
  });
}).listen(port, () => {
  console.log(`Tamishra Workspace gateway listening on :${port}`);
});
