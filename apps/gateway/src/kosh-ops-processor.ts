import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { resolveTxt } from "node:dns/promises";
import type { KoshOpsJob } from "./kosh-ops-store.js";
import { listKoshOpsJobs } from "./kosh-ops-store.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";
import {
  deleteKoshObject,
  koshObjectStorageBackend,
  materializeKoshObject,
  putKoshObjectFromFile,
  type KoshObjectLocator
} from "./kosh-object-storage.js";
import { reconcileKoshStorage } from "./kosh-storage-reconciliation.js";
import { koshKnownStorageUsage, koshStorageLimits, type KoshStorageClass } from "./kosh-storage-policy.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const objectIndex = getKoshObjectIndex();
const platformObjectRepositoryId = "__kosh_platform__";

type JsonRecord = Record<string, unknown>;

type ProcessorResult = Record<string, unknown>;

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function safeHost(value: string) {
  const host = value.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes("..")) {
    throw Object.assign(new Error("invalid_hostname"), { status: 400 });
  }
  return host;
}

function hashFile(path: string) {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function repositoryForJob(job: KoshOpsJob) {
  if (!job.repositoryId) return null;
  return (await repositoryStore.list()).find((item) => item.id === job.repositoryId) ?? null;
}

async function appendAudit(
  repositoryId: string | null,
  eventType: string,
  resourceType: string,
  resourceId: string | null,
  metadata: JsonRecord
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: null,
    actorName: "Kosh Operations Worker",
    eventType,
    resourceType,
    resourceId,
    metadata
  });
}

async function verifyLocator(
  repository: StoredKoshRepository,
  item: {
    storageClass: KoshStorageClass;
    logicalId: string;
    sizeBytes: number;
    sha256: string;
  },
  locator: KoshObjectLocator
) {
  const root = resolve(process.env.KOSH_STORAGE_RECONCILIATION_ROOT?.trim() || ".kosh/reconciliation");
  await mkdir(root, { recursive: true });
  const path = join(root, `${repository.id}-${randomUUID()}.verify`);
  try {
    await materializeKoshObject(locator, "", path);
    const info = await stat(path);
    const checksum = await hashFile(path);
    if (info.size !== item.sizeBytes || checksum !== item.sha256) {
      throw Object.assign(new Error("storage_replica_integrity_failure"), { status: 409 });
    }
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

async function processStorageLifecycle(job: KoshOpsJob): Promise<ProcessorResult> {
  const repository = await repositoryForJob(job);
  if (!repository) throw new Error("repository_not_found");
  if (koshObjectStorageBackend() !== "google-drive") {
    throw new Error("storage_lifecycle_requires_google_drive_backend");
  }
  const limit = Math.max(1, Math.min(500, Math.floor(numberValue(job.payload.limit, 100))));
  const deleteLocalAfterVerified = booleanValue(job.payload.deleteLocalAfterVerified, false);
  const orphanRetentionDays = Math.max(1, Math.min(3650, Math.floor(numberValue(job.payload.orphanRetentionDays, 30))));
  const deleteExpiredOrphans = booleanValue(job.payload.deleteExpiredOrphans, false);
  const report = await reconcileKoshStorage(repository);
  const candidates = report.items
    .filter((item) => ["local_only", "local_indexed", "recoverable_remote"].includes(item.state))
    .slice(0, limit);
  const migrated: JsonRecord[] = [];
  const failures: JsonRecord[] = [];

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
        await verifyLocator(repository, item, locator);
      } else {
        if (!item.localPath) throw new Error("local_storage_source_missing");
        const info = await stat(item.localPath).catch(() => null);
        if (!info) throw new Error("local_storage_source_missing");
        const checksum = await hashFile(item.localPath);
        if (info.size !== item.sizeBytes || checksum !== item.sha256) {
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
        if (!uploaded) throw new Error("google_drive_backend_required_for_migration");
        await verifyLocator(repository, item, locator);
      }
      await objectIndex.put({
        repositoryId: repository.id,
        storageClass: item.storageClass,
        logicalId: item.logicalId,
        locator
      });
      if (deleteLocalAfterVerified && item.localPath) {
        await rm(item.localPath, { force: true });
      }
      migrated.push({
        storageClass: item.storageClass,
        logicalId: item.logicalId,
        outcome: uploaded ? "uploaded_and_indexed" : "verified_and_index_repaired"
      });
    } catch (error) {
      if (uploaded && locator) await deleteKoshObject(locator, "").catch(() => undefined);
      failures.push({
        storageClass: item.storageClass,
        logicalId: item.logicalId,
        error: error instanceof Error ? error.message : "migration_failed"
      });
    }
  }

  const current = await reconcileKoshStorage(repository);
  const liveRemoteIds = new Set(
    current.items.map((item) => item.remote?.id).filter((value): value is string => Boolean(value))
  );
  const cutoff = Date.now() - orphanRetentionDays * 24 * 60 * 60 * 1000;
  const eligibleOrphans = current.orphanRemote.filter((item) => {
    if (liveRemoteIds.has(item.id)) return false;
    if (!item.modifiedAt) return false;
    return new Date(item.modifiedAt).getTime() <= cutoff;
  });
  const deletedOrphans: string[] = [];
  if (deleteExpiredOrphans) {
    for (const orphan of eligibleOrphans.slice(0, limit)) {
      await deleteKoshObject({
        backend: "google-drive",
        objectId: orphan.id,
        storageClass: orphan.storageClass,
        sizeBytes: orphan.sizeBytes,
        sha256: orphan.sha256
      }, "");
      deletedOrphans.push(orphan.id);
    }
  }
  const after = await reconcileKoshStorage(repository);
  await appendAudit(repository.id, "storage_lifecycle_completed", "storage_policy", job.id, {
    migrated: migrated.length,
    failures: failures.length,
    eligibleOrphans: eligibleOrphans.length,
    deletedOrphans: deletedOrphans.length,
    summary: after.summary
  });
  return {
    migrated,
    failures,
    eligibleOrphans: eligibleOrphans.map((item) => ({
      id: item.id,
      storageClass: item.storageClass,
      modifiedAt: item.modifiedAt,
      sizeBytes: item.sizeBytes
    })),
    deletedOrphans,
    summary: after.summary
  };
}

