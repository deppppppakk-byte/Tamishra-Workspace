import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  deleteKoshObject,
  materializeKoshObject,
  putKoshObjectFromFile,
  type KoshObjectLocator
} from "./kosh-object-storage.js";
import { getKoshMaintenanceStore, type StoredKoshMaintenanceJob } from "./kosh-maintenance-store.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";
import { getKoshPlatformStore, type StoredKoshPlatformResource } from "./kosh-platform-store.js";
import { reconcileKoshStorage } from "./kosh-storage-reconciliation.js";
import type { KoshStorageClass } from "./kosh-storage-policy.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const objectIndex = getKoshObjectIndex();
const maintenanceStore = getKoshMaintenanceStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");
const maintenanceRoot = resolve(
  process.env.KOSH_MAINTENANCE_ROOT?.trim() || ".kosh/maintenance"
);
const replicaRoot = resolve(process.env.KOSH_REPLICA_ROOT?.trim() || ".kosh/replica");

type Actor = { id: string; displayName: string };
type ProductionPolicy = {
  enabled: boolean;
  reconciliationHours: number;
  migrationEnabled: boolean;
  migrationBatchSize: number;
  garbageCollectionEnabled: boolean;
  garbageCollectionGraceDays: number;
  recoveryDrillDays: number;
  replicationEnabled: boolean;
  replicationVerifyHours: number;
};

const systemActor: Actor = {
  id: "kosh-maintenance",
  displayName: "Kosh Maintenance"
};

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.floor(number)))
    : fallback;
}

function safePath(root: string, ...parts: string[]) {
  const path = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (path !== root && !path.startsWith(prefix)) {
    throw Object.assign(new Error("maintenance_path_invalid"), { status: 400 });
  }
  return path;
}

function repositoryPath(repository: StoredKoshRepository) {
  return safePath(repositoryRoot, repository.namespace, repository.slug + ".git");
}

async function hashFile(path: string) {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function audit(
  repositoryId: string | null,
  eventType: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {}
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: systemActor.id,
    actorName: systemActor.displayName,
    eventType,
    resourceType,
    resourceId,
    metadata
  });
}

async function upsertEvidence(input: {
  repository: StoredKoshRepository;
  key: string;
  name: string;
  payload: Record<string, unknown>;
}) {
  const resources = await platformStore.listResources("storage_policy", input.repository.id);
  const existing = resources.find((item) => item.key === input.key);
  if (existing) {
    return platformStore.updateResource(existing.id, {
      state: "active",
      payload: input.payload
    });
  }
  return platformStore.createResource({
    repositoryId: input.repository.id,
    namespace: input.repository.namespace,
    type: "storage_policy",
    key: input.key,
    name: input.name,
    state: "active",
    payload: input.payload,
    createdByUserId: systemActor.id,
    createdByName: systemActor.displayName
  });
}

async function repositoryById(id: string | null) {
  if (!id) return null;
  const repositories = await repositoryStore.list();
  return repositories.find((item) => item.id === id) ?? null;
}

function defaultPolicy(): ProductionPolicy {
  return {
    enabled: true,
    reconciliationHours: 6,
    migrationEnabled: false,
    migrationBatchSize: 25,
    garbageCollectionEnabled: false,
    garbageCollectionGraceDays: 30,
    recoveryDrillDays: 7,
    replicationEnabled: Boolean(process.env.KOSH_REPLICA_ROOT?.trim()),
    replicationVerifyHours: 12
  };
}

