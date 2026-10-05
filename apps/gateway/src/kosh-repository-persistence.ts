import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type postgres from "postgres";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");
const initialized = new WeakSet<object>();
const scheduled = new Map<string, ReturnType<typeof setTimeout>>();

type Sql = ReturnType<typeof postgres>;

type SnapshotRow = {
  namespace: string;
  slug: string;
  fingerprint: string;
  bundle: Buffer | Uint8Array | null;
  sha256: string | null;
  size_bytes: string | number;
  empty: boolean;
  updated_at: string | Date;
};

function validSegment(value: string, maxLength: number) {
  return value.length <= maxLength && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

function repositoryPath(namespace: string, slug: string) {
  if (!validSegment(namespace, 64) || !validSegment(slug, 100)) {
    throw new Error("invalid_repository_reference");
  }
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;
  if (!path.startsWith(prefix)) throw new Error("invalid_repository_path");
  return path;
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function maxSnapshotBytes() {
  const configured = Number(process.env.KOSH_REPO_SNAPSHOT_MAX_MB ?? 128);
  const mb = Number.isFinite(configured)
    ? Math.max(8, Math.min(1024, Math.floor(configured)))
    : 128;
  return mb * 1024 * 1024;
}

function persistenceEnabled() {
  return (process.env.KOSH_REPO_PERSISTENCE ?? "postgres").trim().toLowerCase() !== "off";
}

async function ready(sql: Sql) {
  if (initialized.has(sql as object)) return;
  await sql`
    CREATE TABLE IF NOT EXISTS kosh_repository_git_snapshots (
      namespace TEXT NOT NULL,
      slug TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      bundle BYTEA,
      sha256 TEXT,
      size_bytes BIGINT NOT NULL DEFAULT 0,
      empty BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(namespace, slug)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS kosh_repository_git_snapshots_updated_idx
    ON kosh_repository_git_snapshots(updated_at DESC)
  `;
  initialized.add(sql as object);
}

async function gitFingerprint(gitDir: string) {
  const [refsResult, headResult] = await Promise.all([
    execFileAsync(
      "git",
      [
        "--git-dir",
        gitDir,
        "for-each-ref",
        "--sort=refname",
        "--format=%(refname)%00%(objectname)",
        "refs/heads",
        "refs/tags"
      ],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }
    ),
    execFileAsync("git", ["--git-dir", gitDir, "symbolic-ref", "-q", "HEAD"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8"
    }).catch(() => ({ stdout: "" }))
  ]);
  const refs = String(refsResult.stdout).trim();
  const head = String(headResult.stdout).trim();
  return createHash("sha256").update(head).update("\n").update(refs).digest("hex");
}

async function refCount(gitDir: string) {
  const result = await execFileAsync(
    "git",
    ["--git-dir", gitDir, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"],
    { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }
  );
  return String(result.stdout).split(/\r?\n/).filter(Boolean).length;
}

function asBuffer(value: SnapshotRow["bundle"]) {
  if (!value) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function currentSnapshot(sql: Sql, namespace: string, slug: string) {
  const rows = await sql`
    SELECT namespace, slug, fingerprint, bundle, sha256, size_bytes, empty, updated_at
    FROM kosh_repository_git_snapshots
    WHERE namespace = ${namespace} AND slug = ${slug}
    LIMIT 1
  `;
  return (rows[0] as unknown as SnapshotRow | undefined) || null;
}

async function upsertEmptySnapshot(
  sql: Sql,
  namespace: string,
  slug: string,
  fingerprint: string
) {
  await sql`
    INSERT INTO kosh_repository_git_snapshots (
      namespace, slug, fingerprint, bundle, sha256, size_bytes, empty, updated_at
    ) VALUES (
      ${namespace}, ${slug}, ${fingerprint}, NULL, NULL, 0, TRUE, NOW()
    )
    ON CONFLICT(namespace, slug) DO UPDATE SET
      fingerprint = EXCLUDED.fingerprint,
      bundle = NULL,
      sha256 = NULL,
      size_bytes = 0,
      empty = TRUE,
      updated_at = NOW()
  `;
}

async function upsertBundleSnapshot(
  sql: Sql,
  namespace: string,
  slug: string,
  fingerprint: string,
  bundle: Buffer,
  sha256: string
) {
  await sql`
    INSERT INTO kosh_repository_git_snapshots (
      namespace, slug, fingerprint, bundle, sha256, size_bytes, empty, updated_at
    ) VALUES (
      ${namespace}, ${slug}, ${fingerprint}, ${bundle}, ${sha256}, ${bundle.length}, FALSE, NOW()
    )
    ON CONFLICT(namespace, slug) DO UPDATE SET
      fingerprint = EXCLUDED.fingerprint,
      bundle = EXCLUDED.bundle,
      sha256 = EXCLUDED.sha256,
      size_bytes = EXCLUDED.size_bytes,
      empty = FALSE,
      updated_at = NOW()
  `;
}

async function persistLocalRepository(sql: Sql, namespace: string, slug: string, gitDir: string) {
  const fingerprint = await gitFingerprint(gitDir);
  const existing = await currentSnapshot(sql, namespace, slug);
  if (existing?.fingerprint === fingerprint) return { state: "current" as const, fingerprint };

  if ((await refCount(gitDir)) === 0) {
    await upsertEmptySnapshot(sql, namespace, slug, fingerprint);
    return { state: "saved-empty" as const, fingerprint };
  }

  const tempPath = resolve(dirname(gitDir), `.${slug}.${randomUUID()}.bundle`);
  try {
    await execFileAsync("git", ["--git-dir", gitDir, "bundle", "create", tempPath, "--all"], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8"
    });
    const info = await stat(tempPath);
    if (info.size > maxSnapshotBytes()) {
      throw Object.assign(new Error("kosh_repository_snapshot_too_large"), {
        sizeBytes: info.size,
        maxBytes: maxSnapshotBytes()
      });
    }
    const bundle = await readFile(tempPath);
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    await upsertBundleSnapshot(sql, namespace, slug, fingerprint, bundle, sha256);
    return { state: "saved" as const, fingerprint, sizeBytes: bundle.length, sha256 };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function restoreSnapshot(sql: Sql, namespace: string, slug: string, gitDir: string) {
  const snapshot = await currentSnapshot(sql, namespace, slug);
  if (!snapshot) return { state: "missing" as const };

  await mkdir(dirname(gitDir), { recursive: true });
  await rm(gitDir, { recursive: true, force: true }).catch(() => undefined);

  if (snapshot.empty) {
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", gitDir], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8"
    });
    return { state: "restored-empty" as const, fingerprint: snapshot.fingerprint };
  }

  const bundle = asBuffer(snapshot.bundle);
  if (!bundle || !snapshot.sha256) throw new Error("kosh_repository_snapshot_corrupt");
  if (Number(snapshot.size_bytes) !== bundle.length) throw new Error("kosh_repository_snapshot_size_mismatch");
  const sha256 = createHash("sha256").update(bundle).digest("hex");
  if (sha256 !== snapshot.sha256) throw new Error("kosh_repository_snapshot_checksum_mismatch");

  const tempPath = resolve(dirname(gitDir), `.${slug}.${randomUUID()}.restore.bundle`);
  try {
    await writeFile(tempPath, bundle, { flag: "wx" });
    await execFileAsync("git", ["clone", "--bare", tempPath, gitDir], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8"
    });
    await execFileAsync("git", ["--git-dir", gitDir, "config", "http.receivepack", "true"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      encoding: "utf8"
    });
    const restoredFingerprint = await gitFingerprint(gitDir);
    if (restoredFingerprint !== snapshot.fingerprint) {
      throw new Error("kosh_repository_snapshot_fingerprint_mismatch");
    }
    return {
      state: "restored" as const,
      fingerprint: restoredFingerprint,
      sizeBytes: bundle.length,
      sha256
    };
  } catch (error) {
    await rm(gitDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export async function ensureKoshRepositoryPersistence(
  sql: Sql,
  namespace: string,
  slug: string
) {
  if (!persistenceEnabled()) return { state: "disabled" as const };
  await ready(sql);
  const gitDir = repositoryPath(namespace, slug);
  if (await pathExists(resolve(gitDir, "HEAD"))) {
    return persistLocalRepository(sql, namespace, slug, gitDir);
  }
  return restoreSnapshot(sql, namespace, slug, gitDir);
}

function scheduleOne(sql: Sql, namespace: string, slug: string, delayMs: number) {
  if (!persistenceEnabled()) return;
  const key = `${namespace}/${slug}:${delayMs}`;
  if (scheduled.has(key)) return;
  const timer = setTimeout(() => {
    scheduled.delete(key);
    void ensureKoshRepositoryPersistence(sql, namespace, slug).catch((error) => {
      console.error("Kosh repository persistence sync failed", {
        repository: `${namespace}/${slug}`,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, delayMs);
  timer.unref?.();
  scheduled.set(key, timer);
}

export function scheduleKoshRepositoryPersistence(sql: Sql, namespace: string, slug: string) {
  scheduleOne(sql, namespace, slug, 2_000);
  scheduleOne(sql, namespace, slug, 12_000);
  scheduleOne(sql, namespace, slug, 45_000);
}
