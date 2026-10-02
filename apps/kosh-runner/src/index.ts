import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

type StepDefinition = {
  name: string;
  run: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  continueOnError?: boolean;
};

type JobDefinition = {
  id: string;
  name: string;
  timeoutMinutes?: number;
  env?: Record<string, string>;
  steps: StepDefinition[];
};

type ClaimedJob = {
  job: {
    id: string;
    runId: string;
    repositoryId: string;
    workflowId: string;
    name: string;
    timeoutMinutes: number;
    definition: JobDefinition;
  };
  run: {
    id: string;
    refName: string;
    commitSha: string;
    workflowName: string;
  };
  repository: {
    namespace: string;
    slug: string;
    name: string;
    cloneHttpUrl: string;
  };
  workflowEnv: Record<string, string>;
};

const gateway = (
  process.env.KOSH_GATEWAY_ORIGIN?.trim() || "http://localhost:4100"
).replace(/\/$/, "");
const runnerToken = process.env.KOSH_RUNNER_TOKEN?.trim() || "";
const gitToken = process.env.KOSH_GIT_TOKEN?.trim() || "";
const runnerId =
  process.env.KOSH_RUNNER_ID?.trim() ||
  "runner-" + process.pid + "-" + process.platform + "-" + process.arch;
const pollMs = Math.max(
  1000,
  Math.min(60_000, Number(process.env.KOSH_RUNNER_POLL_MS) || 5000)
);

if (!runnerToken && process.env.NODE_ENV === "production") {
  throw new Error("KOSH_RUNNER_TOKEN is required in production.");
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(gateway + path, {
    ...init,
    headers: {
      authorization: "Bearer " + runnerToken,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });

  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "Kosh runner request failed.");
  }
  return payload;
}

async function postLog(
  jobId: string,
  stream: "stdout" | "stderr" | "system",
  text: string
) {
  if (!text) return;
  await requestJson(
    "/v1/kosh/automation/runner/jobs/" +
      encodeURIComponent(jobId) +
      "/logs",
    {
      method: "POST",
      body: JSON.stringify({ stream, text: text.slice(0, 64 * 1024) })
    }
  );
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    jobId: string;
  }
) {
  return new Promise<number>((resolveCode, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let logChain = Promise.resolve();

    const enqueue = (
      stream: "stdout" | "stderr",
      chunk: Buffer
    ) => {
      const text = chunk.toString("utf8");
      logChain = logChain
        .then(() => postLog(options.jobId, stream, text))
        .catch(() => undefined);
    };

    child.stdout.on("data", (chunk: Buffer) => enqueue("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => enqueue("stderr", chunk));

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      await logChain;
      if (signal) {
        await postLog(
          options.jobId,
          "system",
          "Process ended by signal " + signal + ".\n"
        ).catch(() => undefined);
      }
      resolveCode(typeof code === "number" ? code : 1);
    });
  });
}

async function checkoutJob(context: ClaimedJob, workspace: string) {
  const cloneEnv: NodeJS.ProcessEnv = { ...process.env };

  if (gitToken) {
    cloneEnv.GIT_CONFIG_COUNT = "1";
    cloneEnv.GIT_CONFIG_KEY_0 = "http.extraHeader";
    cloneEnv.GIT_CONFIG_VALUE_0 =
      "Authorization: Basic " +
      Buffer.from("kosh-runner:" + gitToken).toString("base64");
  }

  await postLog(
    context.job.id,
    "system",
    "Checking out " +
      context.repository.namespace +
      "/" +
      context.repository.slug +
      " at " +
      context.run.commitSha.slice(0, 12) +
      ".\n"
  );

  const cloneCode = await runProcess(
    "git",
    [
      "clone",
      "--no-checkout",
      "--filter=blob:none",
      context.repository.cloneHttpUrl,
      workspace
    ],
    {
      cwd: tmpdir(),
      env: cloneEnv,
      timeoutMs: 5 * 60_000,
      jobId: context.job.id
    }
  );

  if (cloneCode !== 0) {
    throw new Error("git_clone_failed");
  }

  const checkoutCode = await runProcess(
    "git",
    ["checkout", "--detach", context.run.commitSha],
    {
      cwd: workspace,
      env: cloneEnv,
      timeoutMs: 2 * 60_000,
      jobId: context.job.id
    }
  );

  if (checkoutCode !== 0) {
    throw new Error("git_checkout_failed");
  }
}