async function processReplicationVerify(job: KoshOpsJob): Promise<ProcessorResult> {
  const repository = await repositoryForJob(job);
  if (!repository) throw new Error("repository_not_found");
  const mirrorRoot = process.env.KOSH_OBJECT_MIRROR_ROOT?.trim();
  if (!mirrorRoot) throw new Error("object_mirror_root_not_configured");
  const report = await reconcileKoshStorage(repository);
  const checked: JsonRecord[] = [];
  const missing: JsonRecord[] = [];
  for (const item of report.items.slice(0, 1000)) {
    const path = resolve(mirrorRoot, item.storageClass, repository.id, item.logicalId, basename(item.filename));
    const info = await stat(path).catch(() => null);
    if (!info) {
      missing.push({ storageClass: item.storageClass, logicalId: item.logicalId });
      continue;
    }
    const checksum = await hashFile(path);
    const valid = info.size === item.sizeBytes && checksum === item.sha256;
    checked.push({ storageClass: item.storageClass, logicalId: item.logicalId, valid });
    if (!valid) missing.push({ storageClass: item.storageClass, logicalId: item.logicalId, reason: "integrity" });
  }
  await appendAudit(repository.id, "storage_replication_verified", "storage_policy", job.id, {
    checked: checked.length,
    failures: missing.length
  });
  return { mirrorRootConfigured: true, checked: checked.length, failures: missing };
}

