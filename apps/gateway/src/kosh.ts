import { timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createKoshStore, type KoshVisibility } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const store = createKoshStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");
const isProduction = process.env.NODE_ENV === "production";

type JsonBody = Record<string, unknown>;

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  allowedOrigins?: Set<string>
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

function validSegment(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value);
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

async function readJson(request: IncomingMessage, limit = 1024 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > limit) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(value);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonBody;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureBareRepository(namespace: string, slug: string) {
  const namespacePath = resolve(repositoryRoot, namespace);
  const repositoryPath = resolve(namespacePath, slug + ".git");
  const rootPrefix = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;

  if (!repositoryPath.startsWith(rootPrefix)) {
    throw Object.assign(new Error("invalid_repository_path"), { status: 400 });
  }

  await mkdir(namespacePath, { recursive: true });
  if (await pathExists(resolve(repositoryPath, "HEAD"))) {
    return repositoryPath;
  }

  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", repositoryPath], {
    timeout: 20_000
  });

  await execFileAsync(
    "git",
    ["--git-dir", repositoryPath, "config", "http.receivepack", "true"],
    { timeout: 10_000 }
  );

  return repositoryPath;
}

function publicOrigin(request: IncomingMessage) {
  const configured = process.env.KOSH_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");

  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    ?.trim();
  const protocol = forwardedProto || (isProduction ? "https" : "http");
  const host = request.headers.host || "localhost:4100";
  return protocol + "://" + host;
}

function suppliedGitToken(request: IncomingMessage) {
  const authorization = request.headers.authorization?.trim();
  if (!authorization) return "";

  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  if (authorization.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      return separator >= 0 ? decoded.slice(separator + 1) : decoded;
    } catch {
      return "";
    }
  }

  return "";
}

function tokenMatches(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function gitWriteAuthorized(request: IncomingMessage) {
  const expected = process.env.KOSH_GIT_TOKEN?.trim();
  if (!expected) return !isProduction;
  return tokenMatches(suppliedGitToken(request), expected);
}

function isGitWrite(url: URL) {
  return (
    url.pathname.endsWith("/git-receive-pack") ||
    url.searchParams.get("service") === "git-receive-pack"
  );
}

async function handleGitHttp(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  const match = url.pathname.match(
    /^\/git\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\.git(\/.*)?$/
  );
  if (!match) return false;

  const namespace = match[1];
  const slug = match[2];
  const suffix = match[3] || "";
  const repositoryPath = resolve(repositoryRoot, namespace, slug + ".git");

  if (!(await pathExists(resolve(repositoryPath, "HEAD")))) {
    response.statusCode = 404;
    response.end("Repository not found.");
    return true;
  }

  const write = isGitWrite(url);
  if (write && !gitWriteAuthorized(request)) {
    const configured = Boolean(process.env.KOSH_GIT_TOKEN?.trim());
    response.statusCode = configured ? 401 : 503;
    response.setHeader("www-authenticate", 'Basic realm="Kosh Git"');
    response.end(
      configured
        ? "Authentication required."
        : "KOSH_GIT_TOKEN is required for production pushes."
    );
    return true;
  }

  const pathInfo = "/" + namespace + "/" + slug + ".git" + suffix;
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: repositoryRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: pathInfo,
      QUERY_STRING: url.searchParams.toString(),
      REQUEST_METHOD: request.method || "GET",
      CONTENT_TYPE: String(request.headers["content-type"] ?? ""),
      CONTENT_LENGTH: String(request.headers["content-length"] ?? ""),
      REMOTE_USER: write ? "kosh-user" : "",
      REMOTE_ADDR: request.socket.remoteAddress || "",
      HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] ?? "")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });

  child.on("error", (error) => {
    if (!response.headersSent) {
      response.statusCode = 500;
      response.end("Kosh Git backend failed: " + error.message);
    } else {
      response.end();
    }
  });

  child.stdout.on("data", (chunk: Buffer) => {
    if (headersSent) {
      if (!response.write(chunk)) child.stdout.pause();
      return;
    }

    headerBuffer = Buffer.concat([headerBuffer, chunk]);
    let separator = headerBuffer.indexOf("\r\n\r\n");
    let separatorLength = 4;
    if (separator < 0) {
      separator = headerBuffer.indexOf("\n\n");
      separatorLength = 2;
    }
    if (separator < 0) return;

    const rawHeaders = headerBuffer.subarray(0, separator).toString("utf8");
    const body = headerBuffer.subarray(separator + separatorLength);

    for (const line of rawHeaders.split(/\r?\n/)) {
      const index = line.indexOf(":");
      if (index <= 0) continue;
      const name = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (name.toLowerCase() === "status") {
        const status = Number(value.split(" ")[0]);
        if (Number.isFinite(status)) response.statusCode = status;
      } else {
        response.setHeader(name, value);
      }
    }

    response.setHeader("x-content-type-options", "nosniff");
    headersSent = true;
    if (body.length) response.write(body);
  });

  response.on("drain", () => child.stdout.resume());

  child.on("close", (code) => {
    if (!headersSent && !response.headersSent) {
      response.statusCode = code === 0 ? 200 : 500;
      response.end(
        code === 0
          ? ""
          : "Kosh Git backend exited with code " + code + (stderr ? "\n" + stderr : "")
      );
      return;
    }
    response.end();
  });

  if (request.method === "POST") request.pipe(child.stdin);
  else child.stdin.end();

  return true;
}

