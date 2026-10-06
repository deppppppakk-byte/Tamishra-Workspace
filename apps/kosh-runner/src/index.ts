import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

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
  image?: string;
  network?: "none" | "egress";
  cpu?: number;
  memoryMb?: number;
  pidsLimit?: number;
  secrets?: string[];
  runsOn?: string[];
  publishPackages?: boolean;
  steps: StepDefinition[];
};

type ClaimedEnvironment = {
  environment: {
    id: string;
    repositoryId: string;
    namespace: string;
    repositorySlug: string;
    name: string;
    refName: string;
    commitSha: string;
    image: string;
    network: "none" | "egress";
    cpu: number;
    memoryMb: number;
    pidsLimit: number;
    ttlMinutes: number;
    idleMinutes: number;
    command: string;
    state: string;
    expiresAt: string;
  };
  repository: {
    namespace: string;
    slug: string;
    cloneHttpUrl: string;
  };
  lease: { token: string; expiresAt: string | null };
  checkoutCredential: { token: string; expiresAt: string };
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
    leaseExpiresAt: string | null;
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
  secrets: Record<string, string>;
  lease: {
    token: string;
    expiresAt: string | null;
  };
  checkoutCredential: {
    token: string;
    expiresAt: string;
  };
  isolation: {
    executor: "container" | "host";
    image: string;
    network: "none" | "egress";
    cpu: number;
    memoryMb: number;
    pidsLimit: number;
  };
};

const gateway = (
  process.env.KOSH_GATEWAY_ORIGIN?.trim() || "http://localhost:4100"
).replace(/\/$/, "");
const runnerToken = process.env.KOSH_RUNNER_TOKEN?.trim() || "";
const runnerId =
  process.env.KOSH_RUNNER_ID?.trim() ||
  "runner-" + process.pid + "-" + process.platform + "-" + process.arch;
const executor =
  process.env.KOSH_RUNNER_EXECUTOR?.trim().toLowerCase() === "host"
    ? "host" as const
    : "container" as const;
const containerRuntime =
  process.env.KOSH_RUNNER_CONTAINER_RUNTIME?.trim() || "docker";
const concurrency = Math.max(
  1,
  Math.min(16, Math.floor(Number(process.env.KOSH_RUNNER_CONCURRENCY) || 1))
);
const pollMs = Math.max(
  1000,
  Math.min(60_000, Number(process.env.KOSH_RUNNER_POLL_MS) || 5000)
);
const maxCpu = Math.max(
  0.1,
  Math.min(32, Number(process.env.KOSH_RUNNER_MAX_CPU) || 4)
);
const maxMemoryMb = Math.max(
  128,
  Math.min(
    65_536,
    Math.floor(Number(process.env.KOSH_RUNNER_MAX_MEMORY_MB) || 4096)
  )
);
const maxPids = Math.max(
  32,
  Math.min(
    8192,
    Math.floor(Number(process.env.KOSH_RUNNER_MAX_PIDS) || 512)
  )
);
const allowNetwork =
  process.env.KOSH_RUNNER_ALLOW_NETWORK?.trim().toLowerCase() === "true";
const allowHostExecution =
  process.env.KOSH_RUNNER_ALLOW_HOST_EXECUTION?.trim().toLowerCase() ===
  "true";