export async function getKoshProductionPolicy(repositoryId: string): Promise<ProductionPolicy> {
  await platformStore.ready();
  const resources = await platformStore.listResources("storage_policy", repositoryId);
  const configured = resources.find((item) => item.key === "production:lifecycle");
  const payload = configured?.payload ?? {};
  const defaults = defaultPolicy();
  return {
    enabled: payload.enabled !== false,
    reconciliationHours: boundedNumber(payload.reconciliationHours, defaults.reconciliationHours, 1, 168),
    migrationEnabled: payload.migrationEnabled === true,
    migrationBatchSize: boundedNumber(payload.migrationBatchSize, defaults.migrationBatchSize, 1, 500),
    garbageCollectionEnabled: payload.garbageCollectionEnabled === true,
    garbageCollectionGraceDays: boundedNumber(payload.garbageCollectionGraceDays, defaults.garbageCollectionGraceDays, 7, 3650),
    recoveryDrillDays: boundedNumber(payload.recoveryDrillDays, defaults.recoveryDrillDays, 1, 90),
    replicationEnabled: payload.replicationEnabled === true || defaults.replicationEnabled,
    replicationVerifyHours: boundedNumber(payload.replicationVerifyHours, defaults.replicationVerifyHours, 1, 168)
  };
}

export async function putKoshProductionPolicy(
  repository: StoredKoshRepository,
  actor: Actor,
  input: Record<string, unknown>
) {
  await platformStore.ready();
  const current = await getKoshProductionPolicy(repository.id);
  const next: ProductionPolicy = {
    enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
    reconciliationHours: boundedNumber(input.reconciliationHours, current.reconciliationHours, 1, 168),
    migrationEnabled: input.migrationEnabled === undefined ? current.migrationEnabled : input.migrationEnabled === true,
    migrationBatchSize: boundedNumber(input.migrationBatchSize, current.migrationBatchSize, 1, 500),
    garbageCollectionEnabled: input.garbageCollectionEnabled === undefined
      ? current.garbageCollectionEnabled
      : input.garbageCollectionEnabled === true,
    garbageCollectionGraceDays: boundedNumber(
      input.garbageCollectionGraceDays,
      current.garbageCollectionGraceDays,
      7,
      3650
    ),
    recoveryDrillDays: boundedNumber(input.recoveryDrillDays, current.recoveryDrillDays, 1, 90),
    replicationEnabled: input.replicationEnabled === undefined
      ? current.replicationEnabled
      : input.replicationEnabled === true,
    replicationVerifyHours: boundedNumber(
      input.replicationVerifyHours,
      current.replicationVerifyHours,
      1,
      168
    )
  };
  if (next.garbageCollectionEnabled && !input.confirmGarbageCollection) {
    throw Object.assign(new Error("garbage_collection_confirmation_required"), { status: 400 });
  }
  const policies = await platformStore.listResources("storage_policy", repository.id);
  const existing = policies.find((item) => item.key === "production:lifecycle");
  const resource = existing
    ? await platformStore.updateResource(existing.id, { state: "active", payload: next })
    : await platformStore.createResource({
        repositoryId: repository.id,
        namespace: repository.namespace,
        type: "storage_policy",
        key: "production:lifecycle",
        name: "Production lifecycle policy",
        state: "active",
        payload: next,
        createdByUserId: actor.id,
        createdByName: actor.displayName
      });
  await platformStore.appendAudit({
    repositoryId: repository.id,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType: "production_lifecycle_policy_updated",
    resourceType: "storage_policy",
    resourceId: resource?.id ?? existing?.id ?? null,
    metadata: next
  });
  return next;
}

function hoursAgo(value: string | null | undefined) {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? (Date.now() - time) / 3_600_000 : Number.POSITIVE_INFINITY;
}

function daysAgo(value: string | null | undefined) {
  return hoursAgo(value) / 24;
}

function latestJobTime(jobs: StoredKoshMaintenanceJob[], kind: StoredKoshMaintenanceJob["kind"]) {
  return jobs
    .filter((item) => item.kind === kind && ["queued", "running", "succeeded"].includes(item.status))
    .map((item) => item.completedAt || item.startedAt || item.createdAt)
    .sort()
    .at(-1) ?? null;
}

