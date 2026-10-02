import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveWorkspaceIdentity } from "./identity.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";
import { getKoshWorkStore } from "./kosh-work-store.js";
import { requiredChecksForCommit, scheduleAutomationEvent } from "./kosh-automation-service.js";
import {
  getKoshReviewStore,
  type KoshReviewState,
  type StoredKoshChangeRequest,
  type StoredKoshReview
} from "./kosh-review-store.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const reviewStore = getKoshReviewStore();
const workStore = getKoshWorkStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");

type JsonBody = Record<string, unknown>;

type CompareFile = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

type CompareResult = {
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  ahead: number;
  behind: number;
  mergeable: boolean;
  files: CompareFile[];
  patch: string | null;
  patchTruncated: boolean;
};

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 256 * 1024
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
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? "").trim().replace(/\r\n/g, "\n").slice(0, maxLength);
}

function validRepoSegment(value: string, maxLength: number) {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
  );
}

function repoPath(namespace: string, slug: string) {
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_repository_path"), { status: 400 });
  }
  return path;
}

async function gitResult(
  gitDir: string,
  args: string[],
  options?: {
    timeout?: number;
    maxBuffer?: number;
    env?: Record<string, string | undefined>;
  }
) {
  try {
    const result = await execFileAsync(
      "git",
      ["--git-dir", gitDir, ...args],
      {
        timeout: options?.timeout ?? 15_000,
        maxBuffer: options?.maxBuffer ?? 8 * 1024 * 1024,
        encoding: "utf8",
        env: options?.env ? { ...process.env, ...options.env } : process.env
      }
    );
    return {
      code: 0,
      stdout: String(result.stdout),
      stderr: String(result.stderr)
    };
  } catch (error) {
    const value = error as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: typeof value.code === "number" ? value.code : 1,
      stdout: String(value.stdout ?? ""),
      stderr: String(value.stderr ?? "")
    };
  }
}

async function git(
  gitDir: string,
  args: string[],
  status = 500
) {
  const result = await gitResult(gitDir, args);
  if (result.code !== 0) {
    throw Object.assign(
      new Error(result.stderr.trim() || "git_command_failed"),
      { status }
    );
  }
  return result.stdout;
}

async function boundedGitOutput(
  gitDir: string,
  args: string[],
  maxBytes: number
): Promise<{ text: string | null; truncated: boolean }> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn("git", ["--git-dir", gitDir, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const chunks: Buffer[] = [];
    let total = 0;
    let stderr = "";
    let truncated = false;
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(Object.assign(new Error("git_command_timeout"), { status: 504 }));
    }, 20_000);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      total += chunk.length;
      if (total > maxBytes) {
        truncated = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      reject(Object.assign(new Error(error.message), { status: 500 }));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (finished) return;
      finished = true;
      if (code !== 0) {
        reject(
          Object.assign(new Error(stderr.trim() || "git_command_failed"), {
            status: 500
          })
        );
        return;
      }
      resolveOutput({
        text: truncated ? null : Buffer.concat(chunks).toString("utf8"),
        truncated
      });
    });
  });
}

async function requireIdentity(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const identity = await resolveWorkspaceIdentity(request);
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

async function repositoryContext(namespace: string, slug: string) {
  if (
    !validRepoSegment(namespace, 64) ||
    !validRepoSegment(slug, 100)
  ) {
    throw Object.assign(new Error("repository_not_found"), { status: 404 });
  }

  const repository = await repositoryStore.get(namespace, slug);
  if (!repository) {
    throw Object.assign(new Error("repository_not_found"), { status: 404 });
  }

  return {
    repository,
    gitDir: repoPath(namespace, slug)
  };
}

async function setProtectedBranch(
  gitDir: string,
  branch: string,
  protectedBranch: boolean
) {
  const filePath = resolve(gitDir, "kosh-protected-refs");
  const refName = "refs/heads/" + branch;
  let content = "";

  try {
    content = await readFile(filePath, "utf8");
  } catch {
    content = "";
  }

  const refs = new Set(
    content
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean)
  );

  if (protectedBranch) refs.add(refName);
  else refs.delete(refName);

  await writeFile(
    filePath,
    [...refs].sort().join("\n") + ([...refs].length ? "\n" : ""),
    "utf8"
  );
}