const allowedImages = new Set(
  (
    process.env.KOSH_RUNNER_IMAGE_ALLOWLIST?.trim() ||
    "node:22-bookworm-slim"
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const labels = [
  "os:" + process.platform,
  "arch:" + process.arch,
  "executor:" + executor,
  ...(process.env.KOSH_RUNNER_LABELS?.split(",") ?? [])
]
  .map((value) => value.trim())
  .filter((value) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value))
  .slice(0, 64);
const activeJobs = new Set<string>();
const activeEnvironments = new Set<string>();
const runnerVersion = "0.3.0";

if (!runnerToken && process.env.NODE_ENV === "production") {
  throw new Error("KOSH_RUNNER_TOKEN is required in production.");
}
if (
  executor === "host" &&
  process.env.NODE_ENV === "production" &&
  !allowHostExecution
) {
  throw new Error(
    "Host execution is disabled in production. Use KOSH_RUNNER_EXECUTOR=container."
  );
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function runnerPayload(status: "online" | "draining" = "online") {
  return {
    runnerId,
    executor,
    labels,
    capacity: concurrency,
    activeJobs: activeJobs.size + activeEnvironments.size,
    version: runnerVersion,
    os: process.platform,
    arch: process.arch,
    status
  };
}

function leaseHeaders(context: ClaimedJob) {
  return {
    "x-kosh-runner-id": runnerId,
    "x-kosh-job-lease": context.lease.token
  };
}

async function requestJson<T>(
  path: string,
  init: RequestInit = {},
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const response = await fetch(gateway + path, {
    ...init,
    headers: {
      authorization: "Bearer " + runnerToken,
      "content-type": "application/json",
      ...extraHeaders,
      ...(init.headers ?? {})
    }
  });

  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "Kosh runner request failed.");
  }
  return payload;
}

async function requestBinary<T>(
  path: string,
  bytes: Buffer,
  extraHeaders: Record<string, string>
): Promise<T> {
  const response = await fetch(gateway + path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + runnerToken,
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      ...extraHeaders
    },
    body: new Uint8Array(bytes)
  });
  const text = await response.text();
  let payload: (T & { error?: string }) | null = null;
  try {
    payload = text ? JSON.parse(text) as T & { error?: string } : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new Error(payload?.error || text || "Kosh binary upload failed.");
  }
  return (payload ?? {}) as T;
}

function secretValues(context: ClaimedJob) {
  return [
    ...Object.values(context.secrets),
    context.checkoutCredential.token,
    context.lease.token
  ].filter((value) => value.length >= 4);
}

function redact(context: ClaimedJob, text: string) {
  let value = text;
  for (const secret of secretValues(context)) {
    value = value.split(secret).join("***");
  }
  return value;
}

async function postLog(
  context: ClaimedJob,
  stream: "stdout" | "stderr" | "system",
  text: string
) {
  if (!text) return;
  await requestJson(
    "/v1/kosh/automation/runner/jobs/" +
      encodeURIComponent(context.job.id) +
      "/logs",
    {
      method: "POST",
      body: JSON.stringify({
        stream,
        text: redact(context, text).slice(0, 64 * 1024)
      })
    },
    leaseHeaders(context)
  );
}

function safeHostEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || homedir(),
    USERPROFILE: process.env.USERPROFILE,
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    ...extra
  };
  return env;
}

function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    context: ClaimedJob;
    logOutput?: boolean;
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
      if (options.logOutput === false) return;
      const text = chunk.toString("utf8");
      logChain = logChain
        .then(() => postLog(options.context, stream, text))
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
      if (signal && options.logOutput !== false) {
        await postLog(
          options.context,
          "system",
          "Process ended by signal " + signal + ".\n"
        ).catch(() => undefined);
      }
      resolveCode(typeof code === "number" ? code : 1);
    });
  });
}

async function probeCommand(command: string, args: string[]) {
  return new Promise<void>((resolveProbe, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("runner_runtime_probe_timeout"));
    }, 15_000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveProbe();
      else reject(new Error(stderr.trim() || "runner_runtime_probe_failed"));
    });
  });
}

async function checkoutJob(context: ClaimedJob, workspace: string) {
  const authHeader =
    "Authorization: Basic " +
    Buffer.from(
      "kosh-runner:" + context.checkoutCredential.token
    ).toString("base64");

  const cloneEnv = safeHostEnvironment({
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: authHeader
  });

  await postLog(
    context,
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
      context
    }
  );

  if (cloneCode !== 0) throw new Error("git_clone_failed");

  const checkoutCode = await runProcess(
    "git",
    ["checkout", "--detach", context.run.commitSha],
    {
      cwd: workspace,
      env: cloneEnv,
      timeoutMs: 2 * 60_000,
      context
    }
  );

  if (checkoutCode !== 0) throw new Error("git_checkout_failed");
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