export async function handleKoshRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: Set<string>
) {
  if (url.pathname.startsWith("/git/")) {
    return handleGitHttp(request, response, url);
  }

  if (!url.pathname.startsWith("/v1/kosh")) return false;

  if (request.method === "GET" && url.pathname === "/v1/kosh") {
    await store.ready();
    json(
      response,
      200,
      {
        product: "Kosh",
        by: "Tamishra",
        gitProtocol: "smart-http",
        persistence: store.kind,
        gitStorage: process.env.KOSH_REPO_ROOT
          ? "configured-persistent-path"
          : "local-default-path",
        modules: [
          "repositories",
          "reviews",
          "work",
          "automation",
          "packages",
          "releases",
          "security",
          "extensions"
        ]
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/kosh/repos") {
    const repositories = await store.list();
    json(
      response,
      200,
      {
        repositories,
        persistence: store.kind,
        gitStorage: process.env.KOSH_REPO_ROOT
          ? "configured-persistent-path"
          : "local-default-path"
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/kosh/repos") {
    if (origin && !allowedOrigins.has(origin)) {
      json(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
      return true;
    }

    try {
      const body = await readJson(request);
      const namespace = String(body.namespace ?? "").trim();
      const name = String(body.name ?? "").trim();
      const slug = slugify(name);
      const description = String(body.description ?? "").trim().slice(0, 500);
      const visibility = String(body.visibility ?? "private") as KoshVisibility;

      if (!validSegment(namespace) || !validSegment(slug) || !name || name.length > 100) {
        json(response, 400, { error: "invalid_repository_name" }, origin, allowedOrigins);
        return true;
      }

      if (!["private", "internal", "public"].includes(visibility)) {
        json(response, 400, { error: "invalid_visibility" }, origin, allowedOrigins);
        return true;
      }

      await ensureBareRepository(namespace, slug);
      const cloneHttpUrl =
        publicOrigin(request) + "/git/" + namespace + "/" + slug + ".git";
      const repository = await store.create({
        namespace,
        slug,
        name,
        description,
        visibility,
        defaultBranch: "main",
        state: "ready",
        cloneHttpUrl
      });

      json(response, 201, repository, origin, allowedOrigins);
    } catch (error) {
      const status =
        typeof error === "object" && error && "status" in error
          ? Number((error as { status?: number }).status) || 500
          : 500;
      const message =
        error instanceof Error ? error.message : "repository_creation_failed";
      json(response, status, { error: message }, origin, allowedOrigins);
    }
    return true;
  }

  json(response, 404, { error: "kosh_route_not_found" }, origin, allowedOrigins);
  return true;
}
