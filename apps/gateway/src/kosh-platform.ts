import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshStore } from "./kosh-store.js";
import { scheduleAutomationEvent } from "./kosh-automation-service.js";
import {
  getKoshPlatformStore,
  type KoshPlatformResourceType
} from "./kosh-platform-store.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");
const packageRoot = resolve(process.env.KOSH_PACKAGE_ROOT?.trim() || ".kosh/packages");
const releaseRoot = resolve(process.env.KOSH_RELEASE_ROOT?.trim() || ".kosh/releases");
const backupRoot = resolve(process.env.KOSH_BACKUP_ROOT?.trim() || ".kosh/backups");

const resourceTypes = new Set<KoshPlatformResourceType>([
  "package",
  "package_channel",
  "release",
  "security_finding",
  "organization",
  "team",
  "merge_queue_entry",
  "dev_environment",
  "wiki_page",
  "page_site",
  "webhook",
  "subscription",
  "project_field",
  "storage_policy",
  "backup",
  "extension",
  "admin_setting",
  "code_index",
  "code_owner_rule",
  "deployment_policy"
]);

type JsonBody = Record<string, unknown>;

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
  maxBytes = 1024 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function resourceType(value: unknown) {
  const type = String(value ?? "") as KoshPlatformResourceType;
  if (!resourceTypes.has(type)) {
    throw Object.assign(new Error("invalid_platform_resource_type"), {
      status: 400
    });
  }
  return type;
}

function safeStoragePath(root: string, ...segments: string[]) {
  const cleaned = segments.map((value) => {
    const segment = value.trim();
    if (
      !segment ||
      segment.length > 220 ||
      segment === "." ||
      segment === ".." ||
      segment.includes("/") ||
      segment.includes("\\") ||
      segment.includes("\0")
    ) {
      throw Object.assign(new Error("invalid_storage_segment"), { status: 400 });
    }
    return segment.replace(/[^a-zA-Z0-9._@+-]+/g, "-");
  });
  const path = resolve(root, ...cleaned);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_storage_path"), { status: 400 });
  }
  return path;
}

function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sendFile(
  response: ServerResponse,
  path: string,
  filename: string,
  contentType = "application/octet-stream"
) {
  const buffer = await readFile(path);
  response.statusCode = 200;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", String(buffer.length));
  response.setHeader(
    "content-disposition",
    'attachment; filename="' + filename.replace(/["\\]/g, "-") + '"'
  );
  response.setHeader("cache-control", "private, no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(buffer);
}

function repositoryPath(namespace: string, slug: string) {
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_repository_path"), { status: 400 });
  }
  return path;
}

async function git(gitDir: string, args: string[], maxBuffer = 4 * 1024 * 1024) {
  try {
    const result = await execFileAsync(
      "git",
      ["--git-dir", gitDir, ...args],
      {
        timeout: 20_000,
        maxBuffer,
        encoding: "utf8"
      }
    );
    return String(result.stdout);
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string };
    if (value.stdout) return String(value.stdout);
    throw Object.assign(
      new Error(String(value.stderr ?? "git_command_failed").trim()),
      { status: 500 }
    );
  }
}

async function requireIdentity(
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
    sendJson(
      response,
      401,
      { error: "authentication_required" },
      origin,
      allowedOrigins
    );
    return null;
  }
  return identity;
}

async function audit(
  repositoryId: string | null,
  actor: { id: string; displayName: string },
  eventType: string,
  resourceTypeValue: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {}
) {
  return platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType: resourceTypeValue,
    resourceId,
    metadata
  });
}

function safeEditPath(workspace: string, input: string) {
  const relative = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    !relative ||
    relative.length > 2048 ||
    relative.includes("\0") ||
    relative.split("/").some((part) => !part || part === "." || part === "..") ||
    relative === ".git" ||
    relative.startsWith(".git/")
  ) {
    throw Object.assign(new Error("invalid_edit_path"), { status: 400 });
  }

  const path = resolve(workspace, relative);
  const prefix = workspace.endsWith(sep) ? workspace : workspace + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_edit_path"), { status: 400 });
  }
  return { relative, path };
}

