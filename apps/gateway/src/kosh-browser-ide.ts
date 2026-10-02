import { execFile } from "node:child_process";
import { mkdir, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { scheduleAutomationEvent } from "./kosh-automation-service.js";
import { triggerKoshCodeIndexAfterPush } from "./kosh-code-intelligence.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { triggerKoshSecurityScanAfterPush } from "./kosh-security.js";
import {
  getKoshStore,
  type StoredKoshRepository
} from "./kosh-store.js";
import { dispatchKoshWebhooks } from "./kosh-webhooks.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const repositoryRoot = resolve(
  process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos"
);

type JsonBody = Record<string, unknown>;

type IdeWriteOperation = {
  type: "write";
  path: string;
  content: string;
};

type IdeDeleteOperation = {
  type: "delete";
  path: string;
};

type IdeRenameOperation = {
  type: "rename";
  path: string;
  toPath: string;
};

type IdeOperation =
  | IdeWriteOperation
  | IdeDeleteOperation
  | IdeRenameOperation;

type PreparedWorkspace = {
  workspace: string;
  branch: string;
  baseBranch: string;
  branchExists: boolean;
  previousHeadSha: string | null;
  baseSha: string;
};

class IdeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {}
  ) {
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
  maxBytes = 8 * 1024 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new IdeRequestError("payload_too_large", 413);
    }
    chunks.push(buffer);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonBody;
  } catch {
    throw new IdeRequestError("invalid_json", 400);
  }
}

function clean(value: unknown, max = 2048) {
  return String(value ?? "").trim().slice(0, max);
}

function maxOperations() {
  const value = Number(process.env.KOSH_IDE_MAX_OPERATIONS ?? 100);
  return Number.isFinite(value)
    ? Math.max(1, Math.min(500, Math.floor(value)))
    : 100;
}

function maxFileBytes() {
  const value = Number(process.env.KOSH_IDE_MAX_FILE_KB ?? 1024);
  const kb = Number.isFinite(value)
    ? Math.max(16, Math.min(10_240, Math.floor(value)))
    : 1024;
  return kb * 1024;
}

function maxTotalBytes() {
  const value = Number(process.env.KOSH_IDE_MAX_TOTAL_MB ?? 5);
  const mb = Number.isFinite(value)
    ? Math.max(1, Math.min(50, Math.floor(value)))
    : 5;
  return mb * 1024 * 1024;
}

function maxDiffBytes() {
  const value = Number(process.env.KOSH_IDE_MAX_DIFF_KB ?? 1536);
  const kb = Number.isFinite(value)
    ? Math.max(64, Math.min(8192, Math.floor(value)))
    : 1536;
  return kb * 1024;
}

function repositoryPath(namespace: string, slug: string) {
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep)
    ? repositoryRoot
    : repositoryRoot + sep;
  if (!path.startsWith(prefix)) {
    throw new IdeRequestError("invalid_repository_path", 400);
  }
  return path;
}

function validBranch(value: string) {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("//") &&
    !value.split("/").some((part) => part.startsWith("."))
  );
}

function safeEditPath(workspace: string, input: string) {
  const relative = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (
    !relative ||
    relative.length > 2048 ||
    relative.includes("\0") ||
    relative
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git"
      )
  ) {
    throw new IdeRequestError("invalid_edit_path", 400, { path: input });
  }

  const path = resolve(workspace, relative);
  const prefix = workspace.endsWith(sep) ? workspace : workspace + sep;
  if (!path.startsWith(prefix)) {
    throw new IdeRequestError("invalid_edit_path", 400, { path: input });
  }
  return { relative, path };
}

