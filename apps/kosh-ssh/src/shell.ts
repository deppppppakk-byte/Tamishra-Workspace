#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";

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

  const child = spawn(gitCommand, [gitDir], {
    stdio: "inherit",
    env: process.env
  });

  child.on("error", (error) => {
    process.stderr.write("Kosh SSH: Git transport failed: " + error.message + "\n");
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.stderr.write("Kosh SSH: Git transport stopped by " + signal + ".\n");
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });

  const forward = (signal: NodeJS.Signals) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGINT", () => forward("SIGINT"));
}

main().catch((error) => {
  die(error instanceof Error ? error.message : "SSH Git transport failed.");
});
