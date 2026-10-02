import { execFile, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { handleKoshChangeReviewRequest } from "./kosh-reviews.js";
import { handleKoshWorkRequest } from "./kosh-work.js";
import { handleKoshAutomationRequest } from "./kosh-automation.js";
import { handleKoshPlatformRequest } from "./kosh-platform.js";
import { handleKoshLfsRequest } from "./kosh-lfs.js";
import { handleKoshPagesRequest } from "./kosh-pages.js";
import { handleKoshFlowRequest } from "./kosh-flow.js";
import { handleKoshMeshRequest } from "./kosh-mesh.js";
import { handleKoshPulseRequest } from "./kosh-pulse.js";
import { scheduleAutomationEvent } from "./kosh-automation-service.js";
import { dispatchKoshWebhooks } from "./kosh-webhooks.js";
import {
  createKoshStore,
  type KoshVisibility,
  type StoredKoshRepository
} from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const store = createKoshStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");
const isProduction = process.env.NODE_ENV === "production";

type JsonBody = Record<string, unknown>;

type KoshBranch = {
  name: string;
  sha: string;
  subject: string;
  author: string;
  committedAt: string;
};

type KoshTag = {
  name: string;
  sha: string;
  subject: string;
  creator: string;
  createdAt: string;
};

type KoshCommit = {
  sha: string;
  shortSha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  body: string;
};

type KoshTreeEntry = {
  name: string;
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number | null;
};

function json(
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

function validSegment(value: string, maxLength: number) {
  return (
    value.length <= maxLength &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
  );
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

async function readJson(
  request: IncomingMessage,
  limit = 1024 * 1024
): Promise<JsonBody> {
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

function repositoryPath(namespace: string, slug: string) {
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const rootPrefix = repositoryRoot.endsWith(sep)
    ? repositoryRoot
    : repositoryRoot + sep;

  if (!path.startsWith(rootPrefix)) {
    throw Object.assign(new Error("invalid_repository_path"), { status: 400 });
  }

  return path;
}

async function runGit(
  gitDir: string,
  args: string[],
  timeout = 15_000,
  maxBuffer = 8 * 1024 * 1024
) {
  try {
    const result = await execFileAsync(
      "git",
      ["--git-dir", gitDir, ...args],
      {
        timeout,
        maxBuffer,
        encoding: "utf8"
      }
    );
    return String(result.stdout);
  } catch (error) {
    throw Object.assign(new Error("git_command_failed"), {
      status: 500,
      cause: error
    });
  }
}

async function runGitBuffer(
  gitDir: string,
  args: string[],
  maxBytes = 1024 * 1024
) {
  return new Promise<Buffer>((resolveBuffer, reject) => {
    const child = spawn("git", ["--git-dir", gitDir, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let finished = false;

    const stop = (error: Error) => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(error);
    };

    const timer = setTimeout(() => {
      stop(Object.assign(new Error("git_command_timeout"), { status: 504 }));
    }, 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        stop(Object.assign(new Error("blob_preview_too_large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4096);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      stop(Object.assign(new Error("git_command_failed"), { status: 500, cause: error }));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (code !== 0) {
        reject(
          Object.assign(new Error(stderr.trim() || "git_command_failed"), {
            status: 404
          })
        );
        return;
      }
      resolveBuffer(Buffer.concat(chunks));
    });
  });
}

async function ensureKoshReceiveHook(
  gitDir: string,
  defaultBranch: string
) {
  const hookPath = resolve(gitDir, "hooks", "pre-receive");
  const protectedRefsPath = resolve(gitDir, "kosh-protected-refs");
  const defaultRef = "refs/heads/" + defaultBranch;

  await mkdir(resolve(gitDir, "hooks"), { recursive: true });

  try {
    await readFile(protectedRefsPath, "utf8");
  } catch {
    await writeFile(protectedRefsPath, defaultRef + "\n", "utf8");
  }

  const script = [
    "#!/bin/sh",
    "protected_file=\"$(git rev-parse --git-dir)/kosh-protected-refs\"",
    "zero=0000000000000000000000000000000000000000",
    "while read old_sha new_sha ref_name",
    "do",
    "  if [ \"$old_sha\" = \"$zero\" ]; then",
    "    continue",
    "  fi",
    "  if [ -f \"$protected_file\" ] && grep -Fqx \"$ref_name\" \"$protected_file\"; then",
    "    echo \"Kosh: direct push to protected branch $ref_name is blocked. Use a Change Request.\" >&2",
    "    exit 1",
    "  fi",
    "done",
    "exit 0",
    ""
  ].join("\n");

  await writeFile(hookPath, script, "utf8");
  await chmod(hookPath, 0o755);
}

async function ensureBareRepository(namespace: string, slug: string) {
  const namespacePath = resolve(repositoryRoot, namespace);
  const path = repositoryPath(namespace, slug);

  await mkdir(namespacePath, { recursive: true });

  if (await pathExists(resolve(path, "HEAD"))) {
    await ensureKoshReceiveHook(path, "main");
    return path;
  }

  await execFileAsync(
    "git",
    ["init", "--bare", "--initial-branch=main", path],
    { timeout: 20_000 }
  );

  await execFileAsync(
    "git",
    ["--git-dir", path, "config", "http.receivepack", "true"],
    { timeout: 10_000 }
  );

  await ensureKoshReceiveHook(path, "main");
  return path;
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
      const decoded = Buffer.from(
        authorization.slice(6),
        "base64"
      ).toString("utf8");
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

function gitTokenAuthorized(request: IncomingMessage) {
  const expected = process.env.KOSH_GIT_TOKEN?.trim();

  if (!expected) {
    return !isProduction;
  }

  return tokenMatches(suppliedGitToken(request), expected);
}

function isGitWrite(url: URL) {
  return (
    url.pathname.endsWith("/git-receive-pack") ||
    url.searchParams.get("service") === "git-receive-pack"
  );
}

function rejectGitAuthentication(
  response: ServerResponse,
  hasConfiguredToken: boolean
) {
  response.statusCode = hasConfiguredToken ? 401 : 503;
  response.setHeader("www-authenticate", 'Basic realm="Kosh Git"');
  response.end(
    hasConfiguredToken
      ? "Authentication required."
      : "KOSH_GIT_TOKEN is required for protected production Git access."
  );
}

async function branchRefSnapshot(gitDir: string) {
  const output = await runGit(
    gitDir,
    [
      "for-each-ref",
      "--format=%(refname:short)%00%(objectname)",
      "refs/heads"
    ],
    10_000,
    2 * 1024 * 1024
  );
  const refs = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [name, sha] = line.split("\0");
    if (name && /^[0-9a-f]{40}$/i.test(sha ?? "")) {
      refs.set(name, sha);
    }
  }
  return refs;
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
  const repository = await store.get(namespace, slug);
  const path = repositoryPath(namespace, slug);

  if (!repository || !(await pathExists(resolve(path, "HEAD")))) {
    response.statusCode = 404;
    response.end("Repository not found.");
    return true;
  }

  if (
    await handleKoshLfsRequest({
      request,
      response,
      repository,
      suffix,
      baseUrl:
        publicOrigin(request) +
        "/git/" +
        encodeURIComponent(namespace) +
        "/" +
        encodeURIComponent(slug) +
        ".git",
      authorized: gitTokenAuthorized(request)
    })
  ) {
    return true;
  }

  await ensureKoshReceiveHook(path, repository.defaultBranch);

  const write = isGitWrite(url);
  const refsBefore = write ? await branchRefSnapshot(path) : null;
  const tokenRequired = write || repository.visibility !== "public";

  if (tokenRequired && !gitTokenAuthorized(request)) {
    rejectGitAuthentication(
      response,
      Boolean(process.env.KOSH_GIT_TOKEN?.trim())
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
      REMOTE_USER: tokenRequired ? "kosh-user" : "",
      REMOTE_ADDR: request.socket.remoteAddress || "",
      HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] ?? "")
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;
  let stderr = "";
  let finished = false;

  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8192);
  });

  child.on("error", (error) => {
    if (finished) return;
    finished = true;

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
        if (Number.isFinite(status)) {
          response.statusCode = status;
        }
      } else {
        response.setHeader(name, value);
      }
    }

    response.setHeader("x-content-type-options", "nosniff");
    headersSent = true;

    if (body.length) {
      response.write(body);
    }
  });

  response.on("drain", () => child.stdout.resume());

  child.on("close", async (code) => {
    if (finished) return;
    finished = true;

    if (code === 0 && write && refsBefore) {
      try {
        const refsAfter = await branchRefSnapshot(path);
        for (const [branchName, commitSha] of refsAfter) {
          if (refsBefore.get(branchName) !== commitSha) {
            await scheduleAutomationEvent(
              repository,
              "push",
              branchName,
              commitSha,
              { id: null, name: "Git push" },
              null
            );
            void dispatchKoshWebhooks(
              repository.id,
              "push",
              {
                namespace: repository.namespace,
                slug: repository.slug,
                branch: branchName,
                commitSha
              }
            ).catch(() => undefined);
          }
        }
      } catch (automationError) {
        stderr =
          (stderr +
            "\nKosh automation trigger warning: " +
            (automationError instanceof Error
              ? automationError.message
              : "unknown error")).slice(-8192);
      }
    }

    if (!headersSent && !response.headersSent) {
      response.statusCode = code === 0 ? 200 : 500;
      response.end(
        code === 0
          ? ""
          : "Kosh Git backend exited with code " +
              code +
              (stderr ? "\n" + stderr : "")
      );
      return;
    }

    response.end();
  });

  if (request.method === "POST") {
    request.pipe(child.stdin);
  } else {
    child.stdin.end();
  }

  return true;
}

async function requireWorkspaceIdentity(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const identity = await resolveKoshIdentity(
    request,
    request.method === "GET" ? "repo:read" : "repo:write"
  );

  if (!identity) {
    json(
      response,
      401,
      { error: "authentication_required" },
      origin,
      allowedOrigins
    );
    return false;
  }

  return true;
}

function safeTreePath(input: string) {
  const decoded = input.trim().replace(/^\/+|\/+$/g, "");
  if (!decoded) return "";

  if (
    decoded.length > 2048 ||
    decoded.includes("\0") ||
    decoded.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw Object.assign(new Error("invalid_repository_path"), { status: 400 });
  }

  return decoded;
}

async function resolveCommit(
  gitDir: string,
  requestedRef: string,
  repository: StoredKoshRepository
) {
  const ref = requestedRef.trim() || repository.defaultBranch;

  if (ref.length > 300 || ref.includes("\0")) {
    throw Object.assign(new Error("invalid_ref"), { status: 400 });
  }

  const candidates = /^[0-9a-f]{7,40}$/i.test(ref)
    ? [ref]
    : ["refs/heads/" + ref, "refs/tags/" + ref];

  for (const candidate of candidates) {
    try {
      const result = await execFileAsync(
        "git",
        ["--git-dir", gitDir, "rev-parse", "--verify", candidate + "^{commit}"],
        { timeout: 10_000, encoding: "utf8" }
      );
      const sha = String(result.stdout).trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) {
        return sha;
      }
    } catch {
      // Continue to the next explicit ref namespace.
    }
  }

  throw Object.assign(new Error("ref_not_found"), { status: 404 });
}