function containerWorkingDirectory(workspace: string, requested?: string) {
  const hostPath = safeWorkingDirectory(workspace, requested);
  const suffix = relative(workspace, hostPath).replace(/\\/g, "/");
  return suffix ? "/workspace/" + suffix : "/workspace";
}

function normalizedJobEnvironment(
  context: ClaimedJob,
  step: StepDefinition
) {
  const result: Record<string, string> = {
    ...context.workflowEnv,
    ...context.job.definition.env,
    ...step.env,
    KOSH_RUN_ID: context.run.id,
    KOSH_JOB_ID: context.job.id,
    KOSH_REPOSITORY:
      context.repository.namespace + "/" + context.repository.slug,
    KOSH_REF: context.run.refName,
    KOSH_COMMIT_SHA: context.run.commitSha,
    CI: "true"
  };

  for (const [key, value] of Object.entries(result)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key)) {
      delete result[key];
      continue;
    }
    result[key] = String(value).slice(0, 16 * 1024);
  }

  return result;
}

async function prepareContainerEnvironment(
  context: ClaimedJob,
  step: StepDefinition,
  jobRoot: string,
  index: number
) {
  const env = normalizedJobEnvironment(context, step);
  const secretsDir = join(jobRoot, "secrets");
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  await chmod(secretsDir, 0o700);

  for (const [name, rawValue] of Object.entries(context.secrets)) {
    const value = String(rawValue);
    if (
      value.includes("\n") ||
      value.includes("\r") ||
      value.includes("\0")
    ) {
      const path = join(secretsDir, name);
      await writeFile(path, value, { mode: 0o600 });
      await chmod(path, 0o600);
      env[name + "_FILE"] = "/run/kosh-secrets/" + name;
    } else {
      env[name] = value;
    }
  }

  const envFile = join(jobRoot, "env-" + index + ".list");
  const body = Object.entries(env)
    .map(([key, value]) => key + "=" + value.replace(/\r?\n/g, " "))
    .join("\n");
  await writeFile(envFile, body + "\n", { mode: 0o600 });
  await chmod(envFile, 0o600);

  return { envFile, secretsDir };
}

function enforceRunnerPolicy(context: ClaimedJob) {
  const image = context.isolation.image;
  if (!allowedImages.has(image)) {
    throw new Error("runner_image_not_allowed");
  }

  if (context.isolation.network === "egress" && !allowNetwork) {
    throw new Error("runner_network_not_allowed");
  }

  return {
    image,
    network:
      context.isolation.network === "egress" && allowNetwork
        ? "bridge"
        : "none",
    cpu: Math.max(0.1, Math.min(maxCpu, context.isolation.cpu || 1)),
    memoryMb: Math.max(
      128,
      Math.min(maxMemoryMb, Math.floor(context.isolation.memoryMb || 1024))
    ),
    pidsLimit: Math.max(
      32,
      Math.min(maxPids, Math.floor(context.isolation.pidsLimit || 256))
    )
  };
}