async function execGitC(
  cwd: string,
  args: string[],
  env?: Record<string, string | undefined>
) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      env: env ? { ...process.env, ...env } : process.env
    });
    return String(result.stdout);
  } catch (error) {
    const value = error as { stderr?: string; stdout?: string };
    throw Object.assign(
      new Error(String(value.stderr || value.stdout || "git_command_failed").trim()),
      { status: 409 }
    );
  }
}

async function browserIdeCommit(input: {
  namespace: string;
  slug: string;
  defaultBranch: string;
  branch: string;
  baseBranch: string;
  message: string;
  files: Array<{ path: string; content: string | null }>;
  actor: { id: string; displayName: string; email: string };
}) {
  if (
    !input.branch ||
    input.branch === input.defaultBranch ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/.test(input.branch) ||
    input.branch.includes("..") ||
    input.branch.endsWith("/")
  ) {
    throw Object.assign(
      new Error("ide_requires_valid_non_default_branch"),
      { status: 400 }
    );
  }

  if (
    !input.baseBranch ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/.test(input.baseBranch)
  ) {
    throw Object.assign(new Error("invalid_base_branch"), { status: 400 });
  }

  if (!input.message || input.files.length < 1 || input.files.length > 50) {
    throw Object.assign(new Error("commit_message_and_files_required"), {
      status: 400
    });
  }

  const gitDir = repositoryPath(input.namespace, input.slug);
  const workspace = await mkdtemp(joinTemp("kosh-ide-"));

  try {
    await execGitC(tmpdir(), ["clone", "--no-hardlinks", gitDir, workspace]);

    const branchExists = await execFileAsync(
      "git",
      ["--git-dir", gitDir, "show-ref", "--verify", "--quiet", "refs/heads/" + input.branch],
      { timeout: 10_000 }
    ).then(() => true).catch(() => false);

    if (branchExists) {
      await execGitC(workspace, ["checkout", input.branch]);
    } else {
      await execGitC(workspace, ["checkout", input.baseBranch]);
      await execGitC(workspace, ["checkout", "-b", input.branch]);
    }

    for (const file of input.files) {
      const target = safeEditPath(workspace, file.path);
      if (file.content === null) {
        await unlink(target.path).catch(() => undefined);
        continue;
      }

      const bytes = Buffer.byteLength(file.content, "utf8");
      if (bytes > 1024 * 1024) {
        throw Object.assign(new Error("ide_file_too_large"), { status: 413 });
      }
      await mkdir(dirname(target.path), { recursive: true });
      await writeFile(target.path, file.content, "utf8");
    }

    await execGitC(workspace, ["add", "-A"]);
    const status = await execGitC(workspace, ["status", "--porcelain"]);
    if (!status.trim()) {
      throw Object.assign(new Error("no_changes_to_commit"), { status: 409 });
    }

    await execGitC(
      workspace,
      ["commit", "-m", input.message],
      {
        GIT_AUTHOR_NAME: input.actor.displayName,
        GIT_AUTHOR_EMAIL: input.actor.email,
        GIT_COMMITTER_NAME: input.actor.displayName,
        GIT_COMMITTER_EMAIL: input.actor.email
      }
    );

    const commitSha = (await execGitC(workspace, ["rev-parse", "HEAD"])).trim();
    await execGitC(
      workspace,
      ["push", "origin", "HEAD:refs/heads/" + input.branch]
    );

    return { branch: input.branch, commitSha };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

function joinTemp(prefix: string) {
  const root = tmpdir();
  return root.endsWith(sep) ? root + prefix : root + sep + prefix;
}

async function searchRepository(
  namespace: string,
  slug: string,
  defaultBranch: string,
  query: string,
  mode: string
) {
  const gitDir = repositoryPath(namespace, slug);
  const commitSha = (
    await git(
      gitDir,
      ["rev-parse", "--verify", "refs/heads/" + defaultBranch + "^{commit}"]
    )
  ).trim();

  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    return { query, mode, commitSha: null, results: [] };
  }

  if (mode === "commits") {
    const output = await git(
      gitDir,
      [
        "log",
        "--all",
        "--regexp-ignore-case",
        "--grep=" + query,
        "--format=%H%x00%an%x00%aI%x00%s",
        "-n",
        "100"
      ]
    );
    const results = output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, author, authoredAt, subject] = line.split("\0");
        return { sha, author, authoredAt, subject };
      });
    return { query, mode, commitSha, results };
  }

  if (mode === "paths") {
    const output = await git(
      gitDir,
      ["ls-tree", "-r", "--name-only", commitSha],
      8 * 1024 * 1024
    );
    const lowered = query.toLowerCase();
    const results = output
      .split(/\r?\n/)
      .filter((path) => path && path.toLowerCase().includes(lowered))
      .slice(0, 200)
      .map((path) => ({ path }));
    return { query, mode, commitSha, results };
  }

  const output = await git(
    gitDir,
    [
      "grep",
      "-n",
      "-I",
      "-F",
      "-e",
      query,
      commitSha,
      "--"
    ],
    8 * 1024 * 1024
  );

  const results = output
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => {
      const first = line.indexOf(":");
      const second = first >= 0 ? line.indexOf(":", first + 1) : -1;
      const third = second >= 0 ? line.indexOf(":", second + 1) : -1;
      if (first < 0 || second < 0 || third < 0) {
        return { raw: line };
      }
      return {
        commitSha: line.slice(0, first),
        path: line.slice(first + 1, second),
        line: Number(line.slice(second + 1, third)),
        text: line.slice(third + 1).slice(0, 1000)
      };
    });

  return { query, mode: "code", commitSha, results };
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
  sendJson(
    response,
    status,
    {
      error:
        error instanceof Error ? error.message : "kosh_platform_error"
    },
    origin,
    allowedOrigins
  );
}

