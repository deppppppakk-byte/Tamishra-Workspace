import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import {
  getKoshPlatformStore,
  type StoredKoshPlatformResource
} from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");

type JsonBody = Record<string, unknown>;

class PagesError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  allowedOrigins?: ReadonlySet<string>
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

async function readJson(
  request: IncomingMessage,
  limit = 256 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new PagesError("pages_payload_too_large", 413);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonBody)
      : {};
  } catch {
    throw new PagesError("invalid_json", 400);
  }
}

function repositoryPath(namespace: string, slug: string) {
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;
  if (!path.startsWith(prefix)) {
    throw new PagesError("invalid_repository_path", 400);
  }
  return path;
}

function safeGitPath(value: string, decode = false) {
  let input = value;
  if (decode) {
    try {
      input = decodeURIComponent(value);
    } catch {
      throw new PagesError("invalid_page_path", 400);
    }
  }
  const cleaned = input.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!cleaned) return "";
  if (
    cleaned.length > 2048 ||
    cleaned.includes("\0") ||
    cleaned.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new PagesError("invalid_page_path", 400);
  }
  return cleaned;
}

function validBranch(value: string) {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.includes("//") &&
    !value.endsWith("/")
  );
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function maxPageFileBytes() {
  return Math.floor(clamp(process.env.KOSH_PAGES_MAX_FILE_MB, 20, 1, 100) * 1024 * 1024);
}

function maxSiteBytes() {
  return Math.floor(clamp(process.env.KOSH_PAGES_MAX_SITE_MB, 250, 10, 2048) * 1024 * 1024);
}

function maxSiteFiles() {
  return Math.floor(clamp(process.env.KOSH_PAGES_MAX_FILES, 5000, 10, 50000));
}

function contentType(path: string) {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    cjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    txt: "text/plain; charset=utf-8",
    xml: "application/xml; charset=utf-8",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    pdf: "application/pdf",
    wasm: "application/wasm",
    webmanifest: "application/manifest+json"
  };
  return types[extension] ?? "application/octet-stream";
}

async function gitText(gitDir: string, args: string[], maxBuffer = 16 * 1024 * 1024) {
  try {
    const result = await execFileAsync("git", ["--git-dir", gitDir, ...args], {
      timeout: 20_000,
      maxBuffer,
      encoding: "utf8"
    });
    return String(result.stdout);
  } catch (error) {
    const value = error as { stderr?: string };
    throw new PagesError(String(value.stderr || "pages_git_command_failed").trim(), 409);
  }
}