async function checkBranchName(gitDir: string, branch: string) {
  const name = cleanText(branch, 240);
  if (!name) {
    throw Object.assign(new Error("branch_name_required"), { status: 400 });
  }

  const result = await execFileAsync(
    "git",
    ["check-ref-format", "--branch", name],
    { timeout: 10_000, encoding: "utf8" }
  ).catch(() => null);

  if (!result) {
    throw Object.assign(new Error("invalid_branch_name"), { status: 400 });
  }

  return name;
}

async function resolveBranch(gitDir: string, branch: string) {
  const name = await checkBranchName(gitDir, branch);
  const output = await git(
    gitDir,
    ["rev-parse", "--verify", "refs/heads/" + name + "^{commit}"],
    404
  );
  const sha = output.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw Object.assign(new Error("branch_not_found"), { status: 404 });
  }
  return { name, sha };
}

function issueReferences(text: string) {
  const values = new Set<number>();
  const regex = /#(\d+)/g;
  for (const match of text.matchAll(regex)) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0) values.add(number);
    if (values.size >= 100) break;
  }
  return [...values];
}

function closingIssueReferences(text: string) {
  const values = new Set<number>();
  const regex = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  for (const match of text.matchAll(regex)) {
    const number = Number(match[1]);
    if (Number.isInteger(number) && number > 0) values.add(number);
    if (values.size >= 100) break;
  }
  return [...values];
}

async function linkReferencedIssues(
  repositoryId: string,
  changeRequest: StoredKoshChangeRequest,
  actorUserId: string
) {
  await workStore.ready();
  for (const number of issueReferences(
    changeRequest.title + "\n" + changeRequest.description
  )) {
    const issue = await workStore.getIssue(repositoryId, number);
    if (!issue) continue;

    await workStore.createIssueLink({
      issueId: issue.id,
      linkType: "change_request",
      refValue: String(changeRequest.number),
      title: changeRequest.title,
      createdByUserId: actorUserId
    });

    await workStore.createActivity({
      repositoryId,
      entityType: "issue",
      entityId: issue.id,
      entityNumber: issue.number,
      eventType: "change_request_linked",
      actorUserId,
      actorName: changeRequest.authorName,
      payload: {
        changeRequestNumber: changeRequest.number,
        title: changeRequest.title
      }
    });
  }
}

async function linkCommitReferences(
  repositoryId: string,
  gitDir: string,
  comparison: CompareResult,
  actorUserId: string
) {
  await workStore.ready();

  const log = await git(
    gitDir,
    [
      "log",
      comparison.mergeBaseSha + ".." + comparison.headSha,
      "--format=%H%x00%s%x00%b%x00"
    ]
  );

  const fields = log.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index]?.trim();
    const subject = fields[index + 1] ?? "";
    const body = fields[index + 2] ?? "";
    if (!/^[0-9a-f]{40}$/i.test(sha)) continue;

    for (const number of issueReferences(subject + "\n" + body)) {
      const issue = await workStore.getIssue(repositoryId, number);
      if (!issue) continue;

      await workStore.createIssueLink({
        issueId: issue.id,
        linkType: "commit",
        refValue: sha,
        title: subject || null,
        createdByUserId: actorUserId
      });
    }
  }
}

async function closeIssuesFromChangeRequest(
  repositoryId: string,
  changeRequest: StoredKoshChangeRequest,
  actor: { id: string; displayName: string }
) {
  await workStore.ready();

  const closed: number[] = [];
  for (const number of closingIssueReferences(
    changeRequest.title + "\n" + changeRequest.description
  )) {
    const issue = await workStore.getIssue(repositoryId, number);
    if (!issue) continue;

    await workStore.createIssueLink({
      issueId: issue.id,
      linkType: "change_request",
      refValue: String(changeRequest.number),
      title: changeRequest.title,
      createdByUserId: actor.id
    });

    if (issue.state !== "closed") {
      const updated = await workStore.updateIssue(repositoryId, number, {
        state: "closed",
        actorUserId: actor.id,
        actorName: actor.displayName
      });

      if (updated) {
        closed.push(number);
        await workStore.createActivity({
          repositoryId,
          entityType: "issue",
          entityId: issue.id,
          entityNumber: issue.number,
          eventType: "issue_closed_by_change_request",
          actorUserId: actor.id,
          actorName: actor.displayName,
          payload: { changeRequestNumber: changeRequest.number }
        });
      }
    }
  }

  return closed;
}

