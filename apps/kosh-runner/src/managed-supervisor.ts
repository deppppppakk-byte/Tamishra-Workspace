import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const runnerEntry = join(here, "index.js");
const minBackoffMs = Math.max(1000, Number(process.env.KOSH_RUNNER_RESTART_MIN_MS) || 2000);
const maxBackoffMs = Math.max(minBackoffMs, Number(process.env.KOSH_RUNNER_RESTART_MAX_MS) || 60_000);
const stableResetMs = Math.max(30_000, Number(process.env.KOSH_RUNNER_STABLE_RESET_MS) || 5 * 60_000);

let stopping = false;
let child: ChildProcess | null = null;
let backoffMs = minBackoffMs;
let startedAt = 0;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launch() {
  startedAt = Date.now();
  const next = spawn(process.execPath, [runnerEntry], {
    stdio: "inherit",
    env: {
      ...process.env,
      KOSH_RUNNER_MANAGED: "true"
    },
    windowsHide: true
  });
  child = next;
  return next;
}

async function supervise() {
  while (!stopping) {
    const current = launch();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      current.once("exit", (code, signal) => resolve({ code, signal }));
      current.once("error", () => resolve({ code: 1, signal: null }));
    });
    child = null;
    if (stopping) break;

    const livedMs = Date.now() - startedAt;
    if (livedMs >= stableResetMs) backoffMs = minBackoffMs;

    process.stderr.write(
      `Kosh managed runner exited (code=${String(exit.code)}, signal=${String(exit.signal)}). Restarting in ${backoffMs} ms.\n`
    );
    await sleep(backoffMs);
    backoffMs = Math.min(maxBackoffMs, Math.max(minBackoffMs, backoffMs * 2));
  }
}

function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`Kosh managed runner supervisor received ${signal}.\n`);
  if (child && !child.killed) child.kill(signal);
  setTimeout(() => {
    if (child && !child.killed) child.kill("SIGKILL");
  }, 10_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

void supervise().catch((error) => {
  process.stderr.write(`Kosh managed runner supervisor failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