function safeWorkingDirectory(workspace: string, requested?: string) {
  if (!requested) return workspace;
  const path = resolve(workspace, requested);
  const prefix = workspace.endsWith(sep) ? workspace : workspace + sep;
  if (path !== workspace && !path.startsWith(prefix)) {
    throw new Error("working_directory_outside_workspace");
  }
  return path;
}

async function executeSteps(context: ClaimedJob, workspace: string) {
  const shell =
    process.platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c"] }
      : { command: "/bin/sh", args: ["-lc"] };

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...context.workflowEnv,
    ...context.job.definition.env,
    KOSH_RUN_ID: context.run.id,
    KOSH_JOB_ID: context.job.id,
    KOSH_REPOSITORY:
      context.repository.namespace + "/" + context.repository.slug,
    KOSH_REF: context.run.refName,
    KOSH_COMMIT_SHA: context.run.commitSha,
    CI: "true"
  };

  const overallDeadline =
    Date.now() + context.job.timeoutMinutes * 60_000;

  for (let index = 0; index < context.job.definition.steps.length; index += 1) {
    const step = context.job.definition.steps[index];
    const remaining = overallDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error("job_timeout");
    }

    await postLog(
      context.job.id,
      "system",
      "\n▶ " + (step.name || "Step " + (index + 1)) + "\n"
    );

    const code = await runProcess(
      shell.command,
      [...shell.args, step.run],
      {
        cwd: safeWorkingDirectory(workspace, step.workingDirectory),
        env: {
          ...baseEnv,
          ...step.env
        },
        timeoutMs: remaining,
        jobId: context.job.id
      }
    );

    if (code !== 0) {
      await postLog(
        context.job.id,
        "system",
        "Step exited with code " + code + ".\n"
      );
      if (!step.continueOnError) return false;
    }
  }

  return true;
}

async function artifactFiles(root: string) {
  const result: string[] = [];

  async function walk(directory: string) {
    if (result.length >= 20) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => []
    );
    for (const entry of entries) {
      if (result.length >= 20) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const info = await stat(path);
        if (info.size > 0 && info.size <= 8 * 1024 * 1024) {
          result.push(path);
        }
      }
    }
  }

  await walk(root);
  return result;
}

async function uploadArtifacts(context: ClaimedJob, workspace: string) {
  const directory = join(workspace, ".kosh-artifacts");
  const files = await artifactFiles(directory);

  for (const path of files) {
    const buffer = await readFile(path);
    const name = path
      .slice(directory.length)
      .replace(/^[/\\]+/, "")
      .replace(/[/\\]+/g, "-");

    await requestJson(
      "/v1/kosh/automation/runner/jobs/" +
        encodeURIComponent(context.job.id) +
        "/artifacts",
      {
        method: "POST",
        body: JSON.stringify({
          name,
          base64: buffer.toString("base64")
        })
      }
    );
  }
}

async function complete(jobId: string, status: "success" | "failure") {
  await requestJson(
    "/v1/kosh/automation/runner/jobs/" +
      encodeURIComponent(jobId) +
      "/complete",
    {
      method: "POST",
      body: JSON.stringify({ status })
    }
  );
}

async function execute(context: ClaimedJob) {
  const workspace = await mkdtemp(join(tmpdir(), "kosh-runner-"));
  let success = false;

  try {
    await checkoutJob(context, workspace);
    success = await executeSteps(context, workspace);
    await uploadArtifacts(context, workspace);
  } catch (error) {
    await postLog(
      context.job.id,
      "system",
      "Runner error: " +
        (error instanceof Error ? error.message : "unknown error") +
        "\n"
    ).catch(() => undefined);
    success = false;
  } finally {
    await complete(context.job.id, success ? "success" : "failure").catch(
      () => undefined
    );
    await rm(workspace, { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

async function main() {
  process.stdout.write(
    "Kosh Runner " + runnerId + " connected to " + gateway + "\n"
  );

  while (true) {
    try {
      const claimed = await requestJson<{ job: ClaimedJob["job"] | null } & Partial<ClaimedJob>>(
        "/v1/kosh/automation/runner/claim",
        {
          method: "POST",
          body: JSON.stringify({ runnerId })
        }
      );

      if (!claimed.job || !claimed.run || !claimed.repository) {
        await sleep(pollMs);
        continue;
      }

      await execute(claimed as ClaimedJob);
    } catch (error) {
      process.stderr.write(
        "Runner polling error: " +
          (error instanceof Error ? error.message : "unknown error") +
          "\n"
      );
      await sleep(pollMs);
    }
  }
}

void main();