async function gitBuffer(gitDir: string, args: string[], maxBuffer = maxPageFileBytes()) {
  try {
    const result = await execFileAsync("git", ["--git-dir", gitDir, ...args], {
      timeout: 20_000,
      maxBuffer
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch {
    return null;
  }
}

async function resolveBranchCommit(gitDir: string, branch: string) {
  if (!validBranch(branch)) throw new PagesError("invalid_pages_source_branch");
  const sha = (
    await gitText(gitDir, ["rev-parse", "--verify", "refs/heads/" + branch + "^{commit}"], 1024 * 1024)
  ).trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new PagesError("pages_source_branch_not_found", 404);
  return sha;
}

function siteResource(resources: StoredKoshPlatformResource[]) {
  return (
    resources.find((item) => item.payload.kind === "site") ??
    resources.find((item) => item.payload.kind !== "deployment") ??
    null
  );
}

function deployments(resources: StoredKoshPlatformResource[]) {
  return resources
    .filter((item) => item.payload.kind === "deployment")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function deploymentView(resource: StoredKoshPlatformResource) {
  return {
    id: resource.id,
    commitSha: String(resource.payload.commitSha ?? ""),
    sourceBranch: String(resource.payload.sourceBranch ?? ""),
    sourcePath: String(resource.payload.sourcePath ?? ""),
    indexFile: String(resource.payload.indexFile ?? "index.html"),
    spaFallback: Boolean(resource.payload.spaFallback),
    fileCount: Number(resource.payload.fileCount ?? 0),
    totalBytes: Number(resource.payload.totalBytes ?? 0),
    publishedByName: resource.createdByName,
    publishedAt: resource.createdAt
  };
}

function publicOrigin(request: IncomingMessage) {
  const configured = process.env.KOSH_PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/$/, "");
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    ?.trim();
  const protocol = forwardedProto || (process.env.NODE_ENV === "production" ? "https" : "http");
  return protocol + "://" + (request.headers.host || "localhost:4100");
}

function siteView(
  request: IncomingMessage,
  namespace: string,
  slug: string,
  site: StoredKoshPlatformResource | null,
  siteDeployments: StoredKoshPlatformResource[]
) {
  const activeId = String(site?.payload.activeDeploymentId ?? "");
  const active = siteDeployments.find((item) => item.id === activeId) ?? null;
  return {
    site: site
      ? {
          id: site.id,
          state: site.state,
          sourceBranch: String(site.payload.sourceBranch ?? "main"),
          sourcePath: String(site.payload.sourcePath ?? ""),
          indexFile: String(site.payload.indexFile ?? "index.html"),
          spaFallback: Boolean(site.payload.spaFallback),
          cacheSeconds: Number(site.payload.cacheSeconds ?? 60),
          activeDeploymentId: activeId || null,
          updatedAt: site.updatedAt
        }
      : null,
    activeDeployment: active ? deploymentView(active) : null,
    deployments: siteDeployments.slice(0, 50).map(deploymentView),
    publicUrl: publicOrigin(request) + "/pages/" + encodeURIComponent(namespace) + "/" + encodeURIComponent(slug) + "/",
    limits: {
      maxFileBytes: maxPageFileBytes(),
      maxSiteBytes: maxSiteBytes(),
      maxFiles: maxSiteFiles()
    }
  };
}

async function validateSource(
  gitDir: string,
  commitSha: string,
  sourcePath: string,
  indexFile: string
) {
  const treeish = sourcePath ? commitSha + ":" + sourcePath : commitSha;
  let output: string;
  try {
    output = await gitText(gitDir, ["ls-tree", "-r", "-z", "--long", treeish]);
  } catch {
    throw new PagesError("pages_source_path_not_found", 404);
  }

  const maxFiles = maxSiteFiles();
  const maxBytes = maxSiteBytes();
  const maxFile = maxPageFileBytes();
  let fileCount = 0;
  let totalBytes = 0;
  let indexFound = false;

  for (const record of output.split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab).trim().split(/\s+/);
    const path = record.slice(tab + 1);
    const mode = meta[0] ?? "";
    const type = meta[1] ?? "";
    const size = Number(meta[3] ?? 0);
    if (type !== "blob") continue;
    if (mode === "120000") throw new PagesError("pages_symlinks_not_supported", 400);
    if (!Number.isFinite(size) || size < 0) throw new PagesError("pages_invalid_source_tree", 409);
    if (size > maxFile) throw new PagesError("pages_file_too_large", 413);
    fileCount += 1;
    totalBytes += size;
    if (fileCount > maxFiles) throw new PagesError("pages_too_many_files", 413);
    if (totalBytes > maxBytes) throw new PagesError("pages_site_too_large", 413);
    if (path === indexFile) indexFound = true;
  }

  if (!fileCount) throw new PagesError("pages_source_is_empty", 400);
  if (!indexFound) throw new PagesError("pages_index_file_not_found", 400);
  return { fileCount, totalBytes };
}

async function audit(
  repositoryId: string,
  actor: { id: string; displayName: string },
  eventType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {}
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType: "page_site",
    resourceId,
    metadata
  });
}