function parseBranches(output: string): KoshBranch[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, sha, subject, author, committedAt] = line.split("\0");
      return {
        name: name ?? "",
        sha: sha ?? "",
        subject: subject ?? "",
        author: author ?? "",
        committedAt: committedAt ?? ""
      };
    })
    .filter((branch) => branch.name && branch.sha);
}

function parseTags(output: string): KoshTag[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, sha, subject, creator, createdAt] = line.split("\0");
      return {
        name: name ?? "",
        sha: sha ?? "",
        subject: subject ?? "",
        creator: creator ?? "",
        createdAt: createdAt ?? ""
      };
    })
    .filter((tag) => tag.name && tag.sha);
}

async function listBranches(gitDir: string) {
  const output = await runGit(gitDir, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)%00%(objectname)%00%(subject)%00%(authorname)%00%(committerdate:iso-strict)",
    "refs/heads"
  ]);
  return parseBranches(output);
}

async function listTags(gitDir: string) {
  const output = await runGit(gitDir, [
    "for-each-ref",
    "--sort=-creatordate",
    "--format=%(refname:short)%00%(objectname)%00%(subject)%00%(creator)%00%(creatordate:iso-strict)",
    "refs/tags"
  ]);
  return parseTags(output);
}

async function listCommits(
  gitDir: string,
  commitSha: string,
  limit: number
): Promise<KoshCommit[]> {
  const output = await runGit(
    gitDir,
    [
      "log",
      commitSha,
      "-n",
      String(limit),
      "--date=iso-strict",
      "--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00"
    ],
    20_000,
    16 * 1024 * 1024
  );

  const fields = output.split("\0");
  const commits: KoshCommit[] = [];

  for (let index = 0; index + 7 < fields.length; index += 8) {
    const sha = fields[index]?.trim();
    if (!sha) continue;

    commits.push({
      sha,
      shortSha: fields[index + 1]?.trim() ?? sha.slice(0, 7),
      parents: (fields[index + 2] ?? "").trim().split(/\s+/).filter(Boolean),
      authorName: fields[index + 3] ?? "",
      authorEmail: fields[index + 4] ?? "",
      authoredAt: fields[index + 5]?.trim() ?? "",
      subject: fields[index + 6] ?? "",
      body: (fields[index + 7] ?? "").trim()
    });
  }

  return commits;
}