async function processRecoveryDrill(job: KoshOpsJob): Promise<ProcessorResult> {
  const repository = await repositoryForJob(job);
  if (!repository) throw new Error("repository_not_found");
  const backups = (await platformStore.listResources("backup", repository.id))
    .filter((item) => item.payload.kind === "git-bundle" || !item.payload.kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const backup = backups[0];
  if (!backup) throw new Error("recovery_backup_required");
  const logicalId = clean(backup.payload.storageLogicalId, 240) || backup.id;
  const indexed = await objectIndex.get(repository.id, "backup", logicalId);
  const filename = clean(backup.payload.filename, 240);
  if (!filename) throw new Error("backup_filename_missing");
  const backupRoot = resolve(process.env.KOSH_BACKUP_ROOT?.trim() || ".kosh/backups");
  const localFallback = resolve(backupRoot, repository.id, filename);
  const root = await mkdtemp(join(tmpdir(), "kosh-drill-"));
  const bundlePath = join(root, "repository.bundle");
  const mirrorPath = join(root, "restored.git");
  try {
    await materializeKoshObject(indexed?.locator ?? null, localFallback, bundlePath);
    const size = (await stat(bundlePath)).size;
    const checksum = await hashFile(bundlePath);
    const expectedSize = numberValue(backup.payload.sizeBytes, size);
    const expectedChecksum = clean(backup.payload.sha256, 128);
    if (size !== expectedSize || (expectedChecksum && checksum !== expectedChecksum)) {
      throw new Error("recovery_drill_checksum_failure");
    }
    await execFileAsync("git", ["clone", "--mirror", bundlePath, mirrorPath], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024
    });
    await execFileAsync("git", ["--git-dir", mirrorPath, "fsck", "--full", "--strict"], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024
    });
    const result = {
      backupId: backup.id,
      logicalId,
      bytes: size,
      sha256: checksum,
      verifiedAt: new Date().toISOString(),
      activated: false
    };
    await appendAudit(repository.id, "recovery_drill_succeeded", "backup", backup.id, result);
    return result;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function processAlerts(job: KoshOpsJob): Promise<ProcessorResult> {
  const repository = await repositoryForJob(job);
  const rules = (await platformStore.listResources("admin_setting", repository?.id ?? null))
    .filter((item) => item.payload.kind === "alert_rule" && item.state === "active");
  const fired: JsonRecord[] = [];
  const recentOps = await listKoshOpsJobs(repository?.id, 200);
  let storageRatio = 0;
  if (repository) {
    const [usage, limits] = await Promise.all([
      koshKnownStorageUsage(repository.id),
      koshStorageLimits(repository.id)
    ]);
    storageRatio = limits.maxTotalBytes > 0 ? usage.knownBytes / limits.maxTotalBytes : 0;
  }
  const context: JsonRecord = {
    storageRatio,
    failedOpsLast200: recentOps.filter((item) => item.state === "failed").length,
    queuedOps: recentOps.filter((item) => item.state === "queued").length
  };
  for (const rule of rules) {
    const metric = clean(rule.payload.metric, 80);
    const threshold = numberValue(rule.payload.threshold, 0);
    const value = numberValue(context[metric], 0);
    if (value < threshold) continue;
    fired.push({ ruleId: rule.id, metric, value, threshold });
    await appendAudit(repository?.id ?? null, "operations_alert_fired", "alert_rule", rule.id, {
      metric,
      value,
      threshold,
      severity: clean(rule.payload.severity, 40) || "warning"
    });
  }
  return { evaluated: rules.length, fired, context };
}

async function processNotificationDelivery(job: KoshOpsJob): Promise<ProcessorResult> {
  const relay = process.env.KOSH_NOTIFICATION_DELIVERY_ENDPOINT?.trim();
  if (!relay) throw new Error("notification_delivery_endpoint_not_configured");
  const url = new URL(relay);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("notification_delivery_endpoint_requires_https");
  }
  const subscriptions = (await platformStore.listResources("subscription", job.repositoryId))
    .filter((item) => item.state === "active");
  const event = clean(job.payload.event, 120) || "kosh.notification";
  const message = clean(job.payload.message, 4000);
  const delivered: JsonRecord[] = [];
  const failures: JsonRecord[] = [];
  for (const subscription of subscriptions.slice(0, 500)) {
    const events = Array.isArray(subscription.payload.events)
      ? subscription.payload.events.map(String)
      : [];
    if (events.length && !events.includes(event) && !events.includes("*")) continue;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.KOSH_NOTIFICATION_DELIVERY_TOKEN?.trim()
          ? { authorization: `Bearer ${process.env.KOSH_NOTIFICATION_DELIVERY_TOKEN.trim()}` }
          : {})
      },
      body: JSON.stringify({
        subscriptionId: subscription.id,
        repositoryId: job.repositoryId,
        channel: subscription.payload.channel ?? "inbox",
        address: subscription.payload.address ?? null,
        event,
        message,
        data: job.payload.data ?? null
      }),
      signal: AbortSignal.timeout(15_000),
      redirect: "error"
    }).catch((error) => ({ ok: false, status: 0, error }) as Response & { error?: unknown });
    if (response.ok) delivered.push({ subscriptionId: subscription.id, status: response.status });
    else failures.push({ subscriptionId: subscription.id, status: response.status });
  }
  await appendAudit(job.repositoryId, "notification_delivery_completed", "subscription", job.id, {
    event,
    delivered: delivered.length,
    failures: failures.length
  });
  return { event, delivered, failures };
}

