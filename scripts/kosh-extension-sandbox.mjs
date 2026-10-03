import { spawn } from "node:child_process";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
let payload;
try {
  payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  console.error("invalid_extension_sandbox_input");
  process.exit(2);
}

const extension = payload?.extension ?? {};
const manifest = extension?.payload?.manifest ?? extension?.payload ?? {};
const image = String(
  extension?.payload?.sandboxImage ??
  process.env.KOSH_EXTENSION_SANDBOX_IMAGE ??
  ""
).trim();
if (!image || !/^[a-zA-Z0-9._/:@-]+$/.test(image)) {
  console.error("extension_sandbox_image_required");
  process.exit(2);
}
const entrypoint = String(manifest.entrypoint ?? "").trim();
if (!entrypoint || entrypoint.length > 240 || /[\r\n\0]/.test(entrypoint)) {
  console.error("extension_entrypoint_required");
  process.exit(2);
}

const memoryMb = Math.max(64, Math.min(2048, Number(process.env.KOSH_EXTENSION_MAX_MEMORY_MB ?? 256) || 256));
const cpus = Math.max(0.1, Math.min(4, Number(process.env.KOSH_EXTENSION_MAX_CPU ?? 1) || 1));
const pids = Math.max(32, Math.min(512, Number(process.env.KOSH_EXTENSION_MAX_PIDS ?? 128) || 128));
const allowNetwork = process.env.KOSH_EXTENSION_ALLOW_NETWORK === "true";

const args = [
  "run",
  "--rm",
  "--interactive",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  `--memory=${memoryMb}m`,
  `--cpus=${cpus}`,
  `--pids-limit=${pids}`,
  "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
  ...(allowNetwork ? [] : ["--network=none"]),
  image,
  entrypoint
];

const child = spawn(process.env.KOSH_DOCKER_BIN?.trim() || "docker", args, {
  stdio: ["pipe", "pipe", "inherit"],
  shell: false,
  env: {
    PATH: process.env.PATH ?? "",
    DOCKER_HOST: process.env.DOCKER_HOST ?? ""
  }
});
child.stdin.end(JSON.stringify({
  repositoryId: payload.repositoryId ?? null,
  input: payload.input ?? {},
  manifest: {
    id: manifest.id ?? null,
    version: manifest.version ?? null,
    capabilities: manifest.capabilities ?? [],
    permissions: manifest.permissions ?? [],
    assetKinds: manifest.assetKinds ?? []
  }
}));
child.stdout.pipe(process.stdout);
child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : "extension_sandbox_spawn_failed");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`extension_sandbox_signal:${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
