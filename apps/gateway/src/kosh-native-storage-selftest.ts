import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { bootstrapConfiguredKoshRepositories } from "./kosh-bootstrap.js";
import { ensureKoshRepositoryPersistence } from "./kosh-repository-persistence.js";

const execFileAsync = promisify(execFile);

function enabled() {
  const value = (process.env.KOSH_STARTUP_SELFTEST ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "strict";
}

export async function runKoshNativeStorageSelfTest() {
  if (!enabled()) {
    const bootstrap = await bootstrapConfiguredKoshRepositories();
    return { enabled: false, ok: true, detail: "disabled", bootstrap } as const;
  }

  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("kosh_selftest_database_not_configured");

  const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");
  const suffix = randomUUID().replace(/-/g, "").slice(0, 16);
  const namespace = "kosh_health";
  const slug = `probe_${suffix}`;
  const gitDir = resolve(repositoryRoot, namespace, slug + ".git");
  const workDir = resolve(repositoryRoot, ".selftest", slug);
  const sql = postgres(databaseUrl, { max: 1, prepare: false });

  let expectedSha = "";
  let restoredSha = "";

  try {
    await mkdir(dirname(gitDir), { recursive: true });
    await mkdir(dirname(workDir), { recursive: true });

    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", gitDir], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });

    await execFileAsync("git", ["init", "--initial-branch=main", workDir], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });

    await writeFile(
      resolve(workDir, "KOSH_STORAGE_PROBE.txt"),
      `Kosh native storage self-test ${suffix}\n`,
      "utf8"
    );

    await execFileAsync("git", ["-C", workDir, "add", "KOSH_STORAGE_PROBE.txt"], {
      timeout: 10_000,
      encoding: "utf8"
    });
    await execFileAsync(
      "git",
      [
        "-C",
        workDir,
        "-c",
        "user.name=Kosh Storage Probe",
        "-c",
        "user.email=kosh-storage-probe@localhost",
        "commit",
        "-m",
        "Kosh native storage persistence probe"
      ],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }
    );

    expectedSha = String(
      (
        await execFileAsync("git", ["-C", workDir, "rev-parse", "HEAD"], {
          timeout: 10_000,
          encoding: "utf8"
        })
      ).stdout
    ).trim();

    await execFileAsync("git", ["-C", workDir, "remote", "add", "origin", gitDir], {
      timeout: 10_000,
      encoding: "utf8"
    });
    await execFileAsync("git", ["-C", workDir, "push", "origin", "main"], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });

    const saved = await ensureKoshRepositoryPersistence(sql, namespace, slug);
    if (saved.state !== "saved" && saved.state !== "current") {
      throw new Error(`kosh_selftest_snapshot_not_saved:${saved.state}`);
    }

    await rm(gitDir, { recursive: true, force: true });

    const restored = await ensureKoshRepositoryPersistence(sql, namespace, slug);
    if (restored.state !== "restored") {
      throw new Error(`kosh_selftest_snapshot_not_restored:${restored.state}`);
    }

    restoredSha = String(
      (
        await execFileAsync(
          "git",
          ["--git-dir", gitDir, "rev-parse", "refs/heads/main"],
          { timeout: 10_000, encoding: "utf8" }
        )
      ).stdout
    ).trim();

    if (!expectedSha || restoredSha !== expectedSha) {
      throw new Error("kosh_selftest_restored_sha_mismatch");
    }

    const rows = await sql`
      SELECT fingerprint, sha256, size_bytes, empty
      FROM kosh_repository_git_snapshots
      WHERE namespace = ${namespace} AND slug = ${slug}
      LIMIT 1
    `;
    if (!rows[0] || rows[0].empty === true || Number(rows[0].size_bytes) <= 0) {
      throw new Error("kosh_selftest_snapshot_evidence_missing");
    }

    const bootstrap = await bootstrapConfiguredKoshRepositories();
    return {
      enabled: true,
      ok: true,
      detail: "native_git_postgres_restore_verified",
      commit: restoredSha.slice(0, 12),
      snapshotBytes: Number(rows[0].size_bytes),
      bootstrap
    } as const;
  } finally {
    await sql`
      DELETE FROM kosh_repository_git_snapshots
      WHERE namespace = ${namespace} AND slug = ${slug}
    `.catch(() => undefined);
    await sql.end({ timeout: 5 }).catch(() => undefined);
    await rm(gitDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