export async function handleKoshPlatformRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (
    !url.pathname.startsWith("/v1/kosh/platform") &&
    !/\/v1\/kosh\/repos\/[^/]+\/[^/]+\/platform/.test(url.pathname)
  ) {
    return false;
  }

  const identity = await requireIdentity(
    request,
    response,
    origin,
    allowedOrigins
  );
  if (!identity) return true;

  try {
    await platformStore.ready();

    const repoMatch = url.pathname.match(
      /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/platform(.*)$/
    );

    if (repoMatch) {
      const namespace = repoMatch[1];
      const slug = repoMatch[2];
      const tail = repoMatch[3] || "";
      const repository = await repositoryStore.get(namespace, slug);

      if (!repository) {
        throw Object.assign(new Error("repository_not_found"), { status: 404 });
      }

      if (request.method === "GET" && (tail === "" || tail === "/summary")) {
        const [resources, secrets, auditEvents] = await Promise.all([
          platformStore.listResources(undefined, repository.id),
          platformStore.listSecrets(repository.id),
          platformStore.listAudit(repository.id, 100)
        ]);

        const counts = Object.fromEntries(
          [...resourceTypes].map((type) => [
            type,
            resources.filter((item) => item.type === type).length
          ])
        );

        sendJson(
          response,
          200,
          {
            repository,
            counts,
            secrets,
            recentAudit: auditEvents
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (tail === "/resources" && request.method === "GET") {
        const typeParam = url.searchParams.get("type");
        const type = typeParam ? resourceType(typeParam) : undefined;
        sendJson(
          response,
          200,
          {
            resources: await platformStore.listResources(
              type,
              repository.id
            )
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (tail === "/resources" && request.method === "POST") {
        const body = await readJson(request);
        const type = resourceType(body.type);
        const key = clean(body.key, 180);
        const name = clean(body.name, 240);
        if (!key || !name) {
          throw Object.assign(new Error("resource_key_and_name_required"), {
            status: 400
          });
        }

        const resource = await platformStore.createResource({
          repositoryId: repository.id,
          namespace,
          type,
          key,
          name,
          state: clean(body.state, 60) || "active",
          payload:
            body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
              ? body.payload as Record<string, unknown>
              : {},
          createdByUserId: identity.user.id,
          createdByName: identity.user.displayName
        });

        await audit(
          repository.id,
          identity.user,
          "platform_resource_created",
          type,
          resource.id,
          { key: resource.key, name: resource.name }
        );

        sendJson(response, 201, resource, origin, allowedOrigins);
        return true;
      }

      const resourceMatch = tail.match(/^\/resources\/([^/]+)$/);
      if (resourceMatch && request.method === "PATCH") {
        const id = decodeURIComponent(resourceMatch[1]);
        const existing = await platformStore.getResource(id);
        if (!existing || existing.repositoryId !== repository.id) {
          throw Object.assign(new Error("platform_resource_not_found"), {
            status: 404
          });
        }
        const body = await readJson(request);
        const updated = await platformStore.updateResource(id, {
          name:
            body.name === undefined
              ? undefined
              : clean(body.name, 240) || existing.name,
          state:
            body.state === undefined
              ? undefined
              : clean(body.state, 60) || existing.state,
          payload:
            body.payload &&
            typeof body.payload === "object" &&
            !Array.isArray(body.payload)
              ? body.payload as Record<string, unknown>
              : undefined
        });

        await audit(
          repository.id,
          identity.user,
          "platform_resource_updated",
          existing.type,
          id
        );

        sendJson(response, 200, updated, origin, allowedOrigins);
        return true;
      }

      if (resourceMatch && request.method === "DELETE") {
        const id = decodeURIComponent(resourceMatch[1]);
        const existing = await platformStore.getResource(id);
        if (!existing || existing.repositoryId !== repository.id) {
          throw Object.assign(new Error("platform_resource_not_found"), {
            status: 404
          });
        }
        const deleted = await platformStore.deleteResource(id);
        await audit(
          repository.id,
          identity.user,
          "platform_resource_deleted",
          existing.type,
          id
        );
        sendJson(response, 200, { deleted }, origin, allowedOrigins);
        return true;
      }

      if (tail === "/secrets" && request.method === "GET") {
        sendJson(
          response,
          200,
          { secrets: await platformStore.listSecrets(repository.id) },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (tail === "/secrets" && request.method === "POST") {
        const body = await readJson(request, 128 * 1024);
        const name = clean(body.name, 120);
        const value = String(body.value ?? "");
        const environmentName = clean(body.environmentName, 120) || null;

        if (!/^[A-Z_][A-Z0-9_]{1,119}$/.test(name) || !value) {
          throw Object.assign(new Error("valid_secret_name_and_value_required"), {
            status: 400
          });
        }

        const secret = await platformStore.putSecret({
          repositoryId: repository.id,
          environmentName,
          name,
          value,
          createdByUserId: identity.user.id,
          createdByName: identity.user.displayName
        });

        await audit(
          repository.id,
          identity.user,
          "secret_updated",
          "secret",
          secret.id,
          { name, environmentName }
        );

        sendJson(response, 201, secret, origin, allowedOrigins);
        return true;
      }

      const secretMatch = tail.match(/^\/secrets\/([^/]+)$/);
      if (secretMatch && request.method === "DELETE") {
        const id = decodeURIComponent(secretMatch[1]);
        const secret = (await platformStore.listSecrets(repository.id))
          .find((item) => item.id === id);
        if (!secret) {
          throw Object.assign(new Error("secret_not_found"), { status: 404 });
        }
        const deleted = await platformStore.deleteSecret(id);
        await audit(
          repository.id,
          identity.user,
          "secret_deleted",
          "secret",
          id,
          { name: secret.name }
        );
        sendJson(response, 200, { deleted }, origin, allowedOrigins);
        return true;
      }

      if (tail === "/packages" && request.method === "POST") {
        const body = await readJson(request, 24 * 1024 * 1024);
        const key = clean(body.key, 120);
        const name = clean(body.name, 180) || key;
        const version = clean(body.version, 80);
        const filename = clean(body.filename, 180);
        const format = clean(body.format, 60) || "generic";
        const encoded = String(body.base64 ?? "");

        if (!key || !version || !filename || !encoded) {
          throw Object.assign(
            new Error("package_key_version_file_and_data_required"),
            { status: 400 }
          );
        }

        const buffer = Buffer.from(encoded, "base64");
        if (!buffer.length || buffer.length > 16 * 1024 * 1024) {
          throw Object.assign(new Error("package_size_invalid"), { status: 413 });
        }

        const duplicatePackage = (
          await platformStore.listResources("package", repository.id)
        ).find((item) => item.key === key + "@" + version);
        if (duplicatePackage) {
          throw Object.assign(new Error("package_version_immutable"), {
            status: 409
          });
        }

        const directory = safeStoragePath(
          packageRoot,
          repository.id,
          key,
          version
        );
        await mkdir(directory, { recursive: true });
        const path = safeStoragePath(directory, filename);
        await writeFile(path, buffer);

        const resource = await platformStore.createResource({
          repositoryId: repository.id,
          namespace,
          type: "package",
          key: key + "@" + version,
          name,
          state: "published",
          payload: {
            packageKey: key,
            version,
            filename,
            format,
            sizeBytes: buffer.length,
            sha256: sha256(buffer),
            immutable: true
          },
          createdByUserId: identity.user.id,
          createdByName: identity.user.displayName
        });

        await audit(
          repository.id,
          identity.user,
          "package_published",
          "package",
          resource.id,
          { key, version, filename, sha256: resource.payload.sha256 }
        );

        sendJson(response, 201, resource, origin, allowedOrigins);
        return true;
      }

      const packageDownload = tail.match(
        /^\/packages\/([^/]+)\/download$/
      );
      if (packageDownload && request.method === "GET") {
        const resource = await platformStore.getResource(
          decodeURIComponent(packageDownload[1])
        );
        if (
          !resource ||
          resource.repositoryId !== repository.id ||
          resource.type !== "package"
        ) {
          throw Object.assign(new Error("package_not_found"), { status: 404 });
        }
        const packageKey = String(resource.payload.packageKey ?? "");
        const version = String(resource.payload.version ?? "");
        const filename = String(resource.payload.filename ?? "");
        const path = safeStoragePath(
          packageRoot,
          repository.id,
          packageKey,
          version,
          filename
        );
        await sendFile(response, path, filename);
        return true;
      }

      const releaseAssetMatch = tail.match(
        /^\/releases\/([^/]+)\/assets(?:\/([^/]+))?$/
      );
      if (releaseAssetMatch && request.method === "POST") {
        const releaseId = decodeURIComponent(releaseAssetMatch[1]);
        const release = await platformStore.getResource(releaseId);
        if (
          !release ||
          release.repositoryId !== repository.id ||
          release.type !== "release"
        ) {
          throw Object.assign(new Error("release_not_found"), { status: 404 });
        }
        const body = await readJson(request, 24 * 1024 * 1024);
        const filename = clean(body.filename, 180);
        const encoded = String(body.base64 ?? "");
        const buffer = Buffer.from(encoded, "base64");
        if (!filename || !buffer.length || buffer.length > 16 * 1024 * 1024) {
          throw Object.assign(new Error("release_asset_invalid"), { status: 413 });
        }

        const directory = safeStoragePath(releaseRoot, repository.id, release.id);
        await mkdir(directory, { recursive: true });
        const path = safeStoragePath(directory, filename);
        await writeFile(path, buffer);

        const assets = Array.isArray(release.payload.assets)
          ? [...release.payload.assets] as Array<Record<string, unknown>>
          : [];
        const nextAsset = {
          filename,
          sizeBytes: buffer.length,
          sha256: sha256(buffer)
        };
        const filtered = assets.filter(
          (item) => String(item.filename ?? "") !== filename
        );
        filtered.push(nextAsset);

        const updated = await platformStore.updateResource(release.id, {
          payload: {
            ...release.payload,
            assets: filtered
          }
        });

        await audit(
          repository.id,
          identity.user,
          "release_asset_uploaded",
          "release",
          release.id,
          nextAsset
        );

        sendJson(response, 201, updated, origin, allowedOrigins);
        return true;
      }

      if (
        releaseAssetMatch &&
        releaseAssetMatch[2] &&
        request.method === "GET"
      ) {
        const releaseId = decodeURIComponent(releaseAssetMatch[1]);
        const filename = decodeURIComponent(releaseAssetMatch[2]);
        const release = await platformStore.getResource(releaseId);
        if (
          !release ||
          release.repositoryId !== repository.id ||
          release.type !== "release"
        ) {
          throw Object.assign(new Error("release_not_found"), { status: 404 });
        }
        const assets = Array.isArray(release.payload.assets)
          ? release.payload.assets as Array<Record<string, unknown>>
          : [];
        if (!assets.some((item) => String(item.filename ?? "") === filename)) {
          throw Object.assign(new Error("release_asset_not_found"), {
            status: 404
          });
        }
        const path = safeStoragePath(
          releaseRoot,
          repository.id,
          release.id,
          filename
        );
        await sendFile(response, path, filename);
        return true;
      }

      if (tail === "/backups" && request.method === "POST") {
        const directory = safeStoragePath(backupRoot, repository.id);
        await mkdir(directory, { recursive: true });
        const backupKey =
          "repo-" +
          new Date().toISOString().replace(/[:.]/g, "-") +
          "-" +
          Math.random().toString(36).slice(2, 8);
        const filename = backupKey + ".bundle";
        const path = safeStoragePath(directory, filename);
        const gitDir = repositoryPath(namespace, slug);

        await execFileAsync(
          "git",
          ["--git-dir", gitDir, "bundle", "create", path, "--all"],
          {
            timeout: 120_000,
            maxBuffer: 8 * 1024 * 1024,
            encoding: "utf8"
          }
        );

        const buffer = await readFile(path);
        const resource = await platformStore.createResource({
          repositoryId: repository.id,
          namespace,
          type: "backup",
          key: backupKey,
          name: "Repository backup " + new Date().toISOString(),
          state: "ready",
          payload: {
            kind: "git-bundle",
            filename,
            sizeBytes: buffer.length,
            sha256: sha256(buffer)
          },
          createdByUserId: identity.user.id,
          createdByName: identity.user.displayName
        });

        await audit(
          repository.id,
          identity.user,
          "backup_created",
          "backup",
          resource.id,
          {
            filename,
            sizeBytes: buffer.length,
            sha256: resource.payload.sha256
          }
        );

        sendJson(response, 201, resource, origin, allowedOrigins);
        return true;
      }

      const backupMatch = tail.match(/^\/backups\/([^/]+)(?:\/(verify|download))?$/);
      if (backupMatch && request.method === "GET") {
        const resource = await platformStore.getResource(
          decodeURIComponent(backupMatch[1])
        );
        if (
          !resource ||
          resource.repositoryId !== repository.id ||
          resource.type !== "backup"
        ) {
          throw Object.assign(new Error("backup_not_found"), { status: 404 });
        }
        const filename = String(resource.payload.filename ?? "");
        const path = safeStoragePath(
          backupRoot,
          repository.id,
          filename
        );

        if (backupMatch[2] === "download") {
          await sendFile(response, path, filename);
          return true;
        }

        if (backupMatch[2] === "verify") {
          const info = await stat(path);
          const buffer = await readFile(path);
          const actualSha = sha256(buffer);
          const expectedSha = String(resource.payload.sha256 ?? "");
          const gitDir = repositoryPath(namespace, slug);
          let bundleValid = true;
          let verification = "";
          try {
            const result = await execFileAsync(
              "git",
              ["--git-dir", gitDir, "bundle", "verify", path],
              {
                timeout: 60_000,
                maxBuffer: 4 * 1024 * 1024,
                encoding: "utf8"
              }
            );
            verification = String(result.stdout || result.stderr || "");
          } catch (error) {
            bundleValid = false;
            verification =
              error instanceof Error ? error.message : "bundle_verify_failed";
          }

          sendJson(
            response,
            200,
            {
              valid: bundleValid && actualSha === expectedSha,
              bundleValid,
              checksumValid: actualSha === expectedSha,
              sizeBytes: info.size,
              sha256: actualSha,
              verification
            },
            origin,
            allowedOrigins
          );
          return true;
        }

        sendJson(response, 200, resource, origin, allowedOrigins);
        return true;
      }

      if (tail === "/search" && request.method === "GET") {
        const query = clean(url.searchParams.get("q"), 300);
        if (query.length < 2) {
          throw Object.assign(new Error("search_query_too_short"), {
            status: 400
          });
        }
        const mode = ["code", "paths", "commits"].includes(
          String(url.searchParams.get("mode"))
        )
          ? String(url.searchParams.get("mode"))
          : "code";
        const result = await searchRepository(
          namespace,
          slug,
          repository.defaultBranch,
          query,
          mode
        );
        sendJson(response, 200, result, origin, allowedOrigins);
        return true;
      }

      if (
        (tail === "/symbols" || tail === "/references") &&
        request.method === "GET"
      ) {
        const query = clean(url.searchParams.get("q"), 300);
        if (query.length < 2) {
          throw Object.assign(new Error("search_query_too_short"), {
            status: 400
          });
        }
        const result = await searchRepository(
          namespace,
          slug,
          repository.defaultBranch,
          query,
          "code"
        );
        sendJson(
          response,
          200,
          {
            ...result,
            kind: tail === "/symbols" ? "symbols" : "references"
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (tail === "/blame" && request.method === "GET") {
        const path = clean(url.searchParams.get("path"), 2048);
        const line = Math.max(1, Number(url.searchParams.get("line")) || 1);
        if (!path || path.includes("..") || path.includes("\0")) {
          throw Object.assign(new Error("valid_blame_path_required"), {
            status: 400
          });
        }
        const gitDir = repositoryPath(namespace, slug);
        const output = await git(
          gitDir,
          [
            "blame",
            "--line-porcelain",
            "-L",
            line + "," + line,
            repository.defaultBranch,
            "--",
            path
          ],
          1024 * 1024
        );
        sendJson(
          response,
          200,
          { path, line, blame: output },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (tail === "/ide/commit" && request.method === "POST") {
        const body = await readJson(request, 55 * 1024 * 1024);
        const files = Array.isArray(body.files)
          ? body.files
              .slice(0, 50)
              .map((item) =>
                item && typeof item === "object"
                  ? {
                      path: clean((item as Record<string, unknown>).path, 2048),
                      content:
                        (item as Record<string, unknown>).content === null
                          ? null
                          : String((item as Record<string, unknown>).content ?? "")
                    }
                  : { path: "", content: "" }
              )
          : [];

        const result = await browserIdeCommit({
          namespace,
          slug,
          defaultBranch: repository.defaultBranch,
          branch: clean(body.branch, 200),
          baseBranch: clean(body.baseBranch, 200) || repository.defaultBranch,
          message: clean(body.message, 500),
          files,
          actor: {
            id: identity.user.id,
            displayName: identity.user.displayName,
            email: identity.user.email
          }
        });

        await Promise.all([
          audit(
            repository.id,
            identity.user,
            "browser_ide_commit",
            "repository",
            repository.id,
            {
              branch: result.branch,
              commitSha: result.commitSha,
              files: files.map((item) => item.path)
            }
          ),
          scheduleAutomationEvent(
            repository,
            "push",
            result.branch,
            result.commitSha,
            { id: identity.user.id, name: identity.user.displayName },
            null
          )
        ]);

        sendJson(response, 201, result, origin, allowedOrigins);
        return true;
      }

      if (tail === "/audit" && request.method === "GET") {
        sendJson(
          response,
          200,
          { events: await platformStore.listAudit(repository.id, 500) },
          origin,
          allowedOrigins
        );
        return true;
      }

      sendJson(
        response,
        404,
        { error: "kosh_platform_route_not_found" },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (url.pathname === "/v1/kosh/platform/ssh-keys") {
      if (identity.authType !== "session") {
        throw Object.assign(new Error("interactive_session_required"), {
          status: 403
        });
      }
      if (request.method === "GET") {
        sendJson(
          response,
          200,
          { keys: await platformStore.listSshKeys(identity.user.id) },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (request.method === "POST") {
        const body = await readJson(request, 64 * 1024);
        const title = clean(body.title, 120);
        const publicKey = clean(body.publicKey, 16 * 1024);
        if (!title || !publicKey) {
          throw Object.assign(new Error("ssh_key_title_and_key_required"), {
            status: 400
          });
        }
        const key = await platformStore.createSshKey({
          userId: identity.user.id,
          title,
          publicKey
        });
        await audit(
          null,
          identity.user,
          "ssh_key_created",
          "ssh_key",
          key.id,
          { fingerprint: key.fingerprint }
        );
        sendJson(response, 201, key, origin, allowedOrigins);
        return true;
      }
    }

    const sshDelete = url.pathname.match(
      /^\/v1\/kosh\/platform\/ssh-keys\/([^/]+)$/
    );
    if (sshDelete && request.method === "DELETE") {
      if (identity.authType !== "session") {
        throw Object.assign(new Error("interactive_session_required"), {
          status: 403
        });
      }
      const deleted = await platformStore.deleteSshKey(
        identity.user.id,
        decodeURIComponent(sshDelete[1])
      );
      if (!deleted) {
        throw Object.assign(new Error("ssh_key_not_found"), { status: 404 });
      }
      sendJson(response, 200, { deleted: true }, origin, allowedOrigins);
      return true;
    }

    if (url.pathname === "/v1/kosh/platform/tokens") {
      if (identity.authType !== "session") {
        throw Object.assign(new Error("interactive_session_required"), {
          status: 403
        });
      }
      if (request.method === "GET") {
        sendJson(
          response,
          200,
          { tokens: await platformStore.listApiTokens(identity.user.id) },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (request.method === "POST") {
        const body = await readJson(request, 64 * 1024);
        const name = clean(body.name, 120);
        const scopes = Array.isArray(body.scopes)
          ? body.scopes
              .map((value) => clean(value, 100))
              .filter(Boolean)
              .slice(0, 50)
          : ["repo:read"];
        let expiresAt: string | null = null;
        if (body.expiresAt) {
          const date = new Date(String(body.expiresAt));
          if (Number.isNaN(date.getTime())) {
            throw Object.assign(new Error("invalid_token_expiry"), {
              status: 400
            });
          }
          expiresAt = date.toISOString();
        }
        if (!name) {
          throw Object.assign(new Error("token_name_required"), { status: 400 });
        }
        const created = await platformStore.createApiToken({
          userId: identity.user.id,
          name,
          scopes,
          expiresAt
        });
        await audit(
          null,
          identity.user,
          "api_token_created",
          "api_token",
          created.record.id,
          { scopes }
        );
        sendJson(response, 201, created, origin, allowedOrigins);
        return true;
      }
    }

    const tokenDelete = url.pathname.match(
      /^\/v1\/kosh\/platform\/tokens\/([^/]+)$/
    );
    if (tokenDelete && request.method === "DELETE") {
      if (identity.authType !== "session") {
        throw Object.assign(new Error("interactive_session_required"), {
          status: 403
        });
      }
      const deleted = await platformStore.deleteApiToken(
        identity.user.id,
        decodeURIComponent(tokenDelete[1])
      );
      if (!deleted) {
        throw Object.assign(new Error("api_token_not_found"), { status: 404 });
      }
      sendJson(response, 200, { deleted: true }, origin, allowedOrigins);
      return true;
    }

    if (
      url.pathname === "/v1/kosh/platform/resources" &&
      request.method === "GET"
    ) {
      const typeParam = url.searchParams.get("type");
      const type = typeParam ? resourceType(typeParam) : undefined;
      sendJson(
        response,
        200,
        { resources: await platformStore.listResources(type) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      url.pathname === "/v1/kosh/platform/resources" &&
      request.method === "POST"
    ) {
      const body = await readJson(request);
      const type = resourceType(body.type);
      const allowedGlobal = new Set<KoshPlatformResourceType>([
        "organization",
        "team",
        "extension",
        "admin_setting",
        "storage_policy",
        "backup"
      ]);
      if (!allowedGlobal.has(type)) {
        throw Object.assign(new Error("resource_requires_repository_scope"), {
          status: 400
        });
      }
      const key = clean(body.key, 180);
      const name = clean(body.name, 240);
      if (!key || !name) {
        throw Object.assign(new Error("resource_key_and_name_required"), {
          status: 400
        });
      }
      const resource = await platformStore.createResource({
        repositoryId: null,
        namespace: clean(body.namespace, 64) || "global",
        type,
        key,
        name,
        state: clean(body.state, 60) || "active",
        payload:
          body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
            ? body.payload as Record<string, unknown>
            : {},
        createdByUserId: identity.user.id,
        createdByName: identity.user.displayName
      });
      await audit(
        null,
        identity.user,
        "global_platform_resource_created",
        type,
        resource.id
      );
      sendJson(response, 201, resource, origin, allowedOrigins);
      return true;
    }

    if (
      url.pathname === "/v1/kosh/platform/audit" &&
      request.method === "GET"
    ) {
      sendJson(
        response,
        200,
        { events: await platformStore.listAudit(undefined, 500) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      url.pathname === "/v1/kosh/platform/summary" &&
      request.method === "GET"
    ) {
      const [repositories, resources, events] = await Promise.all([
        repositoryStore.list(),
        platformStore.listResources(),
        platformStore.listAudit(undefined, 100)
      ]);
      const counts = Object.fromEntries(
        [...resourceTypes].map((type) => [
          type,
          resources.filter((item) => item.type === type).length
        ])
      );
      sendJson(
        response,
        200,
        {
          repositories: repositories.length,
          resources: resources.length,
          counts,
          recentAudit: events,
          persistence: platformStore.kind
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    sendJson(
      response,
      404,
      { error: "kosh_platform_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
