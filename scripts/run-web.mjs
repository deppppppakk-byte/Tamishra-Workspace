import { spawnSync } from "node:child_process";

const mode = process.argv[2];
const target = process.argv[3] ?? "hosted";

if (!["dev", "build"].includes(mode)) {
  console.error("Usage: node scripts/run-web.mjs <dev|build> <hosted|native>");
  process.exit(1);
}

if (!["hosted", "native"].includes(target)) {
  console.error("Target must be hosted or native.");
  process.exit(1);
}

const env = {
  ...process.env,
  WORKSPACE_BASE_PATH: target === "hosted" ? "/workspace" : "/",
  NEXT_PUBLIC_WORKSPACE_API_BASE:
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE ||
    (target === "hosted"
      ? "/api/workspace"
      : process.env.WORKSPACE_NATIVE_API_BASE ||
        "https://tamishra.in/api/workspace")
};

const npmExecPath = process.env.npm_execpath;
const args = ["run", mode, "--workspace", "@tamishra/web"];

const result = npmExecPath
  ? spawnSync(process.execPath, [npmExecPath, ...args], {
      stdio: "inherit",
      env
    })
  : spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      args,
      {
        stdio: "inherit",
        env,
        shell: process.platform === "win32"
      }
    );

if (result.error) {
  console.error("Unable to launch Workspace web build:", result.error);
}

process.exit(result.status ?? 1);
