import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");

function repositoryPath(namespace: string, slug: string) {
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_repository_path"), { status: 400 });
  }
  return path;
}

function safeGitPath(value: string) {
  const decoded = decodeURIComponent(value)
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!decoded) return "";
  if (
    decoded.length > 2048 ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw Object.assign(new Error("invalid_page_path"), { status: 400 });
  }
  return decoded;
}

function contentType(path: string) {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    pdf: "application/pdf"
  };
  return types[extension] ?? "application/octet-stream";
}

async function gitBuffer(gitDir: string, args: string[]) {
  try {
    const result = await execFileAsync(
      "git",
      ["--git-dir", gitDir, ...args],
      {
        timeout: 20_000,
        maxBuffer: 10 * 1024 * 1024
      }
    );
    return Buffer.isBuffer(result.stdout)
      ? result.stdout
      : Buffer.from(result.stdout);
  } catch {
    return null;
  }
}

export async function handleKoshPagesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  const match = url.pathname.match(
    /^\/pages\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})(?:\/(.*))?$/
  );
  if (!match) return false;

  const namespace = match[1];
  const slug = match[2];
  const requestedPath = safeGitPath(match[3] ?? "");
  const repository = await repositoryStore.get(namespace, slug);

  if (!repository) {
    response.statusCode = 404;
    response.end("Kosh Pages site not found.");
    return true;
  }

  const authorization = await authorizeKoshRepositoryRequest(
    request,
    repository,
    "repository.read"
  );

  if (!authorization.decision.allowed) {
    response.statusCode = authorization.identity ? 403 : 401;
    response.end(
      authorization.identity
        ? "Kosh Pages access denied."
        : "Authentication required."
    );
    return true;
  }

  const sites = await platformStore.listResources("page_site", repository.id);
  const site = sites.find((item) => item.state === "active");
  if (!site) {
    response.statusCode = 404;
    response.end("Kosh Pages is not enabled for this repository.");
    return true;
  }

  const branch = String(
    site.payload.sourceBranch ?? repository.defaultBranch
  ).trim();
  const sourcePath = safeGitPath(String(site.payload.sourcePath ?? ""));
  const gitDir = repositoryPath(namespace, slug);

  const commit = await gitBuffer(
    gitDir,
    ["rev-parse", "--verify", "refs/heads/" + branch + "^{commit}"]
  );
  const commitSha = commit?.toString("utf8").trim() ?? "";
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    response.statusCode = 404;
    response.end("Pages source branch not found.");
    return true;
  }

  const relative =
    requestedPath ||
    String(site.payload.indexFile ?? "index.html").trim() ||
    "index.html";
  const candidates = [
    [sourcePath, relative].filter(Boolean).join("/"),
    [sourcePath, relative, "index.html"].filter(Boolean).join("/")
  ];

  let body: Buffer | null = null;
  let resolvedPath = "";
  for (const candidate of candidates) {
    const path = safeGitPath(candidate);
    body = await gitBuffer(
      gitDir,
      ["show", commitSha + ":" + path]
    );
    if (body) {
      resolvedPath = path;
      break;
    }
  }

  if (!body) {
    response.statusCode = 404;
    response.end("Page not found.");
    return true;
  }

  response.statusCode = 200;
  response.setHeader("content-type", contentType(resolvedPath));
  response.setHeader("content-length", String(body.length));
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader(
    "content-security-policy",
    "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  response.setHeader(
    "cache-control",
    repository.visibility === "public"
      ? "public, max-age=60"
      : "private, no-store"
  );
  response.setHeader("etag", '"' + commitSha + "-" + resolvedPath + '"');
  response.end(body);
  return true;
}