async function processPagesDomainVerify(job: KoshOpsJob): Promise<ProcessorResult> {
  const repository = await repositoryForJob(job);
  if (!repository) throw new Error("repository_not_found");
  const host = safeHost(clean(job.payload.hostname, 253));
  const expected = clean(job.payload.verificationToken, 180);
  if (!expected) throw new Error("domain_verification_token_required");
  const records = await resolveTxt(`_kosh.${host}`).catch(() => [] as string[][]);
  const values = records.map((parts) => parts.join(""));
  const verified = values.includes(`kosh-domain=${expected}`);
  const sites = await platformStore.listResources("page_site", repository.id);
  const key = `domain:${host}`;
  const existing = sites.find((item) => item.key === key);
  const payload = {
    kind: "domain",
    hostname: host,
    verificationToken: expected,
    verified,
    verifiedAt: verified ? new Date().toISOString() : null,
    tlsState: verified ? "pending_provisioner" : "unverified"
  };
  if (existing) await platformStore.updateResource(existing.id, { state: verified ? "verified" : "pending", payload });
  else await platformStore.createResource({
    repositoryId: repository.id,
    namespace: repository.namespace,
    type: "page_site",
    key,
    name: host,
    state: verified ? "verified" : "pending",
    payload,
    createdByUserId: job.createdByUserId ?? "system",
    createdByName: job.createdByName
  });

  let tlsRequested = false;
  const provisioner = process.env.KOSH_PAGES_TLS_PROVISIONER_URL?.trim();
  if (verified && provisioner) {
    const provisionUrl = new URL(provisioner);
    if (process.env.NODE_ENV === "production" && provisionUrl.protocol !== "https:") {
      throw new Error("pages_tls_provisioner_requires_https");
    }
    const response = await fetch(provisionUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.KOSH_PAGES_TLS_PROVISIONER_TOKEN?.trim()
          ? { authorization: `Bearer ${process.env.KOSH_PAGES_TLS_PROVISIONER_TOKEN.trim()}` }
          : {})
      },
      body: JSON.stringify({ hostname: host, namespace: repository.namespace, repository: repository.slug }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error"
    });
    if (!response.ok) throw new Error(`pages_tls_provisioner_http_${response.status}`);
    tlsRequested = true;
  }
  await appendAudit(repository.id, "pages_domain_verified", "page_site", existing?.id ?? null, {
    hostname: host,
    verified,
    tlsRequested
  });
  return { hostname: host, verified, tlsRequested };
}