async function executeContainerSteps(
  context: ClaimedJob,
  workspace: string,
  jobRoot: string,
  leaseHealthy: () => boolean
) {
  const policy = enforceRunnerPolicy(context);
  const overallDeadline =
    Date.now() + context.job.timeoutMinutes * 60_000;

  await postLog(
    context,
    "system",
    "Isolation: container=" +
      policy.image +
      ", network=" +
      policy.network +
      ", cpu=" +
      policy.cpu +
      ", memory=" +
      policy.memoryMb +
      "MB, pids=" +
      policy.pidsLimit +
      ".\n"
  );

  for (
    let index = 0;
    index < context.job.definition.steps.length;
    index += 1
  ) {
    if (!leaseHealthy()) throw new Error("job_lease_lost");

    const step = context.job.definition.steps[index];
    const remaining = overallDeadline - Date.now();
    if (remaining <= 0) throw new Error("job_timeout");

    await postLog(
      context,
      "system",
      "\n▶ " + (step.name || "Step " + (index + 1)) + "\n"
    );

    const { envFile, secretsDir } =
      await prepareContainerEnvironment(context, step, jobRoot, index);

    const containerName = (
      "kosh-" +
      context.job.id.slice(0, 12) +
      "-" +
      index +
      "-" +
      process.pid
    ).replace(/[^a-zA-Z0-9_.-]/g, "-");

    const args = [
      "run",
      "--rm",
      "--init",
      "--name",
      containerName,
      "--workdir",
      containerWorkingDirectory(workspace, step.workingDirectory),
      "--mount",
      "type=bind,src=" + workspace + ",dst=/workspace,rw",
      "--mount",
      "type=bind,src=" + secretsDir + ",dst=/run/kosh-secrets,readonly",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=268435456",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(policy.pidsLimit),
      "--memory",
      String(policy.memoryMb) + "m",
      "--cpus",
      String(policy.cpu),
      "--network",
      policy.network,
      "--env-file",
      envFile,
      "--label",
      "kosh.runner=" + runnerId,
      "--label",
      "kosh.job=" + context.job.id,
      policy.image,
      "/bin/sh",
      "-lc",
      step.run
    ];

    const code = await runProcess(containerRuntime, args, {
      cwd: jobRoot,
      env: safeHostEnvironment(),
      timeoutMs: remaining,
      context
    });

    await rm(envFile, { force: true }).catch(() => undefined);

    if (code !== 0) {
      await postLog(
        context,
        "system",
        "Step exited with code " + code + ".\n"
      );
      if (!step.continueOnError) return false;
    }
  }

  return true;
}

async function executeHostSteps(
  context: ClaimedJob,
  workspace: string,
  leaseHealthy: () => boolean
) {
  if (process.env.NODE_ENV === "production" && !allowHostExecution) {
    throw new Error("host_runner_execution_disabled");
  }

  const shell =
    process.platform === "win32"
      ? { command: "cmd.exe", args: ["/d", "/s", "/c"] }
      : { command: "/bin/sh", args: ["-lc"] };
  const overallDeadline =
    Date.now() + context.job.timeoutMinutes * 60_000;

  for (
    let index = 0;
    index < context.job.definition.steps.length;
    index += 1
  ) {
    if (!leaseHealthy()) throw new Error("job_lease_lost");

    const step = context.job.definition.steps[index];
    const remaining = overallDeadline - Date.now();
    if (remaining <= 0) throw new Error("job_timeout");

    await postLog(
      context,
      "system",
      "\n▶ " + (step.name || "Step " + (index + 1)) + "\n"
    );

    const env: NodeJS.ProcessEnv = {
      ...safeHostEnvironment(),
      ...normalizedJobEnvironment(context, step)
    };
    for (const [name, value] of Object.entries(context.secrets)) {
      env[name] = value;
    }

    const code = await runProcess(
      shell.command,
      [...shell.args, step.run],
      {
        cwd: safeWorkingDirectory(workspace, step.workingDirectory),
        env,
        timeoutMs: remaining,
        context
      }
    );

    if (code !== 0) {
      await postLog(
        context,
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
      },
      leaseHeaders(context)
    );
  }
}

type PackageManifestEntry = {
  path: string;
  key?: string;
  name?: string;
  version: string;
  format?: string;
  mediaType?: string;
  channel?: string;
  metadata?: Record<string, unknown>;
};

