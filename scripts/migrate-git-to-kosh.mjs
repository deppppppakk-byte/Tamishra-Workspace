import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const source = process.env.SOURCE_GIT_URL?.trim();
const target = process.env.KOSH_TARGET_URL?.trim();
const koshToken = process.env.KOSH_GIT_TOKEN?.trim();
const sourceToken = process.env.SOURCE_GIT_TOKEN?.trim();

if (!source || !target || !koshToken) {
  console.error("Required: SOURCE_GIT_URL, KOSH_TARGET_URL, KOSH_GIT_TOKEN");
  process.exit(2);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      ...options
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with code ${code}`));
    });
  });
}

function bearerHeader(token) {
  return `Authorization: Bearer ${token}`;
}

const work = await mkdtemp(join(tmpdir(), "kosh-migrate-"));
const mirror = join(work, "repository.git");

try {
  const cloneArgs = [];
  if (sourceToken) cloneArgs.push("-c", `http.extraHeader=${bearerHeader(sourceToken)}`);
  cloneArgs.push("clone", "--mirror", source, mirror);
  console.log("Cloning source repository as a mirror...");
  await run("git", cloneArgs);

  console.log("Verifying source repository...");
  await run("git", ["--git-dir", mirror, "fsck", "--no-progress", "--connectivity-only"]);

  console.log("Pushing all refs to Kosh...");
  await run("git", [
    "-c",
    `http.extraHeader=${bearerHeader(koshToken)}`,
    "--git-dir",
    mirror,
    "push",
    "--mirror",
    target
  ]);

  console.log("Migration complete.");
  console.log(`Kosh target: ${target}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