function runSandbox(command: string, payload: JsonRecord, timeoutMs: number) {
  return new Promise<JsonRecord>((resolveRun, reject) => {
    const child = spawn(command, [], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: process.env.NODE_ENV ?? "development",
        KOSH_EXTENSION_NETWORK: "deny"
      }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`extension_sandbox_failed:${code}:${stderr.slice(-1000)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || "{}");
        resolveRun(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { output: parsed });
      } catch {
        resolveRun({ output: stdout });
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function processExtensionExecution(job: KoshOpsJob): Promise<ProcessorResult> {
  const extensionId = clean(job.payload.extensionId, 200);
  const extensions = await platformStore.listResources("extension", job.repositoryId);
  const extension = extensions.find((item) => item.id === extensionId || item.key === extensionId);
  if (!extension || extension.state !== "active") throw new Error("extension_not_active");
  const sandbox = process.env.KOSH_EXTENSION_SANDBOX_COMMAND?.trim();
  if (!sandbox) {
    if (process.env.NODE_ENV === "production") throw new Error("extension_sandbox_required");
    return { skipped: true, reason: "extension_sandbox_not_configured" };
  }
  const timeoutMs = Math.max(1000, Math.min(120_000, Math.floor(numberValue(job.payload.timeoutMs, 30_000))));
  const result = await runSandbox(sandbox, {
    extension: {
      id: extension.id,
      key: extension.key,
      name: extension.name,
      payload: extension.payload
    },
    repositoryId: job.repositoryId,
    input: job.payload.input ?? {}
  }, timeoutMs);
  await appendAudit(job.repositoryId, "extension_execution_completed", "extension", extension.id, {
    jobId: job.id,
    timeoutMs
  });
  return { extensionId: extension.id, result };
}

async function processLoadTest(job: KoshOpsJob): Promise<ProcessorResult> {
  const origin = process.env.KOSH_PUBLIC_ORIGIN?.trim();
  if (!origin) throw new Error("kosh_public_origin_required");
  const allowed = new URL(origin);
  const path = clean(job.payload.path, 500) || "/health";
  const target = new URL(path, allowed);
  if (target.origin !== allowed.origin) throw new Error("load_test_target_outside_kosh_origin");
  const requests = Math.max(1, Math.min(5000, Math.floor(numberValue(job.payload.requests, 100))));
  const concurrency = Math.max(1, Math.min(100, Math.floor(numberValue(job.payload.concurrency, 10))));
  const durations: number[] = [];
  let failures = 0;
  let cursor = 0;
  async function worker() {
    while (cursor < requests) {
      cursor += 1;
      const start = performance.now();
      try {
        const response = await fetch(target, { signal: AbortSignal.timeout(10_000), redirect: "error" });
        if (!response.ok) failures += 1;
        await response.arrayBuffer();
      } catch {
        failures += 1;
      } finally {
        durations.push(performance.now() - start);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  durations.sort((a, b) => a - b);
  const percentile = (p: number) => durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))] ?? 0;
  const result = {
    target: target.toString(),
    requests,
    concurrency,
    failures,
    successRate: requests ? (requests - failures) / requests : 0,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99)
  };
  await appendAudit(job.repositoryId, "load_test_completed", "load_test", job.id, result);
  return result;
}

async function processDatabaseBackup(job: KoshOpsJob): Promise<ProcessorResult> {
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("workspace_database_url_required");
  const root = await mkdtemp(join(tmpdir(), "kosh-db-backup-"));
  const output = join(root, `kosh-${Date.now()}.dump`);
  try {
    const pgDump = process.env.KOSH_PG_DUMP_BIN?.trim() || "pg_dump";
    await execFileAsync(pgDump, ["--format=custom", "--no-owner", "--no-privileges", `--file=${output}`, databaseUrl], {
      timeout: Math.max(60_000, Math.min(30 * 60_000, numberValue(job.payload.timeoutMs, 10 * 60_000))),
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PGPASSWORD: process.env.PGPASSWORD }
    });
    const info = await stat(output);
    const sha256 = await hashFile(output);
    const logicalId = `database-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
    const locator = await putKoshObjectFromFile({
      storageClass: "backup",
      repositoryId: platformObjectRepositoryId,
      logicalId,
      filename: basename(output),
      mediaType: "application/octet-stream",
      sourcePath: output,
      sizeBytes: info.size,
      sha256,
      localPath: resolve(process.env.KOSH_BACKUP_ROOT?.trim() || ".kosh/backups", "platform", basename(output))
    });
    await objectIndex.put({
      repositoryId: platformObjectRepositoryId,
      storageClass: "backup",
      logicalId,
      locator
    });
    const record = await platformStore.createResource({
      repositoryId: null,
      namespace: "system",
      type: "backup",
      key: `database:${logicalId}`,
      name: "Workspace PostgreSQL backup",
      state: "verified",
      payload: {
        kind: "postgres-custom",
        storageLogicalId: logicalId,
        sizeBytes: info.size,
        sha256,
        createdAt: new Date().toISOString(),
        restoreCommand: "pg_restore --clean --if-exists --no-owner <dump>"
      },
      createdByUserId: job.createdByUserId ?? "system",
      createdByName: job.createdByName
    });
    await appendAudit(null, "database_backup_created", "backup", record.id, {
      logicalId,
      sizeBytes: info.size,
      sha256,
      backend: locator.backend
    });
    return { backupId: record.id, logicalId, sizeBytes: info.size, sha256, backend: locator.backend };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function processSecretRotationAudit(job: KoshOpsJob): Promise<ProcessorResult> {
  const secrets = await platformStore.listSecrets(job.repositoryId);
  const maxAgeDays = Math.max(1, Math.min(3650, Math.floor(numberValue(job.payload.maxAgeDays, 90))));
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const overdue = secrets.filter((item) => new Date(item.updatedAt).getTime() <= cutoff);
  for (const secret of overdue) {
    await appendAudit(job.repositoryId, "secret_rotation_overdue", "secret", secret.id, {
      name: secret.name,
      environmentName: secret.environmentName,
      updatedAt: secret.updatedAt,
      maxAgeDays
    });
  }
  return {
    checked: secrets.length,
    overdue: overdue.map((item) => ({
      id: item.id,
      name: item.name,
      environmentName: item.environmentName,
      updatedAt: item.updatedAt
    }))
  };
}

async function processFailureProbe(job: KoshOpsJob): Promise<ProcessorResult> {
  if (process.env.NODE_ENV === "production" && process.env.KOSH_ALLOW_PRODUCTION_FAILURE_PROBES !== "true") {
    throw new Error("production_failure_probes_disabled");
  }
  const mode = clean(job.payload.mode, 80) || "synthetic-error";
  if (mode === "synthetic-error") throw new Error("synthetic_failure_probe");
  if (mode === "latency") {
    const delayMs = Math.max(1, Math.min(10_000, Math.floor(numberValue(job.payload.delayMs, 500))));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    return { mode, delayMs, completed: true };
  }
  return { mode, completed: true, note: "No destructive fault was injected." };
}

export async function processKoshOpsJob(job: KoshOpsJob): Promise<ProcessorResult> {
  await Promise.all([platformStore.ready(), objectIndex.ready()]);
  switch (job.type) {
    case "storage.lifecycle": return processStorageLifecycle(job);
    case "replication.verify": return processReplicationVerify(job);
    case "recovery.drill": return processRecoveryDrill(job);
    case "alerts.evaluate": return processAlerts(job);
    case "notification.deliver": return processNotificationDelivery(job);
    case "pages.domain.verify": return processPagesDomainVerify(job);
    case "extension.execute": return processExtensionExecution(job);
    case "load.test": return processLoadTest(job);
    case "database.backup": return processDatabaseBackup(job);
    case "secret.rotation.audit": return processSecretRotationAudit(job);
    case "failure.probe": return processFailureProbe(job);
    default: throw new Error(`unsupported_ops_job:${job.type satisfies never}`);
  }
}