async function uploadPackages(
  context: ClaimedJob,
  workspace: string
) {
  if (context.job.definition.publishPackages !== true) return;

  const manifestPath = join(
    workspace,
    ".kosh-packages",
    "manifest.json"
  );

  let document: unknown;
  try {
    document = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("package_manifest_missing_or_invalid");
  }

  const entries =
    document &&
    typeof document === "object" &&
    !Array.isArray(document) &&
    Array.isArray((document as { packages?: unknown }).packages)
      ? (document as { packages: unknown[] }).packages
      : [];

  if (!entries.length || entries.length > 50) {
    throw new Error("package_manifest_entries_invalid");
  }

  const maxMb = Math.max(
    1,
    Math.min(
      1024,
      Number(process.env.KOSH_RUNNER_PACKAGE_MAX_MB) || 64
    )
  );
  const maxBytes = Math.floor(maxMb * 1024 * 1024);

  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("package_manifest_entry_invalid");
    }

    const entry = raw as Record<string, unknown>;
    const sourcePath = String(entry.path ?? "").trim();
    const version = String(entry.version ?? "").trim();

    if (!sourcePath || !version) {
      throw new Error("package_path_and_version_required");
    }

    const absolutePath = safeWorkingDirectory(workspace, sourcePath);
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) {
      throw new Error("package_file_size_invalid");
    }

    const bytes = await readFile(absolutePath);
    const packageKey =
      String(entry.key ?? "").trim() || context.repository.slug;
    const filename = basename(absolutePath);
    const metadata =
      entry.metadata &&
      typeof entry.metadata === "object" &&
      !Array.isArray(entry.metadata)
        ? entry.metadata as Record<string, unknown>
        : {};

    await postLog(
      context,
      "system",
      "Publishing package " +
        packageKey +
        "@" +
        version +
        " from " +
        sourcePath +
        " using Kosh binary transport.\n"
    );

    const metadataEncoded = Buffer.from(
      JSON.stringify(metadata),
      "utf8"
    ).toString("base64url");

    await requestBinary(
      "/v1/kosh/automation/runner/jobs/" +
        encodeURIComponent(context.job.id) +
        "/packages/binary",
      bytes,
      {
        ...leaseHeaders(context),
        "x-kosh-package-key": packageKey,
        "x-kosh-package-name": String(entry.name ?? "").trim() || packageKey,
        "x-kosh-package-version": version,
        "x-kosh-package-filename": filename,
        "x-kosh-package-format": String(entry.format ?? "").trim() || "generic",
        "x-kosh-package-media-type":
          String(entry.mediaType ?? "").trim() || "application/octet-stream",
        "x-kosh-package-channel": String(entry.channel ?? "").trim(),
        "x-kosh-package-metadata": metadataEncoded
      }
    );
  }
}

async function complete(
  context: ClaimedJob,
  status: "success" | "failure"
) {
  await requestJson(
    "/v1/kosh/automation/runner/jobs/" +
      encodeURIComponent(context.job.id) +
      "/complete",
    {
      method: "POST",
      body: JSON.stringify({ status })
    },
    leaseHeaders(context)
  );
}

async function heartbeat(context?: ClaimedJob) {
  const body = {
    ...runnerPayload(),
    ...(context ? { jobId: context.job.id } : {})
  };

  await requestJson(
    "/v1/kosh/automation/runner/heartbeat",
    {
      method: "POST",
      body: JSON.stringify(body)
    },
    context ? leaseHeaders(context) : {}
  );
}

async function execute(context: ClaimedJob) {
  const jobRoot = await mkdtemp(join(tmpdir(), "kosh-runner-job-"));
  const workspace = join(jobRoot, "workspace");
  let success = false;
  let heartbeatFailures = 0;
  let leaseHealthy = true;

  activeJobs.add(context.job.id);

  const heartbeatTimer = setInterval(() => {
    void heartbeat(context)
      .then(() => {
        heartbeatFailures = 0;
        leaseHealthy = true;
      })
      .catch(() => {
        heartbeatFailures += 1;
        if (heartbeatFailures >= 2) leaseHealthy = false;
      });
  }, 20_000);
  heartbeatTimer.unref();

  try {
    await heartbeat(context);
    await checkoutJob(context, workspace);

    success =
      executor === "container"
        ? await executeContainerSteps(
            context,
            workspace,
            jobRoot,
            () => leaseHealthy
          )
        : await executeHostSteps(
            context,
            workspace,
            () => leaseHealthy
          );

    if (success && leaseHealthy) {
      await uploadPackages(context, workspace);
    }

    if (leaseHealthy) {
      await uploadArtifacts(context, workspace);
    }
  } catch (error) {
    await postLog(
      context,
      "system",
      "Runner error: " +
        redact(
          context,
          error instanceof Error ? error.message : "unknown error"
        ) +
        "\n"
    ).catch(() => undefined);
    success = false;
  } finally {
    clearInterval(heartbeatTimer);

    if (leaseHealthy) {
      await complete(context, success ? "success" : "failure").catch(
        () => undefined
      );
    }

    activeJobs.delete(context.job.id);
    await rm(jobRoot, { recursive: true, force: true }).catch(
      () => undefined
    );
    await heartbeat().catch(() => undefined);
  }
}

