import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const publicOrigin = (process.env.KOSH_PUBLIC_ORIGIN || "https://tamishra.in/kosh").replace(/\/+$/, "");
const repository = process.env.KOSH_REPOSITORY || "tamishra/kavyn-2d";
const token = process.env.KOSH_GIT_TOKEN?.trim();

if (!token) {
  console.error("KOSH_GIT_TOKEN is required for the Git transport smoke test.");
  process.exit(2);
}

const slash = repository.indexOf("/");
if (slash <= 0) throw new Error("KOSH_REPOSITORY must be namespace/slug");
const namespace = repository.slice(0, slash);
const slug = repository.slice(slash + 1);
const gitUrl = `${publicOrigin}/git/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}.git`;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, ...options });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with code ${code}`));
    });
  });
}

const health = await fetch(`${publicOrigin}/health`, { cache: "no-store" });
if (!health.ok) throw new Error(`Kosh health failed: HTTP ${health.status}`);
console.log(`Health OK: ${publicOrigin}/health`);

const authHeader = `Authorization: Bearer ${token}`;
console.log(`Testing Git read: ${gitUrl}`);
await run("git", ["-c", `http.extraHeader=${authHeader}`, "ls-remote", gitUrl]);

const work = await mkdtemp(join(tmpdir(), "kosh-smoke-"));
try {
  await run("git", ["init", "-b", "main"], { cwd: work });
  await run("git", ["config", "user.name", "Kosh Smoke Test"], { cwd: work });
  await run("git", ["config", "user.email", "smoke@kosh.local"], { cwd: work });
  await run("git", ["commit", "--allow-empty", "-m", "Kosh transport smoke test"], { cwd: work });
  console.log("Testing Git write authorization with --dry-run (no remote refs will change)...");
  await run("git", [
    "-c",
    `http.extraHeader=${authHeader}`,
    "push",
    "--dry-run",
    gitUrl,
    "HEAD:refs/heads/__kosh_transport_smoke__"
  ], { cwd: work });
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log("Kosh online smoke test passed: health + Git read + Git write authorization.");
