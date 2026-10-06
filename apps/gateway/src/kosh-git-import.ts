import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositories = getKoshStore();
const platform = getKoshPlatformStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");

type JsonBody = Record<string, unknown>;

function json(response: ServerResponse, status: number, body: unknown, origin: string | undefined, allowed: ReadonlySet<string>) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowed.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes = 32 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonBody : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function targetPath(namespace: string, slug: string) {
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;
  if (!path.startsWith(prefix)) throw Object.assign(new Error("invalid_repository_path"), { status: 400 });
  return path;
}

function allowedSource(source: URL) {
  if (source.protocol !== "https:") return false;
  const configured = (process.env.KOSH_GIT_IMPORT_ALLOWED_HOSTS?.trim() || "github.com")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return configured.includes(source.hostname.toLowerCase());
}

async function refs(gitDir: string) {
  const result = await execFileAsync(
    "git",
    ["--git-dir", gitDir, "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags"],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }
  );
  return String(result.stdout)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, sha] = line.split("\0");
      return { name, sha };
    });
}

export async function handleKoshGitImportRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(/^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/import\/git$/);
  if (!match) return false;
  if (request.method !== "POST") return false;
  if (origin && !allowedOrigins.has(origin)) {
    json(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  try {
    const repository = await repositories.get(match[1], match[2]);
    if (!repository) {
      json(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
      return true;
    }
    const authorization = await authorizeKoshRepositoryRequest(request, repository, "repository.manage");
    if (!authorization.identity || !authorization.decision.allowed) {
      json(response, authorization.identity ? 403 : 401, {
        error: authorization.identity ? "repository_permission_denied" : "authentication_required"
      }, origin, allowedOrigins);
      return true;
    }

    const body = await readJson(request);
    const sourceText = clean(body.sourceUrl, 1000);
    let source: URL;
    try {
      source = new URL(sourceText);
    } catch {
      throw Object.assign(new Error("invalid_source_url"), { status: 400 });
    }
    if (!allowedSource(source)) {
      throw Object.assign(new Error("git_import_source_not_allowed"), { status: 400 });
    }

    const destination = targetPath(repository.namespace, repository.slug);
    const existingRefs = await refs(destination).catch(() => []);
    const replaceExisting = body.replaceExisting === true;
    if (existingRefs.length && !replaceExisting) {
      throw Object.assign(new Error("target_repository_not_empty"), { status: 409 });
    }

    const secretName = clean(body.secretName, 160);
    const sourceToken = secretName
      ? (await platform.resolveSecret(repository.id, null, secretName)) ?? (await platform.resolveSecret(null, null, secretName))
      : null;
    if (secretName && !sourceToken) {
      throw Object.assign(new Error("git_import_secret_not_found"), { status: 409 });
    }

    const temp = await mkdtemp(resolve(tmpdir(), "kosh-import-"));
    const mirror = resolve(temp, "source.git");
    try {
      const cloneArgs = sourceToken
        ? ["-c", `http.extraHeader=Authorization: Bearer ${sourceToken}`, "clone", "--mirror", source.toString(), mirror]
        : ["clone", "--mirror", source.toString(), mirror];
      await execFileAsync("git", cloneArgs, {
        timeout: 10 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      });
      await execFileAsync("git", ["--git-dir", mirror, "fsck", "--connectivity-only"], {
        timeout: 5 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8"
      });
      await execFileAsync("git", ["--git-dir", mirror, "push", "--mirror", destination], {
        timeout: 10 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8"
      });
      await execFileAsync("git", ["--git-dir", destination, "fsck", "--connectivity-only"], {
        timeout: 5 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        encoding: "utf8"
      });

      // Postgres-backed Kosh stores synchronize Git snapshots during get(). Calling
      // this after the mirror push creates a durable online snapshot before success.
      await repositories.get(repository.namespace, repository.slug);
      const importedRefs = await refs(destination);
      json(response, 200, {
        repository: `${repository.namespace}/${repository.slug}`,
        imported: true,
        sourceHost: source.hostname,
        refCount: importedRefs.length,
        branches: importedRefs.filter((item) => item.name.startsWith("refs/heads/")).length,
        tags: importedRefs.filter((item) => item.name.startsWith("refs/tags/")).length,
        durablePersistence: repositories.kind === "postgres"
      }, origin, allowedOrigins);
    } finally {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status) || 500;
    json(response, status, {
      error: error instanceof Error ? error.message : "git_import_failed"
    }, origin, allowedOrigins);
  }
  return true;
}