function parseNameStatus(output: string) {
  const map = new Map<string, CompareFile>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    const path =
      status.startsWith("R") || status.startsWith("C")
        ? parts[2] ?? parts[1] ?? ""
        : parts[1] ?? "";
    if (!path) continue;
    map.set(path, {
      path,
      status,
      additions: null,
      deletions: null
    });
  }
  return map;
}

function mergeNumStat(map: Map<string, CompareFile>, output: string) {
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const additions = parts[0] === "-" ? null : Number(parts[0]);
    const deletions = parts[1] === "-" ? null : Number(parts[1]);
    const path = parts.slice(2).join("\t");
    const existing = map.get(path);
    if (existing) {
      existing.additions = Number.isFinite(additions) ? additions : null;
      existing.deletions = Number.isFinite(deletions) ? deletions : null;
    } else {
      map.set(path, {
        path,
        status: "M",
        additions: Number.isFinite(additions) ? additions : null,
        deletions: Number.isFinite(deletions) ? deletions : null
      });
    }
  }
}

async function compareBranches(
  gitDir: string,
  baseBranch: string,
  headBranch: string
): Promise<CompareResult> {
  const base = await resolveBranch(gitDir, baseBranch);
  const head = await resolveBranch(gitDir, headBranch);

  if (base.name === head.name) {
    throw Object.assign(new Error("branches_must_differ"), { status: 400 });
  }

  const mergeBaseSha = (
    await git(gitDir, ["merge-base", base.sha, head.sha], 409)
  ).trim();

  const counts = (
    await git(gitDir, ["rev-list", "--left-right", "--count", base.sha + "..." + head.sha])
  ).trim().split(/\s+/);

  const behind = Number(counts[0] ?? 0);
  const ahead = Number(counts[1] ?? 0);

  const nameStatus = await git(
    gitDir,
    ["diff", "--name-status", "--find-renames", mergeBaseSha + ".." + head.sha]
  );
  const files = parseNameStatus(nameStatus);

  const numStat = await git(
    gitDir,
    ["diff", "--numstat", "--find-renames", mergeBaseSha + ".." + head.sha]
  );
  mergeNumStat(files, numStat);

  const mergeTree = await gitResult(
    gitDir,
    ["merge-tree", "--write-tree", base.sha, head.sha],
    { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
  );

  const patchResult = await boundedGitOutput(
    gitDir,
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      "--unified=3",
      mergeBaseSha + ".." + head.sha
    ],
    2 * 1024 * 1024
  );

  return {
    baseBranch: base.name,
    headBranch: head.name,
    baseSha: base.sha,
    headSha: head.sha,
    mergeBaseSha,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
    mergeable: mergeTree.code === 0,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    patch: patchResult.text,
    patchTruncated: patchResult.truncated
  };
}

function latestReviewStates(
  reviews: StoredKoshReview[],
  changeRequest: StoredKoshChangeRequest
) {
  const latest = new Map<string, StoredKoshReview>();

  for (const review of reviews) {
    if (review.createdAt < changeRequest.updatedAt) continue;
    latest.set(review.reviewerUserId, review);
  }

  const states = [...latest.values()];
  const approvals = states.filter(
    (review) =>
      review.state === "approve" &&
      review.reviewerUserId !== changeRequest.authorUserId
  );
  const changesRequested = states.filter(
    (review) => review.state === "request_changes"
  );

  return {
    approvals: approvals.length,
    changesRequested: changesRequested.length,
    latest: states
  };
}

async function synchronizedRequest(
  gitDir: string,
  repository: StoredKoshRepository,
  requestNumber: number
) {
  const changeRequest = await reviewStore.getChangeRequest(
    repository.id,
    requestNumber
  );

  if (!changeRequest) {
    throw Object.assign(new Error("change_request_not_found"), { status: 404 });
  }

  if (changeRequest.status !== "open") {
    return changeRequest;
  }

  const base = await resolveBranch(gitDir, changeRequest.baseBranch);
  const head = await resolveBranch(gitDir, changeRequest.headBranch);
  const refsChanged =
    base.sha !== changeRequest.baseSha ||
    head.sha !== changeRequest.headSha;

  const synchronized =
    (
      await reviewStore.syncChangeRequest(
        repository.id,
        requestNumber,
        base.sha,
        head.sha
      )
    ) ?? changeRequest;

  if (refsChanged) {
    await scheduleAutomationEvent(
      repository,
      "change_request",
      synchronized.baseBranch,
      synchronized.headSha,
      { id: null, name: "Change Review update" },
      synchronized.number
    );
  }

  return synchronized;
}

