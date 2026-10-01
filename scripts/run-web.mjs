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
  WORKSPACE_BASE_PATH: target === "hosted" ? "/workspace" : "/"
};

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmCommand,
  ["run", mode, "--workspace", "@tamishra/web"],
  { stdio: "inherit", env }
);

process.exit(result.status ?? 1);