export async function scheduleKoshProductionMaintenance() {
  await Promise.all([platformStore.ready(), maintenanceStore.ready()]);
  const repositories = await repositoryStore.list();
  const queued: StoredKoshMaintenanceJob[] = [];
  for (const repository of repositories) {
    const policy = await getKoshProductionPolicy(repository.id);
    if (!policy.enabled) continue;
    const jobs = await maintenanceStore.list(repository.id, 300);

    if (hoursAgo(latestJobTime(jobs, "storage_reconcile")) >= policy.reconciliationHours) {
      queued.push(await maintenanceStore.enqueue({
        repositoryId: repository.id,
        kind: "storage_reconcile",
        priority: 40,
        dedupeKey: `storage-reconcile:${repository.id}`,
        payload: { scheduled: true }
      }));
    }
    if (
      policy.migrationEnabled &&
      hoursAgo(latestJobTime(jobs, "storage_migrate")) >= policy.reconciliationHours
    ) {
      queued.push(await maintenanceStore.enqueue({
        repositoryId: repository.id,
        kind: "storage_migrate",
        priority: 20,
        dedupeKey: `storage-migrate:${repository.id}`,
        payload: { limit: policy.migrationBatchSize, deleteLocalAfterVerified: false }
      }));
    }
    if (
      policy.garbageCollectionEnabled &&
      hoursAgo(latestJobTime(jobs, "storage_gc")) >= 24
    ) {
      queued.push(await maintenanceStore.enqueue({
        repositoryId: repository.id,
        kind: "storage_gc",
        priority: 5,
        dedupeKey: `storage-gc:${repository.id}`,
        payload: { graceDays: policy.garbageCollectionGraceDays }
      }));
    }
    if (daysAgo(latestJobTime(jobs, "recovery_drill")) >= policy.recoveryDrillDays) {
      queued.push(await maintenanceStore.enqueue({
        repositoryId: repository.id,
        kind: "recovery_drill",
        priority: 30,
        dedupeKey: `recovery-drill:${repository.id}`,
        payload: { scheduled: true }
      }));
    }
    if (
      policy.replicationEnabled &&
      hoursAgo(latestJobTime(jobs, "replication_verify")) >= policy.replicationVerifyHours
    ) {
      queued.push(await maintenanceStore.enqueue({
        repositoryId: repository.id,
        kind: "replication_verify",
        priority: 10,
        dedupeKey: `replication-verify:${repository.id}`,
        payload: { repair: true }
      }));
    }
  }

  const globalJobs = await maintenanceStore.list(null, 100);
  const databaseBackupHours = boundedNumber(process.env.KOSH_DATABASE_BACKUP_HOURS, 24, 1, 168);
  if (
    process.env.KOSH_DATABASE_BACKUP_ENABLED === "true" &&
    hoursAgo(latestJobTime(globalJobs, "database_backup")) >= databaseBackupHours
  ) {
    queued.push(await maintenanceStore.enqueue({
      repositoryId: null,
      kind: "database_backup",
      priority: 50,
      dedupeKey: "database-backup:platform",
      payload: { scheduled: true }
    }));
  }

  return { checkedAt: new Date().toISOString(), repositories: repositories.length, queued };
}