async function runRaw(command: string, args: string[], cwd = tmpdir(), env: NodeJS.ProcessEnv = safeHostEnvironment()) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString("utf8")).slice(-64 * 1024); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024); });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code: typeof code === "number" ? code : 1, stdout, stderr }));
  });
}

async function claimEnvironment() {
  return requestJson<Partial<ClaimedEnvironment> & { environment: ClaimedEnvironment["environment"] | null }>(
    "/v1/kosh/dev-environments/runner/claim",
    { method: "POST", body: JSON.stringify({ runnerId }) }
  );
}

async function environmentHeartbeat(context: ClaimedEnvironment, containerId: string) {
  return requestJson<{ stopRequested: boolean }>(
    "/v1/kosh/dev-environments/runner/heartbeat",
    {
      method: "POST",
      body: JSON.stringify({
        runnerId,
        environmentId: context.environment.id,
        leaseToken: context.lease.token,
        containerId
      })
    }
  );
}

async function completeEnvironment(
  context: ClaimedEnvironment,
  state: "stopped" | "failed" | "expired",
  failureReason?: string
) {
  await requestJson(
    "/v1/kosh/dev-environments/runner/complete",
    {
      method: "POST",
      body: JSON.stringify({
        runnerId,
        environmentId: context.environment.id,
        leaseToken: context.lease.token,
        state,
        failureReason
      })
    }
  );
}