async function listTree(
  gitDir: string,
  commitSha: string,
  path: string
): Promise<KoshTreeEntry[]> {
  const treeish = path ? commitSha + ":" + path : commitSha;
  const output = await runGitBuffer(
    gitDir,
    ["ls-tree", "-z", "--long", treeish],
    8 * 1024 * 1024
  );

  const entries: KoshTreeEntry[] = [];

  for (const record of output.toString("utf8").split("\0")) {
    if (!record) continue;

    const tab = record.indexOf("\t");
    if (tab < 0) continue;

    const meta = record.slice(0, tab).trim().split(/\s+/);
    const name = record.slice(tab + 1);
    const [mode, type, sha, sizeText] = meta;

    if (
      !mode ||
      !sha ||
      !name ||
      (type !== "blob" && type !== "tree" && type !== "commit")
    ) {
      continue;
    }

    entries.push({
      name,
      path: path ? path + "/" + name : name,
      mode,
      type,
      sha,
      size:
        sizeText && sizeText !== "-"
          ? Number.isFinite(Number(sizeText))
            ? Number(sizeText)
            : null
          : null
    });
  }

  return entries.sort((left, right) => {
    if (left.type === right.type) {
      return left.name.localeCompare(right.name);
    }
    return left.type === "tree" ? -1 : 1;
  });
}