export async function handleKoshPagesAdminRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/pages(.*)$/
  );
  if (!match) return false;

  try {
    await platformStore.ready();
    const namespace = match[1];
    const slug = match[2];
    const tail = match[3] || "";
    const repository = await repositoryStore.get(namespace, slug);
    if (!repository) throw new PagesError("repository_not_found", 404);

    const write = request.method !== "GET";
    const authorization = await authorizeKoshRepositoryRequest(
      request,
      repository,
      write ? "repository.write" : "repository.read"
    );
    if (!authorization.decision.allowed || (write && !authorization.identity)) {
      sendJson(
        response,
        authorization.identity ? 403 : 401,
        { error: authorization.identity ? "repository_permission_denied" : "authentication_required" },
        origin,
        allowedOrigins
      );
      return true;
    }
    if (write && origin && !allowedOrigins.has(origin)) {
      throw new PagesError("origin_not_allowed", 403);
    }

    const resources = await platformStore.listResources("page_site", repository.id);
    let site = siteResource(resources);
    let siteDeployments = deployments(resources);

    if (tail === "" && request.method === "GET") {
      sendJson(response, 200, siteView(request, namespace, slug, site, siteDeployments), origin, allowedOrigins);
      return true;
    }

    if (tail === "" && request.method === "PUT") {
      const body = await readJson(request);
      const sourceBranch = String(body.sourceBranch ?? site?.payload.sourceBranch ?? repository.defaultBranch).trim();
      if (!validBranch(sourceBranch)) throw new PagesError("invalid_pages_source_branch");
      const sourcePath = safeGitPath(String(body.sourcePath ?? site?.payload.sourcePath ?? ""));
      const indexFile = safeGitPath(String(body.indexFile ?? site?.payload.indexFile ?? "index.html"));
      if (!indexFile) throw new PagesError("pages_index_file_required");
      const spaFallback = body.spaFallback === undefined ? Boolean(site?.payload.spaFallback) : Boolean(body.spaFallback);
      const cacheSeconds = Math.floor(clamp(body.cacheSeconds ?? site?.payload.cacheSeconds, 60, 0, 3600));
      const actor = authorization.identity!.user;

      if (site) {
        const updated = await platformStore.updateResource(site.id, {
          name: "Kosh Pages",
          state: site.state === "active" ? "active" : "configured",
          payload: {
            ...site.payload,
            kind: "site",
            sourceBranch,
            sourcePath,
            indexFile,
            spaFallback,
            cacheSeconds,
            updatedByUserId: actor.id,
            updatedByName: actor.displayName
          }
        });
        if (!updated) throw new PagesError("pages_site_not_found", 404);
        site = updated;
      } else {
        site = await platformStore.createResource({
          repositoryId: repository.id,
          namespace,
          type: "page_site",
          key: "site",
          name: "Kosh Pages",
          state: "configured",
          payload: {
            kind: "site",
            sourceBranch,
            sourcePath,
            indexFile,
            spaFallback,
            cacheSeconds,
            activeDeploymentId: null,
            updatedByUserId: actor.id,
            updatedByName: actor.displayName
          },
          createdByUserId: actor.id,
          createdByName: actor.displayName
        });
      }
      await audit(repository.id, actor, "pages_configuration_saved", site.id, {
        sourceBranch,
        sourcePath,
        indexFile,
        spaFallback,
        cacheSeconds
      });
      sendJson(response, 200, siteView(request, namespace, slug, site, siteDeployments), origin, allowedOrigins);
      return true;
    }

    if (tail === "/publish" && request.method === "POST") {
      const actor = authorization.identity!.user;
      if (!site) {
        site = await platformStore.createResource({
          repositoryId: repository.id,
          namespace,
          type: "page_site",
          key: "site",
          name: "Kosh Pages",
          state: "configured",
          payload: {
            kind: "site",
            sourceBranch: repository.defaultBranch,
            sourcePath: "",
            indexFile: "index.html",
            spaFallback: false,
            cacheSeconds: 60,
            activeDeploymentId: null,
            updatedByUserId: actor.id,
            updatedByName: actor.displayName
          },
          createdByUserId: actor.id,
          createdByName: actor.displayName
        });
      }

      const sourceBranch = String(site.payload.sourceBranch ?? repository.defaultBranch).trim();
      const sourcePath = safeGitPath(String(site.payload.sourcePath ?? ""));
      const indexFile = safeGitPath(String(site.payload.indexFile ?? "index.html"));
      const spaFallback = Boolean(site.payload.spaFallback);
      const gitDir = repositoryPath(namespace, slug);
      const commitSha = await resolveBranchCommit(gitDir, sourceBranch);
      const source = await validateSource(gitDir, commitSha, sourcePath, indexFile);

      const deployment = await platformStore.createResource({
        repositoryId: repository.id,
        namespace,
        type: "page_site",
        key: "deployment:" + randomUUID(),
        name: sourceBranch + " @ " + commitSha.slice(0, 12),
        state: "deployment",
        payload: {
          kind: "deployment",
          siteId: site.id,
          commitSha,
          sourceBranch,
          sourcePath,
          indexFile,
          spaFallback,
          fileCount: source.fileCount,
          totalBytes: source.totalBytes
        },
        createdByUserId: actor.id,
        createdByName: actor.displayName
      });

      const updated = await platformStore.updateResource(site.id, {
        state: "active",
        payload: {
          ...site.payload,
          kind: "site",
          activeDeploymentId: deployment.id,
          activeCommitSha: commitSha,
          publishedAt: deployment.createdAt,
          publishedByUserId: actor.id,
          publishedByName: actor.displayName
        }
      });
      if (!updated) throw new PagesError("pages_site_not_found", 404);
      site = updated;
      siteDeployments = [deployment, ...siteDeployments];
      await audit(repository.id, actor, "pages_published", site.id, {
        deploymentId: deployment.id,
        commitSha,
        sourceBranch,
        fileCount: source.fileCount,
        totalBytes: source.totalBytes
      });
      sendJson(response, 201, siteView(request, namespace, slug, site, siteDeployments), origin, allowedOrigins);
      return true;
    }

    if (tail === "/disable" && request.method === "POST") {
      if (!site) throw new PagesError("pages_site_not_found", 404);
      const actor = authorization.identity!.user;
      const updated = await platformStore.updateResource(site.id, { state: "disabled" });
      if (!updated) throw new PagesError("pages_site_not_found", 404);
      site = updated;
      await audit(repository.id, actor, "pages_disabled", site.id);
      sendJson(response, 200, siteView(request, namespace, slug, site, siteDeployments), origin, allowedOrigins);
      return true;
    }

    const activate = tail.match(/^\/deployments\/([a-f0-9-]{36})\/activate$/i);
    if (activate && request.method === "POST") {
      if (!site) throw new PagesError("pages_site_not_found", 404);
      const deployment = siteDeployments.find((item) => item.id === activate[1]);
      if (!deployment) throw new PagesError("pages_deployment_not_found", 404);
      const actor = authorization.identity!.user;
      const updated = await platformStore.updateResource(site.id, {
        state: "active",
        payload: {
          ...site.payload,
          kind: "site",
          activeDeploymentId: deployment.id,
          activeCommitSha: String(deployment.payload.commitSha ?? ""),
          publishedAt: deployment.createdAt,
          publishedByUserId: actor.id,
          publishedByName: actor.displayName
        }
      });
      if (!updated) throw new PagesError("pages_site_not_found", 404);
      site = updated;
      await audit(repository.id, actor, "pages_deployment_activated", site.id, {
        deploymentId: deployment.id,
        commitSha: String(deployment.payload.commitSha ?? "")
      });
      sendJson(response, 200, siteView(request, namespace, slug, site, siteDeployments), origin, allowedOrigins);
      return true;
    }

    return false;
  } catch (error) {
    const status = error instanceof PagesError ? error.status : Number((error as { status?: number })?.status ?? 500);
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "pages_request_failed" },
      origin,
      allowedOrigins
    );
    return true;
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

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.setHeader("allow", "GET, HEAD");
    response.end("Method not allowed.");
    return true;
  }

  try {
    await platformStore.ready();
    const namespace = match[1];
    const slug = match[2];
    const requestedPath = safeGitPath(match[3] ?? "", true);
    const repository = await repositoryStore.get(namespace, slug);

    if (!repository) {
      response.statusCode = 404;
      response.end("Kosh Pages site not found.");
      return true;
    }

    const authorization = await authorizeKoshRepositoryRequest(request, repository, "repository.read");
    if (!authorization.decision.allowed) {
      response.statusCode = authorization.identity ? 403 : 401;
      response.end(authorization.identity ? "Kosh Pages access denied." : "Authentication required.");
      return true;
    }

    const resources = await platformStore.listResources("page_site", repository.id);
    const site = siteResource(resources);
    const siteDeployments = deployments(resources);
    if (!site || site.state !== "active") {
      response.statusCode = 404;
      response.end("Kosh Pages is not published for this repository.");
      return true;
    }

    const activeId = String(site.payload.activeDeploymentId ?? "");
    const deployment = siteDeployments.find((item) => item.id === activeId);
    if (!deployment) {
      response.statusCode = 503;
      response.end("Kosh Pages requires an explicit publish before serving content.");
      return true;
    }

    const commitSha = String(deployment.payload.commitSha ?? "");
    if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
      response.statusCode = 503;
      response.end("Kosh Pages deployment is invalid.");
      return true;
    }

    const sourcePath = safeGitPath(String(deployment.payload.sourcePath ?? ""));
    const indexFile = safeGitPath(String(deployment.payload.indexFile ?? "index.html"));
    const spaFallback = Boolean(deployment.payload.spaFallback);
    const cacheSeconds = Math.floor(clamp(site.payload.cacheSeconds, 60, 0, 3600));
    const gitDir = repositoryPath(namespace, slug);
    const relative = requestedPath || indexFile;
    const candidates = [
      [sourcePath, relative].filter(Boolean).join("/"),
      [sourcePath, relative, "index.html"].filter(Boolean).join("/")
    ];

    const acceptsHtml = String(request.headers.accept ?? "").includes("text/html");
    if (spaFallback && requestedPath && (acceptsHtml || !requestedPath.includes("."))) {
      candidates.push([sourcePath, indexFile].filter(Boolean).join("/"));
    }

    let body: Buffer | null = null;
    let resolvedPath = "";
    for (const candidate of [...new Set(candidates)]) {
      const path = safeGitPath(candidate);
      body = await gitBuffer(gitDir, ["show", commitSha + ":" + path]);
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

    const etag = '"' + commitSha + "-" + resolvedPath + '"';
    if (request.headers["if-none-match"] === etag) {
      response.statusCode = 304;
      response.setHeader("etag", etag);
      response.end();
      return true;
    }

    response.statusCode = 200;
    response.setHeader("content-type", contentType(resolvedPath));
    response.setHeader("content-length", String(body.length));
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("x-kosh-pages-deployment", deployment.id);
    response.setHeader("x-kosh-pages-commit", commitSha);
    response.setHeader(
      "content-security-policy",
      "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    response.setHeader(
      "cache-control",
      repository.visibility === "public"
        ? "public, max-age=" + cacheSeconds
        : "private, no-store"
    );
    response.setHeader("etag", etag);
    if (request.method === "HEAD") response.end();
    else response.end(body);
    return true;
  } catch (error) {
    const status = error instanceof PagesError ? error.status : Number((error as { status?: number })?.status ?? 500);
    response.statusCode = status;
    response.end(error instanceof Error ? error.message : "Kosh Pages request failed.");
    return true;
  }
}