async function verifyMaterialized(
  locator: KoshObjectLocator,
  fallbackPath: string,
  expectedSize: number,
  expectedSha256: string,
  purpose: string
) {
  const path = safePath(maintenanceRoot, purpose, randomUUID() + ".verify");
  await mkdir(dirname(path), { recursive: true });
  try {
    await materializeKoshObject(locator, fallbackPath, path);
    const info = await stat(path);
    const checksum = await hashFile(path);
    if (info.size !== expectedSize || checksum !== expectedSha256) {
      throw Object.assign(new Error("maintenance_object_integrity_failure"), { status: 409 });
    }
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

async function runStorageReconciliation(repository: StoredKoshRepository) {
  const report = await reconcileKoshStorage(repository);
  await upsertEvidence({
    repository,
    key: "reconciliation:evidence",
    name: "Storage reconciliation evidence",
    payload: {
      kind: "reconciliation_evidence",
      backend: report.backend,
      checkedAt: report.checkedAt,
      operation: "scheduled_reconciliation",
      summary: report.summary,
      driveErrors: report.driveErrors
    }
  });
  await audit(repository.id, "storage_reconciliation_scheduled", "storage_policy", null, report.summary);
  return report.summary;
}

async function runStorageMigration(repository: StoredKoshRepository, job: StoredKoshMaintenanceJob) {
  const report = await reconcileKoshStorage(repository);
  const limit = boundedNumber(job.payload.limit, 25, 1, 500);
  const candidates = report.items
    .filter((item) => ["local_only", "local_indexed", "recoverable_remote"].includes(item.state))
    .slice(0, limit);
  const migrated: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];

  for (const item of candidates) {
    let locator: KoshObjectLocator | null = null;
    let uploaded = false;
    try {
      if (
        item.remote &&
        item.remote.logicalId === item.logicalId &&
        item.remote.sizeBytes === item.sizeBytes &&
        item.remote.sha256 === item.sha256
      ) {
        locator = {
          backend: "google-drive",
          objectId: item.remote.id,
          storageClass: item.storageClass,
          sizeBytes: item.sizeBytes,
          sha256: item.sha256
        };
        await verifyMaterialized(locator, "", item.sizeBytes, item.sha256, "migration");
      } else {
        if (!item.localPath) throw new Error("local_storage_source_missing");
        const info = await stat(item.localPath).catch(() => null);
        if (!info || info.size !== item.sizeBytes || await hashFile(item.localPath) !== item.sha256) {
          throw new Error("local_storage_source_integrity_failure");
        }
        locator = await putKoshObjectFromFile({
          storageClass: item.storageClass,
          repositoryId: repository.id,
          logicalId: item.logicalId,
          filename: item.filename,
          mediaType: item.mediaType,
          sourcePath: item.localPath,
          sizeBytes: item.sizeBytes,
          sha256: item.sha256,
          localPath: item.localPath
        });
        uploaded = locator.backend === "google-drive";
        if (locator.backend !== "google-drive") throw new Error("google_drive_backend_required_for_migration");
        await verifyMaterialized(locator, "", item.sizeBytes, item.sha256, "migration");
      }
      await objectIndex.put({
        repositoryId: repository.id,
        storageClass: item.storageClass,
        logicalId: item.logicalId,
        locator
      });
      migrated.push({ storageClass: item.storageClass, logicalId: item.logicalId, uploaded });
    } catch (error) {
      if (uploaded && locator) await deleteKoshObject(locator, "").catch(() => undefined);
      failures.push({
        storageClass: item.storageClass,
        logicalId: item.logicalId,
        error: error instanceof Error ? error.message : "migration_failed"
      });
    }
  }

  const after = await reconcileKoshStorage(repository);
  await upsertEvidence({
    repository,
    key: "reconciliation:evidence",
    name: "Storage reconciliation evidence",
    payload: {
      kind: "reconciliation_evidence",
      backend: after.backend,
      checkedAt: after.checkedAt,
      operation: "scheduled_migration",
      summary: after.summary,
      driveErrors: after.driveErrors
    }
  });
  await audit(repository.id, "storage_migration_batch_completed", "storage_policy", null, {
    migrated: migrated.length,
    failures: failures.length
  });
  return { migrated, failures, summary: after.summary };
}

async function runStorageGarbageCollection(repository: StoredKoshRepository, job: StoredKoshMaintenanceJob) {
  const report = await reconcileKoshStorage(repository);
  const graceDays = boundedNumber(job.payload.graceDays, 30, 7, 3650);
  const cutoff = Date.now() - graceDays * 24 * 60 * 60 * 1000;
  const referencedRemoteIds = new Set(
    report.items.map((item) => item.remote?.id).filter((value): value is string => Boolean(value))
  );
  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const remote of report.orphanRemote) {
    if (referencedRemoteIds.has(remote.id)) {
      skipped.push(remote.id);
      continue;
    }
    const modified = remote.modifiedAt ? new Date(remote.modifiedAt).getTime() : Date.now();
    if (!Number.isFinite(modified) || modified > cutoff) {
      skipped.push(remote.id);
      continue;
    }
    await deleteKoshObject({
      backend: "google-drive",
      objectId: remote.id,
      storageClass: remote.storageClass,
      sizeBytes: remote.sizeBytes,
      sha256: remote.sha256
    }, "");
    deleted.push(remote.id);
  }
  for (const stale of report.staleIndex) {
    await objectIndex.delete(repository.id, stale.storageClass, stale.logicalId);
  }
  const after = await reconcileKoshStorage(repository);
  await audit(repository.id, "storage_gc_completed", "storage_policy", null, {
    graceDays,
    deleted: deleted.length,
    skipped: skipped.length,
    staleIndexesDeleted: report.staleIndex.length
  });
  return { deleted, skipped, staleIndexesDeleted: report.staleIndex.length, summary: after.summary };
}