async function repositoryForRoute(namespace: string, slug: string) {
  if (!validSegment(namespace, 64) || !validSegment(slug, 100)) {
    throw Object.assign(new Error("repository_not_found"), { status: 404 });
  }

  const repository = await store.get(namespace, slug);
  const gitDir = repositoryPath(namespace, slug);

  if (!repository || !(await pathExists(resolve(gitDir, "HEAD")))) {
    throw Object.assign(new Error("repository_not_found"), { status: 404 });
  }

  return { repository, gitDir };
}

function routeError(
  response: ServerResponse,
  error: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;

  const message =
    error instanceof Error ? error.message : "kosh_repository_error";

  json(response, status, { error: message }, origin, allowedOrigins);
}

export async function handleKoshRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (url.pathname.startsWith("/git/")) {
    return handleGitHttp(request, response, url);
  }

  if (url.pathname.startsWith("/pages/")) {
    return handleKoshPagesRequest(request, response, url);
  }

  if (!url.pathname.startsWith("/v1/kosh")) {
    return false;
  }

  if (
    await handleKoshChangeReviewRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshWorkRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshAutomationRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshFlowRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshMeshRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshPulseRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

  if (
    await handleKoshPlatformRequest(
      request,
      response,
      url,
      origin,
      allowedOrigins
    )
  ) {
    return true;
  }

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
          "ssh",
          "organizations",
          "merge-queue",
          "search",
          "code-intelligence",
          "browser-ide",
          "dev-environments",
          "wiki",
          "pages",
          "webhooks",
          "api-cli",
          "notifications",
          "advanced-projects",
          "release-management",
          "storage",
          "disaster-recovery",
          "observability",
          "administration",
          "extensions"
        ]
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/kosh/repos") {
    if (
      !(await requireWorkspaceIdentity(
        request,
        response,
        origin,
        allowedOrigins
      ))
    ) {
      return true;
    }

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
    if (
      !(await requireWorkspaceIdentity(
        request,
        response,
        origin,
        allowedOrigins
      ))
    ) {
      return true;
    }

    if (origin && !allowedOrigins.has(origin)) {
      json(
        response,
        403,
        { error: "origin_not_allowed" },
        origin,
        allowedOrigins
      );
      return true;
    }

    try {
      const body = await readJson(request);
      const namespace = String(body.namespace ?? "").trim();
      const name = String(body.name ?? "").trim();
      const slug = slugify(name);
      const description = String(body.description ?? "")
        .trim()
        .slice(0, 500);
      const visibility = String(
        body.visibility ?? "private"
      ) as KoshVisibility;

      if (
        !validSegment(namespace, 64) ||
        !validSegment(slug, 100) ||
        !name ||
        name.length > 100
      ) {
        json(
          response,
          400,
          { error: "invalid_repository_name" },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (!["private", "internal", "public"].includes(visibility)) {
        json(
          response,
          400,
          { error: "invalid_visibility" },
          origin,
          allowedOrigins
        );
        return true;
      }

      await ensureBareRepository(namespace, slug);

      const cloneHttpUrl =
        publicOrigin(request) +
        "/git/" +
        namespace +
        "/" +
        slug +
        ".git";

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
      routeError(response, error, origin, allowedOrigins);
    }

    return true;
  }

  const repositoryRoute = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})(?:\/(branches|tags|commits|tree|blob))?$/
  );

  if (repositoryRoute && request.method === "GET") {
    if (
      !(await requireWorkspaceIdentity(
        request,
        response,
        origin,
        allowedOrigins
      ))
    ) {
      return true;
    }

    const [, namespace, slug, resource] = repositoryRoute;

    try {
      const { repository, gitDir } = await repositoryForRoute(namespace, slug);

      if (!resource) {
        const [branches, tags] = await Promise.all([
          listBranches(gitDir),
          listTags(gitDir)
        ]);

        let headSha: string | null = null;
        if (branches.length) {
          try {
            headSha = await resolveCommit(
              gitDir,
              repository.defaultBranch,
              repository
            );
          } catch {
            headSha = branches[0]?.sha ?? null;
          }
        }

        json(
          response,
          200,
          {
            repository,
            headSha,
            empty: branches.length === 0,
            branchCount: branches.length,
            tagCount: tags.length
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (resource === "branches") {
        json(
          response,
          200,
          { branches: await listBranches(gitDir) },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (resource === "tags") {
        json(
          response,
          200,
          { tags: await listTags(gitDir) },
          origin,
          allowedOrigins
        );
        return true;
      }

      const requestedRef = url.searchParams.get("ref") ?? repository.defaultBranch;
      const commitSha = await resolveCommit(gitDir, requestedRef, repository);

      if (resource === "commits") {
        const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
        const limit = Math.min(
          100,
          Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50)
        );

        json(
          response,
          200,
          {
            ref: requestedRef,
            commitSha,
            commits: await listCommits(gitDir, commitSha, limit)
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      const path = safeTreePath(url.searchParams.get("path") ?? "");

      if (resource === "tree") {
        json(
          response,
          200,
          {
            ref: requestedRef,
            commitSha,
            path,
            entries: await listTree(gitDir, commitSha, path)
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (resource === "blob") {
        if (!path) {
          throw Object.assign(new Error("file_path_required"), { status: 400 });
        }

        const sizeText = await runGit(
          gitDir,
          ["cat-file", "-s", commitSha + ":" + path],
          10_000,
          64 * 1024
        );
        const size = Number(sizeText.trim());

        if (!Number.isFinite(size) || size < 0) {
          throw Object.assign(new Error("file_not_found"), { status: 404 });
        }

        if (size > 1024 * 1024) {
          json(
            response,
            200,
            {
              ref: requestedRef,
              commitSha,
              path,
              size,
              preview: null,
              encoding: "too-large"
            },
            origin,
            allowedOrigins
          );
          return true;
        }

        const buffer = await runGitBuffer(
          gitDir,
          ["show", commitSha + ":" + path],
          1024 * 1024 + 1
        );
        const binary = buffer.includes(0);

        json(
          response,
          200,
          {
            ref: requestedRef,
            commitSha,
            path,
            size,
            encoding: binary ? "base64" : "utf8",
            preview: binary
              ? buffer.toString("base64")
              : buffer.toString("utf8")
          },
          origin,
          allowedOrigins
        );
        return true;
      }
    } catch (error) {
      routeError(response, error, origin, allowedOrigins);
      return true;
    }
  }

  json(
    response,
    404,
    { error: "kosh_route_not_found" },
    origin,
    allowedOrigins
  );
  return true;
}
