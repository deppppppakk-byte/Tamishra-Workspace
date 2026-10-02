#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const gatewayOrigin = (
  process.env.KOSH_GATEWAY_ORIGIN?.trim() ||
  "http://localhost:4100"
).replace(/\/$/, "");
const serviceToken = process.env.KOSH_SSH_SERVICE_TOKEN?.trim() || "";
const repositoryRoot = resolve(
  process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos"
);

type GitOperation = "upload-pack" | "receive-pack";

function die(message: string, code = 1): never {
  process.stderr.write("Kosh SSH: " + message + "\n");
  process.exit(code);
}

function validIdentifier(value: string) {
  return /^[A-Za-z0-9._:-]{1,240}$/.test(value);
}

function parseOriginalCommand(value: string) {
  const match = value.match(
    /^git-(upload-pack|receive-pack) '([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\.git'$/
  );
  if (!match) return null;

  return {
    operation: match[1] as GitOperation,
    namespace: match[2],
    slug: match[3]
  };
}

function repositoryPath(namespace: string, slug: string) {
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep)
    ? repositoryRoot
    : repositoryRoot + sep;

  if (!path.startsWith(prefix)) {
    die("Invalid repository path.");
  }

  return path;
}

async function branchSnapshot(gitDir: string) {
  const result = await execFileAsync(
    "git",
    [
      "--git-dir",
      gitDir,
      "for-each-ref",
      "--format=%(refname:short)%00%(objectname)",
      "refs/heads"
    ],
    {
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    }
  );

  const refs = new Map<string, string>();
  for (const line of String(result.stdout).split(/\r?\n/)) {
    if (!line) continue;
    const [name, sha] = line.split("\0");
    if (
      name &&
      /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/.test(name) &&
      /^[0-9a-f]{40}$/i.test(sha ?? "")
    ) {
      refs.set(name, sha);
    }
  }
  return refs;
}

async function notifyPush(input: {
  userId: string;
  keyId: string;
  namespace: string;
  slug: string;
  branches: Array<{ name: string; sha: string }>;
}) {
  if (!input.branches.length) return;

  const response = await fetch(
    gatewayOrigin + "/v1/kosh/ssh/internal/push",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kosh-ssh-service-token": serviceToken,
        accept: "application/json"
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      "push event rejected (" + response.status + "): " + text.slice(0, 300)
    );
  }
}

async function runGitTransport(command: string, gitDir: string) {
  return new Promise<{ code: number; signal: NodeJS.Signals | null }>(
    (resolveResult, reject) => {
      const child = spawn(command, [gitDir], {
        stdio: "inherit",
        env: process.env
      });

      const forward = (signal: NodeJS.Signals) => {
        if (!child.killed) child.kill(signal);
      };
      const onTerm = () => forward("SIGTERM");
      const onInt = () => forward("SIGINT");
      process.on("SIGTERM", onTerm);
      process.on("SIGINT", onInt);

      child.on("error", (error) => {
        process.off("SIGTERM", onTerm);
        process.off("SIGINT", onInt);
        reject(error);
      });

      child.on("exit", (code, signal) => {
        process.off("SIGTERM", onTerm);
        process.off("SIGINT", onInt);
        resolveResult({ code: code ?? 1, signal });
      });
    }
  );
}

async function authorize(input: {
  userId: string;
  keyId: string;
  namespace: string;
  slug: string;
  operation: GitOperation;
}) {
  const response = await fetch(
    gatewayOrigin + "/v1/kosh/ssh/internal/authorize",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kosh-ssh-service-token": serviceToken,
        accept: "application/json"
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000)
    }
  );

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error =
      payload &&
      typeof payload === "object" &&
      "error" in payload
        ? String((payload as { error?: unknown }).error)
        : "repository access denied";
    die(error);
  }

  return payload;
}

async function main() {
  const userId = String(process.argv[2] ?? "").trim();
  const keyId = String(process.argv[3] ?? "").trim();
  const originalCommand = String(process.env.SSH_ORIGINAL_COMMAND ?? "").trim();

  if (!serviceToken) die("KOSH_SSH_SERVICE_TOKEN is required.");
  if (!validIdentifier(userId) || !validIdentifier(keyId)) {
    die("Invalid SSH identity.");
  }

  const command = parseOriginalCommand(originalCommand);
  if (!command) {
    die("Only Kosh Git SSH operations are allowed.");
  }

  await authorize({
    userId,
    keyId,
    namespace: command.namespace,
    slug: command.slug,
    operation: command.operation
  });

  const gitCommand =
    command.operation === "receive-pack"
      ? "git-receive-pack"
      : "git-upload-pack";
  const gitDir = repositoryPath(command.namespace, command.slug);

  const before =
    command.operation === "receive-pack"
      ? await branchSnapshot(gitDir)
      : new Map<string, string>();

  const result = await runGitTransport(gitCommand, gitDir);

  if (result.signal) {
    process.stderr.write(
      "Kosh SSH: Git transport stopped by " + result.signal + ".\n"
    );
    process.exitCode = 1;
    return;
  }

  if (result.code === 0 && command.operation === "receive-pack") {
    try {
      const after = await branchSnapshot(gitDir);
      const branches = [...after.entries()]
        .filter(([name, sha]) => before.get(name) !== sha)
        .map(([name, sha]) => ({ name, sha }));

      await notifyPush({
        userId,
        keyId,
        namespace: command.namespace,
        slug: command.slug,
        branches
      });
    } catch (error) {
      process.stderr.write(
        "Kosh SSH: push completed, but event delivery failed: " +
          (error instanceof Error ? error.message : "unknown error") +
          "\n"
      );
    }
  }

  process.exitCode = result.code;
}

main().catch((error) => {
  die(error instanceof Error ? error.message : "SSH Git transport failed.");
});