async function mergeChangeRequest(
  gitDir: string,
  changeRequest: StoredKoshChangeRequest,
  actor: { id: string; displayName: string; email: string }
) {
  const comparison = await compareBranches(
    gitDir,
    changeRequest.baseBranch,
    changeRequest.headBranch
  );

  if (
    comparison.baseSha !== changeRequest.baseSha ||
    comparison.headSha !== changeRequest.headSha
  ) {
    throw Object.assign(new Error("change_request_updated_reload_required"), {
      status: 409
    });
  }

  if (!comparison.mergeable) {
    throw Object.assign(new Error("merge_conflict"), { status: 409 });
  }

  if (comparison.ahead < 1) {
    throw Object.assign(new Error("no_changes_to_merge"), { status: 409 });
  }

  const baseRef = "refs/heads/" + comparison.baseBranch;
  const ancestor = await gitResult(
    gitDir,
    ["merge-base", "--is-ancestor", comparison.baseSha, comparison.headSha]
  );

  if (ancestor.code === 0) {
    const update = await gitResult(
      gitDir,
      [
        "update-ref",
        "-m",
        "Kosh change request #" + changeRequest.number,
        baseRef,
        comparison.headSha,
        comparison.baseSha
      ]
    );

    if (update.code !== 0) {
      throw Object.assign(new Error("base_branch_moved"), { status: 409 });
    }

    return comparison.headSha;
  }

  const treeResult = await gitResult(
    gitDir,
    ["merge-tree", "--write-tree", comparison.baseSha, comparison.headSha],
    { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }
  );

  if (treeResult.code !== 0) {
    throw Object.assign(new Error("merge_conflict"), { status: 409 });
  }

  const treeSha = treeResult.stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/i.test(treeSha)) {
    throw Object.assign(new Error("merge_tree_failed"), { status: 500 });
  }

  const message =
    "Merge change request #" +
    changeRequest.number +
    ": " +
    changeRequest.title;

  const commitResult = await gitResult(
    gitDir,
    [
      "commit-tree",
      treeSha,
      "-p",
      comparison.baseSha,
      "-p",
      comparison.headSha,
      "-m",
      message
    ],
    {
      timeout: 15_000,
      env: {
        GIT_AUTHOR_NAME: actor.displayName,
        GIT_AUTHOR_EMAIL: actor.email,
        GIT_COMMITTER_NAME: actor.displayName,
        GIT_COMMITTER_EMAIL: actor.email
      }
    }
  );

  if (commitResult.code !== 0) {
    throw Object.assign(new Error("merge_commit_failed"), { status: 500 });
  }

  const mergeSha = commitResult.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(mergeSha)) {
    throw Object.assign(new Error("merge_commit_failed"), { status: 500 });
  }

  const update = await gitResult(
    gitDir,
    [
      "update-ref",
      "-m",
      "Kosh change request #" + changeRequest.number,
      baseRef,
      mergeSha,
      comparison.baseSha
    ]
  );

  if (update.code !== 0) {
    throw Object.assign(new Error("base_branch_moved"), { status: 409 });
  }

  return mergeSha;
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
    error instanceof Error ? error.message : "kosh_change_review_error";

  sendJson(response, status, { error: message }, origin, allowedOrigins);
}