async function resolveBackupLocator(repository: StoredKoshRepository, backup: StoredKoshPlatformResource) {
  const logicalId = clean(backup.payload.storageLogicalId, 240) || backup.id;
  const indexed = await objectIndex.get(repository.id, "backup", logicalId);
  const filename = clean(backup.payload.filename, 240);
  const fallback = filename
    ? safePath(resolve(process.env.KOSH_BACKUP_ROOT?.trim() || ".kosh/backups"), repository.id, filename)
    : "";
  return { logicalId, locator: indexed?.locator ?? null, fallback };
}

async function runRecoveryDrill(repository: StoredKoshRepository) {
  const backups = (await platformStore.listResources("backup", repository.id))
    .filter((item) => item.payload.kind === "git-bundle" || !item.payload.kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const backup = backups[0];
  if (!backup) throw Object.assign(new Error("recovery_drill_backup_required"), { status: 409 });
  const expectedSha = clean(backup.payload.sha256, 128);
  const expectedSize = Number(backup.payload.sizeBytes) || 0;
  const resolved = await resolveBackupLocator(repository, backup);
  const bundlePath = safePath(maintenanceRoot, "recovery-drills", repository.id, randomUUID() + ".bundle");
  const clonePath = safePath(maintenanceRoot, "recovery-drills", repository.id, randomUUID() + ".git");
  await mkdir(dirname(bundlePath), { recursive: true });
  try {
    await materializeKoshObject(resolved.locator, resolved.fallback, bundlePath);
    const info = await stat(bundlePath);
    const checksum = await hashFile(bundlePath);
    if (info.size !== expectedSize || checksum !== expectedSha) {
      throw new Error("recovery_drill_integrity_failure");
    }
    await execFileAsync("git", ["--git-dir", repositoryPath(repository), "bundle", "verify", bundlePath], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });
    await execFileAsync("git", ["clone", "--bare", bundlePath, clonePath], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });
    await execFileAsync("git", ["--git-dir", clonePath, "fsck", "--full"], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    });
    await platformStore.updateResource(backup.id, {
      payload: {
        ...backup.payload,
        lastDrillAt: new Date().toISOString(),
        drillValid: true
      }
    });
    await audit(repository.id, "recovery_drill_succeeded", "backup", backup.id, {
      storageBackend: resolved.locator?.backend ?? "local",
      sizeBytes: info.size,
      sha256: checksum
    });
    return { valid: true, backupId: backup.id, sizeBytes: info.size, sha256: checksum };
  } catch (error) {
    await platformStore.updateResource(backup.id, {
      payload: {
        ...backup.payload,
        lastDrillAt: new Date().toISOString(),
        drillValid: false,
        drillError: error instanceof Error ? error.message.slice(0, 1000) : "recovery_drill_failed"
      }
    }).catch(() => null);
    await audit(repository.id, "recovery_drill_failed", "backup", backup.id, {
      error: error instanceof Error ? error.message : "recovery_drill_failed"
    }).catch(() => undefined);
    throw error;
  } finally {
    await rm(bundlePath, { force: true }).catch(() => undefined);
    await rm(clonePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

function connectionEnv(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("database_backup_url_invalid");
  }
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGSSLMODE: url.searchParams.get("sslmode") || undefined
  };
}