async function assertNoSymlinkTraversal(
  workspace: string,
  relative: string,
  includeLeaf: boolean
) {
  const parts = relative.split("/");
  const limit = includeLeaf ? parts.length : Math.max(0, parts.length - 1);
  let current = workspace;

  for (let index = 0; index < limit; index += 1) {
    current = resolve(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new IdeRequestError("ide_symlink_edit_forbidden", 400, {
          path: relative
        });
      }
    } catch (error) {
      if (
        error instanceof IdeRequestError ||
        !(
          typeof error === "object" &&
          error &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        )
      ) {
        throw error;
      }
      return;
    }
  }
}

async function execGit(
  cwd: string,
  args: string[],
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
    env?: Record<string, string | undefined>;
    conflictStatus?: number;
  } = {}
) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
      encoding: "utf8",
      env: options.env ? { ...process.env, ...options.env } : process.env
    });
    return String(result.stdout);
  } catch (error) {
    const value = error as { stderr?: string; stdout?: string };
    const message = String(
      value.stderr || value.stdout || "git_command_failed"
    ).trim();
    throw new IdeRequestError(
      message.slice(0, 2000) || "git_command_failed",
      options.conflictStatus ?? 409
    );
  }
}

async function resolveRefSha(gitDir: string, branch: string) {
  try {
    const result = await execFileAsync(
      "git",
      [
        "--git-dir",
        gitDir,
        "rev-parse",
        "--verify",
        "refs/heads/" + branch + "^{commit}"
      ],
      {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8"
      }
    );
    const sha = String(result.stdout).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function parseOperations(body: JsonBody): IdeOperation[] {
  const raw = Array.isArray(body.operations)
    ? body.operations
    : Array.isArray(body.files)
      ? body.files.map((item) => {
          if (!item || typeof item !== "object") return item;
          const record = item as Record<string, unknown>;
          return {
            type: record.content === null ? "delete" : "write",
            path: record.path,
            content: record.content
          };
        })
      : [];

  if (raw.length < 1 || raw.length > maxOperations()) {
    throw new IdeRequestError("ide_operations_required", 400, {
      maxOperations: maxOperations()
    });
  }

  let totalBytes = 0;
  const operations: IdeOperation[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new IdeRequestError("invalid_ide_operation", 400);
    }
    const record = item as Record<string, unknown>;
    const type = clean(record.type, 20);
    const path = clean(record.path, 2048);

    if (type === "write") {
      const content =
        typeof record.content === "string"
          ? record.content
          : String(record.content ?? "");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > maxFileBytes()) {
        throw new IdeRequestError("ide_file_too_large", 413, {
          path,
          maxFileBytes: maxFileBytes()
        });
      }
      totalBytes += bytes;
      operations.push({ type: "write", path, content });
      continue;
    }

    if (type === "delete") {
      operations.push({ type: "delete", path });
      continue;
    }

    if (type === "rename") {
      operations.push({
        type: "rename",
        path,
        toPath: clean(record.toPath, 2048)
      });
      continue;
    }

    throw new IdeRequestError("invalid_ide_operation", 400, { type });
  }

  if (totalBytes > maxTotalBytes()) {
    throw new IdeRequestError("ide_change_set_too_large", 413, {
      maxTotalBytes: maxTotalBytes()
    });
  }

  return operations;
}

