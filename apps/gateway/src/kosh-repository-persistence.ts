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
  generation: string | number;
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

function onlineAuthorityEnabled() {
  return (process.env.KOSH_REPO_AUTHORITY ?? "local").trim().toLowerCase() === "online";
}

function generationOf(snapshot: SnapshotRow | null) {
  if (!snapshot) return 0;
  const value = Number(snapshot.generation ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
      generation BIGINT NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(namespace, slug)
    )
  `;
  await sql`
    ALTER TABLE kosh_repository_git_snapshots
    ADD COLUMN IF NOT EXISTS generation BIGINT NOT NULL DEFAULT 1
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

async function localGeneration(gitDir: string) {
  try {
    const result = await execFileAsync(
      "git",
      ["--git-dir", gitDir, "config", "--get", "kosh.snapshotGeneration"],
      { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8" }
    );
    const value = Number(String(result.stdout).trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function setLocalGeneration(gitDir: string, generation: number) {
  await execFileAsync(
    "git",
    ["--git-dir", gitDir, "config", "kosh.snapshotGeneration", String(generation)],
    { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8" }
  );
}

function asBuffer(value: SnapshotRow["bundle"]) {
  if (!value) return null;
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

async function currentSnapshot(sql: Sql, namespace: string, slug: string) {
  const rows = await sql`
    SELECT namespace, slug, fingerprint, bundle, sha256, size_bytes, empty,
           generation, updated_at
    FROM kosh_repository_git_snapshots
    WHERE namespace = ${namespace} AND slug = ${slug}
    LIMIT 1
  `;
  return (rows[0] as unknown as SnapshotRow | undefined) || null;
}

async function insertEmptySnapshot(
  sql: Sql,
  namespace: string,
  slug: string,
  fingerprint: string
) {
  const rows = await sql`
    INSERT INTO kosh_repository_git_snapshots (
      namespace, slug, fingerprint, bundle, sha256, size_bytes, empty, generation, updated_at
    ) VALUES (
      ${namespace}, ${slug}, ${fingerprint}, NULL, NULL, 0, TRUE, 1, NOW()
    )
    ON CONFLICT(namespace, slug) DO NOTHING
    RETURNING generation
  `;
  return rows[0] ? Number((rows[0] as { generation: unknown }).generation) : null;
}

async function updateEmptySnapshot(
  sql: Sql,
  namespace: string,
  slug: string,
  fingerprint: string,
  expectedGeneration: number
) {
  const rows = await sql`
    UPDATE kosh_repository_git_snapshots
    SET fingerprint = ${fingerprint},
        bundle = NULL,
        sha256 = NULL,
        size_bytes = 0,
        empty = TRUE,
        generation = generation + 1,
        updated_at = NOW()
    WHERE namespace = ${namespace}
      AND slug = ${slug}
      AND generation = ${expectedGeneration}
    RETURNING generation
  `;
  return rows[0] ? Number((rows[0] as { generation: unknown }).generation) : null;
}

async function insertBundleSnapshot(
  sql: Sql,
  namespace: string,
  slug: string,
  fingerprint: string,
  bundle: Buffer,
  sha256: string
) {
  const rows = await sql`
    INSERT INTO kosh_repository_git_snapshots (
      namespace, slug, fingerprint, bundle, sha256, size_bytes, empty, generation, updated_at
    ) VALUES (
      ${namespace}, ${slug}, ${fingerprint}, ${bundle}, ${sha256}, ${bundle.length}, FALSE, 1, NOW()
    )
    ON CONFLICT(namespace, slug) DO NOTHING
    RETURNING generation
  `;
  return rows[0] ? Number((rows[0] as { generation: unknown }).generation) : null;
}

async function updateBundleSnapshot(
  sql: Sql,
  namespace: string,
  slug: string,
  fingerprint: string,
  bundle: Buffer,
  sha256: string,
  expectedGeneration: number
) {
  const rows = await sql`
    UPDATE kosh_repository_git_snapshots
    SET fingerprint = ${fingerprint},
        bundle = ${bundle},
        sha256 = ${sha256},
        size_bytes = ${bundle.length},
        empty = FALSE,
        generation = generation + 1,
        updated_at = NOW()
    WHERE namespace = ${namespace}
      AND slug = ${slug}
      AND generation = ${expectedGeneration}
    RETURNING generation
  `;
  return rows[0] ? Number((rows[0] as { generation: unknown }).generation) : null;
}

function snapshotConflict(namespace: string, slug: string) {
  return Object.assign(new Error("kosh_repository_snapshot_conflict"), {
    repository: `${namespace}/${slug}`,
    retryable: true
  });
}

async function persistLocalRepository(
  sql: Sql,
  namespace: string,
  slug: string,
  gitDir: string,
  knownSnapshot?: SnapshotRow | null
) {
  const fingerprint = await gitFingerprint(gitDir);
  const existing = knownSnapshot === undefined
    ? await currentSnapshot(sql, namespace, slug)
    : knownSnapshot;
  const existingGeneration = generationOf(existing);
  const cacheGeneration = await localGeneration(gitDir);

  if (existing?.fingerprint === fingerprint) {
    await setLocalGeneration(gitDir, existingGeneration);
    return {
      state: "current" as const,
      fingerprint,
      generation: existingGeneration
    };
  }

  if (onlineAuthorityEnabled() && existing && cacheGeneration !== existingGeneration) {
    throw snapshotConflict(namespace, slug);
  }

  const expectedGeneration = existing ? existingGeneration : 0;
  let nextGeneration: number | null = null;

  if ((await refCount(gitDir)) === 0) {
    nextGeneration = expectedGeneration === 0
      ? await insertEmptySnapshot(sql, namespace, slug, fingerprint)
      : await updateEmptySnapshot(sql, namespace, slug, fingerprint, expectedGeneration);
    if (nextGeneration === null) throw snapshotConflict(namespace, slug);
    await setLocalGeneration(gitDir, nextGeneration);
    return {
      state: "saved-empty" as const,
      fingerprint,
      generation: nextGeneration
    };
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
    nextGeneration = expectedGeneration === 0
      ? await insertBundleSnapshot(sql, namespace, slug, fingerprint, bundle, sha256)
      : await updateBundleSnapshot(
          sql,
          namespace,
          slug,
          fingerprint,
          bundle,
          sha256,
          expectedGeneration
        );
    if (nextGeneration === null) throw snapshotConflict(namespace, slug);
    await setLocalGeneration(gitDir, nextGeneration);
    return {
      state: "saved" as const,
      fingerprint,
      sizeBytes: bundle.length,
      sha256,
      generation: nextGeneration
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function restoreSnapshot(
  sql: Sql,
  namespace: string,
  slug: string,
  gitDir: string,
  knownSnapshot?: SnapshotRow | null
) {
  const snapshot = knownSnapshot === undefined
    ? await currentSnapshot(sql, namespace, slug)
    : knownSnapshot;
  if (!snapshot) return { state: "missing" as const };

  await mkdir(dirname(gitDir), { recursive: true });
  await rm(gitDir, { recursive: true, force: true }).catch(() => undefined);

  if (snapshot.empty) {
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", gitDir], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8"
    });
    await setLocalGeneration(gitDir, generationOf(snapshot));
    return {
      state: "restored-empty" as const,
      fingerprint: snapshot.fingerprint,
      generation: generationOf(snapshot)
    };
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
    await setLocalGeneration(gitDir, generationOf(snapshot));
    return {
      state: "restored" as const,
      fingerprint: restoredFingerprint,
      sizeBytes: bundle.length,
      sha256,
      generation: generationOf(snapshot)
    };
  } catch (error) {
    await rm(gitDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function ensureOnlineAuthoritativeRepository(
  sql: Sql,
  namespace: string,
  slug: string,
  gitDir: string
) {
  const snapshot = await currentSnapshot(sql, namespace, slug);
  const localExists = await pathExists(resolve(gitDir, "HEAD"));

  if (!snapshot) {
    if (!localExists) return { state: "missing" as const };
    return persistLocalRepository(sql, namespace, slug, gitDir, null);
  }

  if (!localExists) {
    return restoreSnapshot(sql, namespace, slug, gitDir, snapshot);
  }

  const [cacheGeneration, fingerprint] = await Promise.all([
    localGeneration(gitDir),
    gitFingerprint(gitDir)
  ]);
  const snapshotGeneration = generationOf(snapshot);

  if (fingerprint === snapshot.fingerprint) {
    if (cacheGeneration !== snapshotGeneration) {
      await setLocalGeneration(gitDir, snapshotGeneration);
    }
    return {
      state: "current" as const,
      fingerprint,
      generation: snapshotGeneration
    };
  }

  if (cacheGeneration === snapshotGeneration) {
    return persistLocalRepository(sql, namespace, slug, gitDir, snapshot);
  }

  // A different online instance has already advanced the repository generation.
  // Never let an older local cache overwrite that newer durable state.
  return restoreSnapshot(sql, namespace, slug, gitDir, snapshot);
}

export async function ensureKoshRepositoryPersistence(
  sql: Sql,
  namespace: string,
  slug: string
) {
  if (!persistenceEnabled()) return { state: "disabled" as const };
  await ready(sql);
  const gitDir = repositoryPath(namespace, slug);

  if (onlineAuthorityEnabled()) {
    return ensureOnlineAuthoritativeRepository(sql, namespace, slug, gitDir);
  }

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
  if (onlineAuthorityEnabled()) {
    // Online-primary nodes use local Git only as a short-lived cache. Sync quickly
    // after receive-pack/Browser IDE mutations, then retry to absorb short races.
    scheduleOne(sql, namespace, slug, 250);
    scheduleOne(sql, namespace, slug, 1_500);
    scheduleOne(sql, namespace, slug, 5_000);
    scheduleOne(sql, namespace, slug, 15_000);
    return;
  }

  scheduleOne(sql, namespace, slug, 2_000);
  scheduleOne(sql, namespace, slug, 12_000);
  scheduleOne(sql, namespace, slug, 45_000);
}