async function runDatabaseBackup() {
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!databaseUrl) throw Object.assign(new Error("workspace_database_required"), { status: 503 });
  if (process.env.KOSH_DATABASE_BACKUP_ENABLED !== "true") {
    throw Object.assign(new Error("database_backup_disabled"), { status: 409 });
  }
  const logicalId = "postgres-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const filename = logicalId + ".dump";
  const path = safePath(maintenanceRoot, "database-backups", filename);
  await mkdir(dirname(path), { recursive: true });
  const env = connectionEnv(databaseUrl);
  try {
    await execFileAsync("pg_dump", [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--file",
      path
    ], {
      timeout: boundedNumber(process.env.KOSH_DATABASE_BACKUP_TIMEOUT_MS, 900_000, 60_000, 3_600_000),
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      env: { ...process.env, ...env }
    });
    const info = await stat(path);
    const maxBytes = boundedNumber(process.env.KOSH_DATABASE_BACKUP_MAX_MB, 4096, 64, 65536) * 1024 * 1024;
    if (info.size <= 0 || info.size > maxBytes) throw new Error("database_backup_size_invalid");
    const checksum = await hashFile(path);
    const locator = await putKoshObjectFromFile({
      storageClass: "backup",
      repositoryId: "platform",
      logicalId,
      filename,
      mediaType: "application/vnd.kosh.postgresql-dump",
      sourcePath: path,
      sizeBytes: info.size,
      sha256: checksum,
      localPath: path
    });
    const resource = await platformStore.createResource({
      repositoryId: null,
      namespace: "platform",
      type: "backup",
      key: logicalId,
      name: "PostgreSQL backup " + new Date().toISOString(),
      state: "ready",
      payload: {
        kind: "postgres-dump",
        filename,
        sizeBytes: info.size,
        sha256: checksum,
        storageBackend: locator.backend,
        storageLogicalId: logicalId,
        createdAt: new Date().toISOString()
      },
      createdByUserId: systemActor.id,
      createdByName: systemActor.displayName
    });
    await objectIndex.put({
      repositoryId: "platform",
      storageClass: "backup",
      logicalId,
      locator
    });
    if (locator.backend === "google-drive") await rm(path, { force: true }).catch(() => undefined);
    await audit(null, "database_backup_created", "backup", resource.id, {
      sizeBytes: info.size,
      sha256: checksum,
      storageBackend: locator.backend
    });
    return { backupId: resource.id, logicalId, sizeBytes: info.size, sha256: checksum, storageBackend: locator.backend };
  } finally {
    if (process.env.KOSH_OBJECT_STORAGE_BACKEND === "google-drive") {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

function replicaPath(repository: StoredKoshRepository, storageClass: KoshStorageClass, logicalId: string) {
  return safePath(replicaRoot, repository.id, storageClass, clean(logicalId, 200) + ".object");
}

async function runReplicationVerify(repository: StoredKoshRepository, repair: boolean) {
  if (!process.env.KOSH_REPLICA_ROOT?.trim()) {
    throw Object.assign(new Error("kosh_replica_root_required"), { status: 503 });
  }
  const indexed = await objectIndex.list(repository.id);
  const results: Array<Record<string, unknown>> = [];
  for (const item of indexed) {
    const destination = replicaPath(repository, item.storageClass, item.logicalId);
    let info = await stat(destination).catch(() => null);
    let checksum = info ? await hashFile(destination).catch(() => "") : "";
    let valid = Boolean(info && info.size === item.locator.sizeBytes && checksum === item.locator.sha256);
    if (!valid && repair) {
      await rm(destination, { force: true }).catch(() => undefined);
      await mkdir(dirname(destination), { recursive: true });
      const fallback = item.locator.backend === "local" ? item.locator.objectId : "";
      await materializeKoshObject(item.locator, fallback, destination);
      info = await stat(destination);
      checksum = await hashFile(destination);
      valid = info.size === item.locator.sizeBytes && checksum === item.locator.sha256;
    }
    results.push({
      storageClass: item.storageClass,
      logicalId: item.logicalId,
      valid,
      repaired: repair && valid,
      sizeBytes: info?.size ?? 0,
      sha256: checksum
    });
  }
  const failures = results.filter((item) => item.valid !== true).length;
  await upsertEvidence({
    repository,
    key: "replication:evidence",
    name: "Storage replication evidence",
    payload: {
      kind: "replication_evidence",
      checkedAt: new Date().toISOString(),
      replicaProvider: "filesystem",
      objects: results.length,
      failures
    }
  });
  await audit(repository.id, "storage_replication_verified", "storage_policy", null, {
    objects: results.length,
    failures,
    repair
  });
  return { provider: "filesystem", objects: results.length, failures, results };
}

async function runProviderHook(job: StoredKoshMaintenanceJob) {
  const hook =
    job.kind === "notification_delivery"
      ? process.env.KOSH_NOTIFICATION_DELIVERY_HOOK
      : job.kind === "pages_domain_maintenance"
        ? process.env.KOSH_PAGES_DOMAIN_MAINTENANCE_HOOK
        : process.env.KOSH_EXTENSION_RUNTIME_HOOK;
  if (!hook?.trim()) {
    throw Object.assign(new Error(`${job.kind}_provider_not_configured`), { status: 503 });
  }
  const url = new URL(hook);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw Object.assign(new Error("maintenance_provider_https_required"), { status: 503 });
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.KOSH_MAINTENANCE_PROVIDER_TOKEN
        ? { authorization: `Bearer ${process.env.KOSH_MAINTENANCE_PROVIDER_TOKEN}` }
        : {})
    },
    body: JSON.stringify({
      jobId: job.id,
      kind: job.kind,
      repositoryId: job.repositoryId,
      payload: job.payload
    }),
    signal: AbortSignal.timeout(120_000)
  });
  const text = (await response.text()).slice(0, 128 * 1024);
  if (!response.ok) throw new Error(`maintenance_provider_http_${response.status}:${text.slice(0, 1000)}`);
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = { response: text };
  }
  return { provider: url.origin, response: payload };
}

export async function executeKoshMaintenanceJob(job: StoredKoshMaintenanceJob) {
  await Promise.all([platformStore.ready(), objectIndex.ready(), maintenanceStore.ready()]);
  if (job.kind === "database_backup") return runDatabaseBackup();
  if (["notification_delivery", "pages_domain_maintenance", "extension_execute"].includes(job.kind)) {
    return runProviderHook(job);
  }
  const repository = await repositoryById(job.repositoryId);
  if (!repository) throw Object.assign(new Error("maintenance_repository_not_found"), { status: 404 });

  switch (job.kind) {
    case "storage_reconcile":
      return runStorageReconciliation(repository);
    case "storage_migrate":
      return runStorageMigration(repository, job);
    case "storage_gc":
      return runStorageGarbageCollection(repository, job);
    case "replication_verify":
      return runReplicationVerify(repository, job.payload.repair !== false);
    case "recovery_drill":
      return runRecoveryDrill(repository);
    default:
      throw Object.assign(new Error("maintenance_job_kind_not_executable"), { status: 400 });
  }
}