async function prepareWorkspace(input: {
  repository: StoredKoshRepository;
  branch: string;
  baseBranch: string;
  expectedHeadSha: string;
}) {
  if (
    !validBranch(input.branch) ||
    input.branch === input.repository.defaultBranch
  ) {
    throw new IdeRequestError("ide_requires_non_default_branch", 400, {
      defaultBranch: input.repository.defaultBranch
    });
  }
  if (!validBranch(input.baseBranch)) {
    throw new IdeRequestError("invalid_base_branch", 400);
  }
  if (!/^[0-9a-f]{40}$/i.test(input.expectedHeadSha)) {
    throw new IdeRequestError("ide_expected_head_required", 400);
  }

  const gitDir = repositoryPath(
    input.repository.namespace,
    input.repository.slug
  );
  const [branchHead, baseSha] = await Promise.all([
    resolveRefSha(gitDir, input.branch),
    resolveRefSha(gitDir, input.baseBranch)
  ]);

  if (!baseSha) {
    throw new IdeRequestError("ide_base_branch_not_found", 404, {
      baseBranch: input.baseBranch
    });
  }

  const currentHead = branchHead ?? baseSha;
  if (currentHead !== input.expectedHeadSha) {
    throw new IdeRequestError("ide_branch_moved", 409, {
      expectedHeadSha: input.expectedHeadSha,
      currentHeadSha: currentHead,
      branchExists: Boolean(branchHead)
    });
  }

  const workspace = await mkdtemp(
    resolve(tmpdir(), "kosh-ide-").endsWith(sep)
      ? resolve(tmpdir(), "kosh-ide-")
      : resolve(tmpdir(), "kosh-ide-") + "-"
  );

  try {
    await execGit(tmpdir(), [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      gitDir,
      workspace
    ]);

    if (branchHead) {
      await execGit(workspace, ["checkout", input.branch]);
    } else {
      await execGit(workspace, ["checkout", input.baseBranch]);
      await execGit(workspace, ["checkout", "-b", input.branch]);
    }

    return {
      workspace,
      branch: input.branch,
      baseBranch: input.baseBranch,
      branchExists: Boolean(branchHead),
      previousHeadSha: branchHead,
      baseSha
    } satisfies PreparedWorkspace;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function applyOperations(
  workspace: string,
  operations: IdeOperation[]
) {
  for (const operation of operations) {
    const source = safeEditPath(workspace, operation.path);

    if (operation.type === "write") {
      await assertNoSymlinkTraversal(workspace, source.relative, true);
      await mkdir(dirname(source.path), { recursive: true });
      await writeFile(source.path, operation.content, "utf8");
      continue;
    }

    if (operation.type === "delete") {
      await assertNoSymlinkTraversal(workspace, source.relative, true);
      await rm(source.path, { force: true, recursive: false }).catch((error) => {
        if (
          typeof error === "object" &&
          error &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        ) {
          return;
        }
        throw error;
      });
      continue;
    }

    const target = safeEditPath(workspace, operation.toPath);
    await assertNoSymlinkTraversal(workspace, source.relative, true);
    await assertNoSymlinkTraversal(workspace, target.relative, true);

    try {
      await lstat(source.path);
    } catch {
      throw new IdeRequestError("ide_rename_source_not_found", 404, {
        path: source.relative
      });
    }

    try {
      await lstat(target.path);
      throw new IdeRequestError("ide_rename_target_exists", 409, {
        path: target.relative
      });
    } catch (error) {
      if (
        error instanceof IdeRequestError ||
        !(
          typeof error === "object" &&
          error &&
          "code" in error &&
          (error as { code?: string }).code === "ENOENT"
        )
      ) {
        throw error;
      }
    }

    await mkdir(dirname(target.path), { recursive: true });
    await rename(source.path, target.path);
  }
}

async function stagedChangeSummary(workspace: string) {
  await execGit(workspace, ["add", "-A"]);

  const statusOutput = await execGit(workspace, [
    "diff",
    "--cached",
    "--name-status",
    "-M"
  ]);

  const changedFiles = statusOutput
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 500)
    .map((line) => {
      const parts = line.split("\t");
      const code = parts[0] || "M";
      if (code.startsWith("R")) {
        return {
          status: "renamed",
          path: parts[1] || "",
          toPath: parts[2] || ""
        };
      }
      return {
        status:
          code === "A"
            ? "added"
            : code === "D"
              ? "deleted"
              : "modified",
        path: parts[1] || "",
        toPath: null
      };
    });

  const stats = await execGit(workspace, [
    "diff",
    "--cached",
    "--shortstat"
  ]);

  let diff = await execGit(
    workspace,
    ["diff", "--cached", "--no-color", "--unified=3", "--"],
    { maxBuffer: 8 * 1024 * 1024 }
  );

  let truncated = false;
  const limit = maxDiffBytes();
  if (Buffer.byteLength(diff, "utf8") > limit) {
    diff = Buffer.from(diff, "utf8").subarray(0, limit).toString("utf8");
    truncated = true;
  }

  return {
    changedFiles,
    stats: stats.trim(),
    diff,
    truncated
  };
}

async function stateFor(
  repository: StoredKoshRepository,
  branch: string,
  baseBranch: string
) {
  const gitDir = repositoryPath(repository.namespace, repository.slug);
  const [branchHead, baseSha, defaultHead] = await Promise.all([
    branch ? resolveRefSha(gitDir, branch) : Promise.resolve(null),
    resolveRefSha(gitDir, baseBranch),
    resolveRefSha(gitDir, repository.defaultBranch)
  ]);

  return {
    repositoryId: repository.id,
    defaultBranch: repository.defaultBranch,
    defaultHeadSha: defaultHead,
    branch,
    branchExists: Boolean(branchHead),
    branchHeadSha: branchHead,
    baseBranch,
    baseSha,
    expectedHeadSha: branchHead ?? baseSha,
    editable:
      Boolean(branch) &&
      validBranch(branch) &&
      branch !== repository.defaultBranch &&
      Boolean(baseSha),
    limits: {
      maxOperations: maxOperations(),
      maxFileBytes: maxFileBytes(),
      maxTotalBytes: maxTotalBytes(),
      maxDiffBytes: maxDiffBytes()
    }
  };
}

async function commitWorkspace(input: {
  prepared: PreparedWorkspace;
  message: string;
  actor: { id: string; displayName: string; email: string };
}) {
  const { workspace } = input.prepared;
  const status = await execGit(workspace, ["status", "--porcelain"]);
  if (!status.trim()) {
    throw new IdeRequestError("no_changes_to_commit", 409);
  }

  await execGit(
    workspace,
    ["commit", "-m", input.message],
    {
      env: {
        GIT_AUTHOR_NAME: input.actor.displayName,
        GIT_AUTHOR_EMAIL: input.actor.email,
        GIT_COMMITTER_NAME: input.actor.displayName,
        GIT_COMMITTER_EMAIL: input.actor.email
      }
    }
  );

  const commitSha = (
    await execGit(workspace, ["rev-parse", "HEAD"])
  ).trim();

  const branchRef = "refs/heads/" + input.prepared.branch;
  const lease = input.prepared.branchExists
    ? "--force-with-lease=" +
      branchRef +
      ":" +
      input.prepared.previousHeadSha
    : "--force-with-lease=" + branchRef + ":";

  await execGit(workspace, [
    "push",
    lease,
    "origin",
    "HEAD:" + branchRef
  ]);

  return commitSha;
}

async function auditIdeCommit(
  repository: StoredKoshRepository,
  actor: { id: string; displayName: string },
  result: {
    branch: string;
    previousHeadSha: string | null;
    commitSha: string;
    changedFiles: Array<Record<string, unknown>>;
  }
) {
  await platformStore.appendAudit({
    repositoryId: repository.id,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType: "browser_ide_commit",
    resourceType: "repository",
    resourceId: repository.id,
    metadata: result
  });
}

export async function handleKoshBrowserIdeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/ide\/(state|preview|commit)$/
  );
  if (!match) return false;

  try {
    await Promise.all([repositoryStore.ready(), platformStore.ready()]);
    const repository = await repositoryStore.get(match[1], match[2]);
    if (!repository) {
      sendJson(
        response,
        404,
        { error: "repository_not_found" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const permission =
      request.method === "GET" ? "repository.read" : "repository.write";
    const authorization = await authorizeKoshRepositoryRequest(
      request,
      repository,
      permission
    );

    if (!authorization.decision.allowed) {
      sendJson(
        response,
        authorization.identity ? 403 : 401,
        {
          error: authorization.identity
            ? "repository_permission_denied"
            : "authentication_required",
          permission,
          role: authorization.decision.role
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    const action = match[3];

    if (action === "state" && request.method === "GET") {
      const branch = clean(url.searchParams.get("branch"), 200);
      const baseBranch =
        clean(url.searchParams.get("baseBranch"), 200) ||
        repository.defaultBranch;
      const state = await stateFor(repository, branch, baseBranch);
      sendJson(response, 200, state, origin, allowedOrigins);
      return true;
    }

    if (
      (action === "preview" || action === "commit") &&
      request.method === "POST"
    ) {
      if (!authorization.identity) {
        sendJson(
          response,
          401,
          { error: "authentication_required" },
          origin,
          allowedOrigins
        );
        return true;
      }

      const body = await readJson(request);
      const branch = clean(body.branch, 200);
      const baseBranch =
        clean(body.baseBranch, 200) || repository.defaultBranch;
      const expectedHeadSha = clean(body.expectedHeadSha, 40);
      const operations = parseOperations(body);
      const prepared = await prepareWorkspace({
        repository,
        branch,
        baseBranch,
        expectedHeadSha
      });

      try {
        await applyOperations(prepared.workspace, operations);
        const summary = await stagedChangeSummary(prepared.workspace);

        if (action === "preview") {
          sendJson(
            response,
            200,
            {
              branch,
              branchExists: prepared.branchExists,
              previousHeadSha: prepared.previousHeadSha,
              baseBranch,
              expectedHeadSha,
              ...summary
            },
            origin,
            allowedOrigins
          );
          return true;
        }

        if (!summary.changedFiles.length) {
          throw new IdeRequestError("no_changes_to_commit", 409);
        }

        const message = clean(body.message, 500);
        if (!message) {
          throw new IdeRequestError("commit_message_required", 400);
        }

        const actor = {
          id: authorization.identity.user.id,
          displayName: authorization.identity.user.displayName,
          email: authorization.identity.user.email
        };
        const commitSha = await commitWorkspace({
          prepared,
          message,
          actor
        });

        const auditPayload = {
          branch,
          previousHeadSha: prepared.previousHeadSha,
          commitSha,
          changedFiles: summary.changedFiles
        };

        await Promise.allSettled([
          auditIdeCommit(repository, actor, auditPayload),
          scheduleAutomationEvent(
            repository,
            "push",
            branch,
            commitSha,
            { id: actor.id, name: actor.displayName },
            null
          )
        ]);

        void dispatchKoshWebhooks(repository.id, "push", {
          namespace: repository.namespace,
          slug: repository.slug,
          branch,
          commitSha,
          source: "browser-ide"
        }).catch(() => undefined);

        triggerKoshSecurityScanAfterPush(
          repository,
          { id: actor.id, name: actor.displayName },
          [branch]
        );
        triggerKoshCodeIndexAfterPush(
          repository,
          { id: actor.id, name: actor.displayName },
          [branch]
        );

        sendJson(
          response,
          201,
          {
            branch,
            createdBranch: !prepared.branchExists,
            previousHeadSha: prepared.previousHeadSha,
            commitSha,
            message,
            changedFiles: summary.changedFiles,
            stats: summary.stats
          },
          origin,
          allowedOrigins
        );
        return true;
      } finally {
        await rm(prepared.workspace, {
          recursive: true,
          force: true
        }).catch(() => undefined);
      }
    }

    sendJson(
      response,
      405,
      { error: "method_not_allowed" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    const status =
      error instanceof IdeRequestError
        ? error.status
        : typeof error === "object" && error && "status" in error
          ? Number((error as { status?: number }).status) || 500
          : 500;
    const message =
      error instanceof Error ? error.message : "browser_ide_error";
    const details =
      error instanceof IdeRequestError ? error.details : {};

    sendJson(
      response,
      status,
      { error: message, ...details },
      origin,
      allowedOrigins
    );
    return true;
  }
}