async function executeEnvironment(context: ClaimedEnvironment) {
  if (executor !== "container") {
    await completeEnvironment(context, "failed", "development_environments_require_container_executor");
    return;
  }

  const envRoot = await mkdtemp(join(tmpdir(), "kosh-dev-env-"));
  const workspace = join(envRoot, "workspace");
  const containerName = ("kosh-env-" + context.environment.id.slice(0, 12) + "-" + process.pid).replace(/[^a-zA-Z0-9_.-]/g, "-");
  let containerId = "";
  activeEnvironments.add(context.environment.id);

  try {
    if (!allowedImages.has(context.environment.image)) throw new Error("runner_image_not_allowed");
    if (context.environment.network === "egress" && !allowNetwork) throw new Error("runner_network_not_allowed");

    const authHeader = "Authorization: Basic " + Buffer.from("kosh-runner:" + context.checkoutCredential.token).toString("base64");
    const cloneEnv = safeHostEnvironment({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: authHeader
    });
    const clone = await runRaw("git", ["clone", "--no-checkout", "--filter=blob:none", context.repository.cloneHttpUrl, workspace], tmpdir(), cloneEnv);
    if (clone.code !== 0) throw new Error(clone.stderr || "git_clone_failed");
    const checkout = await runRaw("git", ["checkout", "--detach", context.environment.commitSha], workspace, cloneEnv);
    if (checkout.code !== 0) throw new Error(checkout.stderr || "git_checkout_failed");

    const cpu = Math.max(0.1, Math.min(maxCpu, context.environment.cpu || 1));
    const memoryMb = Math.max(128, Math.min(maxMemoryMb, Math.floor(context.environment.memoryMb || 1024)));
    const pidsLimit = Math.max(32, Math.min(maxPids, Math.floor(context.environment.pidsLimit || 256)));
    const network = context.environment.network === "egress" && allowNetwork ? "bridge" : "none";

    const launched = await runRaw(containerRuntime, [
      "run", "-d", "--init", "--name", containerName,
      "--workdir", "/workspace",
      "--mount", "type=bind,src=" + workspace + ",dst=/workspace,rw",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=268435456",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(pidsLimit),
      "--memory", String(memoryMb) + "m",
      "--cpus", String(cpu),
      "--network", network,
      "--label", "kosh.runner=" + runnerId,
      "--label", "kosh.environment=" + context.environment.id,
      context.environment.image,
      "/bin/sh", "-lc", context.environment.command
    ], envRoot);
    if (launched.code !== 0) throw new Error(launched.stderr || "environment_container_start_failed");
    containerId = launched.stdout.trim();

    while (true) {
      const beat = await environmentHeartbeat(context, containerId);
      const expired = new Date(context.environment.expiresAt).getTime() <= Date.now();
      const inspect = await runRaw(containerRuntime, ["inspect", "-f", "{{.State.Running}}", containerName], envRoot);
      if (beat.stopRequested || expired || inspect.code !== 0 || inspect.stdout.trim() !== "true") {
        await runRaw(containerRuntime, ["rm", "-f", containerName], envRoot).catch(() => undefined);
        await completeEnvironment(context, expired ? "expired" : beat.stopRequested ? "stopped" : "failed", inspect.code !== 0 ? "container_unavailable" : undefined);
        break;
      }
      await sleep(20_000);
    }
  } catch (error) {
    if (containerId) await runRaw(containerRuntime, ["rm", "-f", containerName], envRoot).catch(() => undefined);
    await completeEnvironment(context, "failed", error instanceof Error ? error.message.slice(0, 1000) : "environment_failed").catch(() => undefined);
  } finally {
    activeEnvironments.delete(context.environment.id);
    await rm(envRoot, { recursive: true, force: true }).catch(() => undefined);
    await heartbeat().catch(() => undefined);
  }
}

async function environmentWorker() {
  while (true) {
    try {
      const claimed = await claimEnvironment();
      if (!claimed.environment || !claimed.repository || !claimed.lease || !claimed.checkoutCredential) {
        await sleep(pollMs);
        continue;
      }
      await executeEnvironment(claimed as ClaimedEnvironment);
    } catch (error) {
      process.stderr.write("Development environment worker error: " + (error instanceof Error ? error.message : "unknown error") + "\n");
      await sleep(pollMs);
    }
  }
}

async function claimJob() {
  return requestJson<
    { job: ClaimedJob["job"] | null; reason?: string } & Partial<ClaimedJob>
  >(
    "/v1/kosh/automation/runner/claim",
    {
      method: "POST",
      body: JSON.stringify(runnerPayload())
    }
  );
}

async function worker(index: number) {
  while (true) {
    try {
      const claimed = await claimJob();

      if (
        !claimed.job ||
        !claimed.run ||
        !claimed.repository ||
        !claimed.lease ||
        !claimed.checkoutCredential ||
        !claimed.isolation
      ) {
        await sleep(pollMs + index * 100);
        continue;
      }

      await execute(claimed as ClaimedJob);
    } catch (error) {
      process.stderr.write(
        "Runner worker " +
          index +
          " error: " +
          (error instanceof Error ? error.message : "unknown error") +
          "\n"
      );
      await sleep(pollMs);
    }
  }
}

async function main() {
  if (executor === "container") {
    await probeCommand(containerRuntime, ["version"]);
  }

  process.stdout.write(
    "Kosh Runner " +
      runnerId +
      " connected to " +
      gateway +
      " using " +
      executor +
      " executor with concurrency " +
      concurrency +
      ".\n"
  );

  await heartbeat();

  await Promise.all([
    environmentWorker(),
    ...Array.from({ length: concurrency }, (_, index) => worker(index + 1))
  ]);
}

void main();