export async function handleKoshChangeReviewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})(.*)$/
  );

  if (!match) return false;

  const namespace = match[1];
  const slug = match[2];
  const tail = match[3] || "";

  const recognized =
    tail === "/compare" ||
    tail === "/branches" ||
    /^\/branches\/.+/.test(tail) ||
    /^\/policies\/.+/.test(tail) ||
    tail === "/change-requests" ||
    /^\/change-requests\/\d+(?:\/(?:reviews|comments|merge))?$/.test(tail);

  if (!recognized) return false;

  const identity = await requireIdentity(
    request,
    response,
    origin,
    allowedOrigins
  );
  if (!identity) return true;

  try {
    await reviewStore.ready();
    const { repository, gitDir } = await repositoryContext(namespace, slug);

    if (request.method === "GET" && tail === "/compare") {
      const baseBranch = cleanText(url.searchParams.get("base"), 240);
      const headBranch = cleanText(url.searchParams.get("head"), 240);

      if (!baseBranch || !headBranch) {
        throw Object.assign(new Error("base_and_head_required"), { status: 400 });
      }

      sendJson(
        response,
        200,
        await compareBranches(gitDir, baseBranch, headBranch),
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "POST" && tail === "/branches") {
      const body = await readJson(request);
      const branchName = await checkBranchName(
        gitDir,
        cleanText(body.name, 240)
      );
      const from = cleanText(body.from, 240) || repository.defaultBranch;
      const source = await resolveBranch(gitDir, from);

      const existing = await gitResult(
        gitDir,
        ["show-ref", "--verify", "--quiet", "refs/heads/" + branchName]
      );
      if (existing.code === 0) {
        throw Object.assign(new Error("branch_exists"), { status: 409 });
      }

      const created = await gitResult(
        gitDir,
        ["update-ref", "refs/heads/" + branchName, source.sha]
      );
      if (created.code !== 0) {
        throw Object.assign(new Error("branch_creation_failed"), { status: 500 });
      }

      sendJson(
        response,
        201,
        { name: branchName, sha: source.sha, from: source.name },
        origin,
        allowedOrigins
      );
      return true;
    }

    const branchDelete = tail.match(/^\/branches\/(.+)$/);
    if (branchDelete && request.method === "DELETE") {
      const branchName = await checkBranchName(
        gitDir,
        decodeURIComponent(branchDelete[1])
      );

      if (branchName === repository.defaultBranch) {
        throw Object.assign(new Error("default_branch_cannot_be_deleted"), {
          status: 409
        });
      }

      const policy = await reviewStore.getBranchPolicy(
        repository.id,
        branchName
      );
      if (!policy.allowDelete) {
        throw Object.assign(new Error("branch_deletion_blocked_by_policy"), {
          status: 403
        });
      }

      const current = await resolveBranch(gitDir, branchName);
      const deleted = await gitResult(
        gitDir,
        ["update-ref", "-d", "refs/heads/" + branchName, current.sha]
      );
      if (deleted.code !== 0) {
        throw Object.assign(new Error("branch_delete_failed"), { status: 500 });
      }

      await setProtectedBranch(gitDir, branchName, false);

      sendJson(
        response,
        200,
        { deleted: true, branch: branchName },
        origin,
        allowedOrigins
      );
      return true;
    }

    const policyMatch = tail.match(/^\/policies\/(.+)$/);
    if (policyMatch) {
      const branchName = await checkBranchName(
        gitDir,
        decodeURIComponent(policyMatch[1])
      );

      if (request.method === "GET") {
        sendJson(
          response,
          200,
          await reviewStore.getBranchPolicy(repository.id, branchName),
          origin,
          allowedOrigins
        );
        return true;
      }

      if (request.method === "PUT") {
        const body = await readJson(request);
        const requiredApprovals = Math.min(
          20,
          Math.max(0, Number(body.requiredApprovals ?? 1) || 0)
        );

        const policy = await reviewStore.upsertBranchPolicy(
          repository.id,
          branchName,
          {
            requiredApprovals,
            blockOnChangesRequested: body.blockOnChangesRequested !== false,
            allowDirectPush: body.allowDirectPush === true,
            allowDelete: body.allowDelete === true
          }
        );

        await setProtectedBranch(
          gitDir,
          branchName,
          !policy.allowDirectPush
        );

        sendJson(response, 200, policy, origin, allowedOrigins);
        return true;
      }
    }

    if (tail === "/change-requests" && request.method === "GET") {
      const items = await reviewStore.listChangeRequests(repository.id);
      sendJson(
        response,
        200,
        { changeRequests: items },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/change-requests" && request.method === "POST") {
      const body = await readJson(request);
      const title = cleanText(body.title, 200);
      const description = cleanText(body.description, 10_000);
      const baseBranch = cleanText(body.baseBranch, 240) || repository.defaultBranch;
      const headBranch = cleanText(body.headBranch, 240);

      if (!title || !headBranch) {
        throw Object.assign(new Error("title_and_head_required"), { status: 400 });
      }

      const comparison = await compareBranches(
        gitDir,
        baseBranch,
        headBranch
      );

      if (comparison.ahead < 1) {
        throw Object.assign(new Error("no_changes_to_review"), { status: 409 });
      }

      const existing = (await reviewStore.listChangeRequests(repository.id))
        .find(
          (item) =>
            item.status === "open" &&
            item.baseBranch === comparison.baseBranch &&
            item.headBranch === comparison.headBranch
        );

      if (existing) {
        throw Object.assign(new Error("change_request_already_open"), {
          status: 409
        });
      }

      const created = await reviewStore.createChangeRequest({
        repositoryId: repository.id,
        namespace,
        slug,
        title,
        description,
        baseBranch: comparison.baseBranch,
        headBranch: comparison.headBranch,
        baseSha: comparison.baseSha,
        headSha: comparison.headSha,
        authorUserId: identity.user.id,
        authorName: identity.user.displayName
      });

      await Promise.all([
        linkReferencedIssues(repository.id, created, identity.user.id),
        linkCommitReferences(
          repository.id,
          gitDir,
          comparison,
          identity.user.id
        )
      ]);

      await scheduleAutomationEvent(
        repository,
        "change_request",
        created.baseBranch,
        created.headSha,
        { id: identity.user.id, name: identity.user.displayName },
        created.number
      );

      sendJson(response, 201, created, origin, allowedOrigins);
      return true;
    }

    const requestMatch = tail.match(
      /^\/change-requests\/(\d+)(?:\/(reviews|comments|merge))?$/
    );

    if (requestMatch) {
      const requestNumber = Number(requestMatch[1]);
      const action = requestMatch[2] ?? "";

      if (!Number.isInteger(requestNumber) || requestNumber < 1) {
        throw Object.assign(new Error("invalid_change_request_number"), {
          status: 400
        });
      }

      const changeRequest = await synchronizedRequest(
        gitDir,
        repository,
        requestNumber
      );

      if (!action && request.method === "GET") {
        const [comparison, reviews, comments, policy, checks] = await Promise.all([
          compareBranches(
            gitDir,
            changeRequest.baseBranch,
            changeRequest.headBranch
          ),
          reviewStore.listReviews(changeRequest.id),
          reviewStore.listComments(changeRequest.id),
          reviewStore.getBranchPolicy(
            repository.id,
            changeRequest.baseBranch
          ),
          requiredChecksForCommit(repository.id, changeRequest.headSha)
        ]);

        const reviewState = latestReviewStates(reviews, changeRequest);

        sendJson(
          response,
          200,
          {
            changeRequest,
            comparison,
            reviews,
            comments,
            policy,
            reviewSummary: {
              approvals: reviewState.approvals,
              changesRequested: reviewState.changesRequested,
              requiredApprovals: policy.requiredApprovals,
              readyToMerge:
                changeRequest.status === "open" &&
                comparison.mergeable &&
                comparison.ahead > 0 &&
                reviewState.approvals >= policy.requiredApprovals &&
                (!policy.blockOnChangesRequested ||
                  reviewState.changesRequested === 0) &&
                checks.passing,
              checksPassing: checks.passing,
              checksPending: checks.pending,
              checksFailing: checks.failing
            },
            checks: checks.checks
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (!action && request.method === "PATCH") {
        const body = await readJson(request);
        if (body.status !== "closed") {
          throw Object.assign(new Error("unsupported_change_request_update"), {
            status: 400
          });
        }
        const closed = await reviewStore.closeChangeRequest(
          repository.id,
          requestNumber
        );
        sendJson(response, 200, closed, origin, allowedOrigins);
        return true;
      }

      if (action === "reviews" && request.method === "POST") {
        if (changeRequest.status !== "open") {
          throw Object.assign(new Error("change_request_not_open"), { status: 409 });
        }

        const body = await readJson(request);
        const state = String(body.state ?? "") as KoshReviewState;

        if (!["approve", "request_changes", "comment"].includes(state)) {
          throw Object.assign(new Error("invalid_review_state"), { status: 400 });
        }

        const review = await reviewStore.createReview({
          changeRequestId: changeRequest.id,
          reviewerUserId: identity.user.id,
          reviewerName: identity.user.displayName,
          state,
          body: cleanText(body.body, 10_000)
        });

        sendJson(response, 201, review, origin, allowedOrigins);
        return true;
      }

      if (action === "comments" && request.method === "POST") {
        if (changeRequest.status !== "open") {
          throw Object.assign(new Error("change_request_not_open"), { status: 409 });
        }

        const body = await readJson(request);
        const commentBody = cleanText(body.body, 10_000);
        if (!commentBody) {
          throw Object.assign(new Error("comment_body_required"), { status: 400 });
        }

        const commentPath = cleanText(body.path, 2048) || null;
        const side =
          body.side === "base" || body.side === "head"
            ? body.side
            : null;
        const lineValue = body.line === null || body.line === undefined
          ? null
          : Number(body.line);
        const line =
          lineValue && Number.isInteger(lineValue) && lineValue > 0
            ? lineValue
            : null;

        if (commentPath) {
          const comparison = await compareBranches(
            gitDir,
            changeRequest.baseBranch,
            changeRequest.headBranch
          );
          if (!comparison.files.some((file) => file.path === commentPath)) {
            throw Object.assign(new Error("comment_file_not_in_change_request"), {
              status: 400
            });
          }
        }

        const comment = await reviewStore.createComment({
          changeRequestId: changeRequest.id,
          authorUserId: identity.user.id,
          authorName: identity.user.displayName,
          path: commentPath,
          line,
          side: commentPath ? side : null,
          body: commentBody
        });

        sendJson(response, 201, comment, origin, allowedOrigins);
        return true;
      }

      if (action === "merge" && request.method === "POST") {
        if (changeRequest.status !== "open") {
          throw Object.assign(new Error("change_request_not_open"), { status: 409 });
        }

        const synchronized = await synchronizedRequest(
          gitDir,
          repository,
          requestNumber
        );
        const [reviews, policy] = await Promise.all([
          reviewStore.listReviews(synchronized.id),
          reviewStore.getBranchPolicy(
            repository.id,
            synchronized.baseBranch
          )
        ]);

        const reviewState = latestReviewStates(reviews, synchronized);

        if (reviewState.approvals < policy.requiredApprovals) {
          throw Object.assign(new Error("required_approvals_missing"), {
            status: 409
          });
        }

        if (
          policy.blockOnChangesRequested &&
          reviewState.changesRequested > 0
        ) {
          throw Object.assign(new Error("changes_requested"), { status: 409 });
        }

        let checks = await requiredChecksForCommit(
          repository.id,
          synchronized.headSha
        );

        if (checks.required.length === 0) {
          const scheduled = await scheduleAutomationEvent(
            repository,
            "change_request",
            synchronized.baseBranch,
            synchronized.headSha,
            { id: identity.user.id, name: identity.user.displayName },
            synchronized.number
          );
          if (scheduled.length > 0) {
            checks = await requiredChecksForCommit(
              repository.id,
              synchronized.headSha
            );
          }
        }

        if (checks.pending > 0) {
          throw Object.assign(new Error("required_checks_pending"), {
            status: 409
          });
        }

        if (checks.failing > 0 || !checks.passing) {
          throw Object.assign(new Error("required_checks_failed"), {
            status: 409
          });
        }

        const mergeCommitSha = await mergeChangeRequest(
          gitDir,
          synchronized,
          {
            id: identity.user.id,
            displayName: identity.user.displayName,
            email: identity.user.email
          }
        );

        const merged = await reviewStore.markMerged(
          repository.id,
          requestNumber,
          identity.user.id,
          identity.user.displayName,
          mergeCommitSha
        );

        const closedIssues = merged
          ? await closeIssuesFromChangeRequest(
              repository.id,
              merged,
              {
                id: identity.user.id,
                displayName: identity.user.displayName
              }
            )
          : [];

        sendJson(
          response,
          200,
          {
            merged: true,
            mergeCommitSha,
            changeRequest: merged,
            closedIssues
          },
          origin,
          allowedOrigins
        );
        return true;
      }
    }

    return false;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
