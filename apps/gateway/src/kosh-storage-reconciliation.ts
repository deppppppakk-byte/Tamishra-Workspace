import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { automationStore } from "./kosh-automation-service.js";
import type { StoredKoshArtifact } from "./kosh-automation-store.js";
import { listKoshDriveObjects, type KoshDriveObject } from "./kosh-google-drive-admin.js";
import {
  deleteKoshObject,
  koshObjectStorageBackend,
  materializeKoshObject,
  putKoshObjectFromFile,
  type KoshObjectLocator
} from "./kosh-object-storage.js";
import { getKoshPackageStore } from "./kosh-package-store.js";
import { getKoshPlatformStore, type StoredKoshPlatformResource } from "./kosh-platform-store.js";
import { getKoshReleaseStore } from "./kosh-release-store.js";
import { getKoshObjectIndex, type StoredKoshObjectLocator } from "./kosh-storage-object-index.js";
import type { KoshStorageClass } from "./kosh-storage-policy.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const packageStore = getKoshPackageStore();
const releaseStore = getKoshReleaseStore();
const automation = automationStore();
const platformStore = getKoshPlatformStore();
const objectIndex = getKoshObjectIndex();

const packageRoot = resolve(process.env.KOSH_PACKAGE_ROOT?.trim() || ".kosh/packages");
const releaseRoot = resolve(process.env.KOSH_RELEASE_ROOT?.trim() || ".kosh/releases");
const artifactRoot = resolve(process.env.KOSH_ARTIFACT_ROOT?.trim() || ".kosh/artifacts");
const backupRoot = resolve(process.env.KOSH_BACKUP_ROOT?.trim() || ".kosh/backups");
const reconciliationRoot = resolve(
  process.env.KOSH_STORAGE_RECONCILIATION_ROOT?.trim() || ".kosh/reconciliation"
);
const storageClasses: KoshStorageClass[] = ["package", "release", "artifact", "backup"];
const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Actor = { id: string; displayName: string };
type CatalogEntry = {
  storageClass: KoshStorageClass;
  logicalId: string;
  sourceId: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  localPath: string | null;
};

type ItemState =
  | "drive_indexed"
  | "drive_unchecked"
  | "drive_missing"
  | "drive_mismatch"
  | "recoverable_remote"
  | "local_indexed"
  | "local_only"
  | "missing_payload";

type ReconciledItem = CatalogEntry & {
  state: ItemState;
  localExists: boolean;
  index: StoredKoshObjectLocator | null;
  remote: KoshDriveObject | null;
};

type ReconciliationReport = {
  repositoryId: string;
  backend: string;
  checkedAt: string;
  driveErrors: Partial<Record<KoshStorageClass, string>>;
  summary: {
    metadataObjects: number;
    indexedObjects: number;
    driveObjects: number;
    healthy: number;
    migratable: number;
    recoverable: number;
    missing: number;
    mismatched: number;
    unchecked: number;
    orphanRemote: number;
    staleIndex: number;
  };
  items: ReconciledItem[];
  orphanRemote: KoshDriveObject[];
  staleIndex: StoredKoshObjectLocator[];
};

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maxBytes = 128 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(value);
  }
  if (!chunks.length) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_json");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safePath(root: string, ...parts: string[]) {
  const path = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (path !== root && !path.startsWith(prefix)) {
    throw Object.assign(new Error("storage_path_invalid"), { status: 400 });
  }
  return path;
}

function confinedExistingPath(root: string, value: string) {
  const path = resolve(value);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (path !== root && !path.startsWith(prefix)) return null;
  return path;
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

function key(storageClass: KoshStorageClass, logicalId: string) {
  return storageClass + "\0" + logicalId;
}

function artifactLogicalId(artifact: StoredKoshArtifact) {
  const prefix = "kosh-object://artifact/";
  if (!artifact.storagePath.startsWith(prefix)) return artifact.id;
  const value = artifact.storagePath.slice(prefix.length).trim();
  return /^[a-zA-Z0-9._-]{1,240}$/.test(value) ? value : artifact.id;
}

async function catalog(repository: StoredKoshRepository): Promise<CatalogEntry[]> {
  await Promise.all([
    packageStore.ready(),
    releaseStore.ready(),
    automation.ready(),
    platformStore.ready(),
    objectIndex.ready()
  ]);

  const entries: CatalogEntry[] = [];
  const versions = await packageStore.listVersions(repository.id);
  for (const version of versions) {
    entries.push({
      storageClass: "package",
      logicalId: version.id,
      sourceId: version.id,
      filename: version.filename,
      mediaType: version.mediaType || "application/octet-stream",
      sizeBytes: version.sizeBytes,
      sha256: version.sha256,
      localPath: safePath(packageRoot, repository.id, version.id, version.filename)
    });
  }

  const releases = await releaseStore.listReleases(repository.id);
  for (const release of releases) {
    for (const asset of await releaseStore.listAssets(release.id)) {
      entries.push({
        storageClass: "release",
        logicalId: asset.id,
        sourceId: asset.id,
        filename: asset.filename,
        mediaType: asset.mediaType || "application/octet-stream",
        sizeBytes: asset.sizeBytes,
        sha256: asset.sha256,
        localPath: safePath(
          releaseRoot,
          repository.id,
          release.id,
          asset.id,
          asset.filename
        )
      });
    }
  }

  const runs = await automation.listRuns(repository.id, 2000);
  for (const run of runs) {
    for (const artifact of await automation.listArtifacts(run.id)) {
      const logicalId = artifactLogicalId(artifact);
      const localPath = artifact.storagePath.startsWith("kosh-object://artifact/")
        ? null
        : confinedExistingPath(artifactRoot, artifact.storagePath);
      entries.push({
        storageClass: "artifact",
        logicalId,
        sourceId: artifact.id,
        filename: artifact.name,
        mediaType: "application/octet-stream",
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        localPath
      });
    }
  }

  const backups = await platformStore.listResources("backup", repository.id);
  for (const backup of backups) {
    if (backup.payload.kind && backup.payload.kind !== "git-bundle") continue;
    const filename = clean(backup.payload.filename, 240);
    if (!filename) continue;
    entries.push({
      storageClass: "backup",
      logicalId: clean(backup.payload.storageLogicalId, 240) || backup.id,
      sourceId: backup.id,
      filename,
      mediaType: "application/x-git-bundle",
      sizeBytes: Math.max(0, Number(backup.payload.sizeBytes) || 0),
      sha256: clean(backup.payload.sha256, 128),
      localPath: safePath(backupRoot, repository.id, filename)
    });
  }

  return entries;
}

async function driveInventory(repositoryId: string) {
  const objects = new Map<KoshStorageClass, KoshDriveObject[]>();
  const errors: Partial<Record<KoshStorageClass, string>> = {};
  if (koshObjectStorageBackend() !== "google-drive") {
    for (const storageClass of storageClasses) objects.set(storageClass, []);
    return { objects, errors };
  }
  await Promise.all(
    storageClasses.map(async (storageClass) => {
      try {
        objects.set(storageClass, await listKoshDriveObjects(repositoryId, storageClass));
      } catch (error) {
        objects.set(storageClass, []);
        errors[storageClass] = error instanceof Error ? error.message : "drive_inventory_failed";
      }
    })
  );
  return { objects, errors };
}

export async function reconcileKoshStorage(repository: StoredKoshRepository): Promise<ReconciliationReport> {
  const [entries, indexes, drive] = await Promise.all([
    catalog(repository),
    objectIndex.list(repository.id),
    driveInventory(repository.id)
  ]);

  const indexMap = new Map(indexes.map((item) => [key(item.storageClass, item.logicalId), item]));
  const remoteById = new Map<string, KoshDriveObject>();
  const remoteByLogical = new Map<string, KoshDriveObject>();
  for (const storageClass of storageClasses) {
    for (const remote of drive.objects.get(storageClass) ?? []) {
      remoteById.set(remote.id, remote);
      if (remote.logicalId) remoteByLogical.set(key(storageClass, remote.logicalId), remote);
    }
  }

  const metadataKeys = new Set(entries.map((entry) => key(entry.storageClass, entry.logicalId)));
  const items: ReconciledItem[] = [];
  for (const entry of entries) {
    const storageKey = key(entry.storageClass, entry.logicalId);
    const indexed = indexMap.get(storageKey) ?? null;
    const localExists = entry.localPath
      ? Boolean(await stat(entry.localPath).catch(() => null))
      : false;
    const classUnchecked = Boolean(drive.errors[entry.storageClass]);
    let remote: KoshDriveObject | null = null;
    let state: ItemState;

    if (indexed?.locator.backend === "google-drive") {
      remote = remoteById.get(indexed.locator.objectId) ?? null;
      if (classUnchecked) {
        state = "drive_unchecked";
      } else if (!remote) {
        state = "drive_missing";
      } else if (
        remote.sizeBytes !== entry.sizeBytes ||
        (remote.sha256 && remote.sha256 !== entry.sha256) ||
        indexed.locator.sizeBytes !== entry.sizeBytes ||
        indexed.locator.sha256 !== entry.sha256
      ) {
        state = "drive_mismatch";
      } else {
        state = "drive_indexed";
      }
    } else {
      remote = remoteByLogical.get(storageKey) ?? null;
      if (remote && !classUnchecked) {
        state = "recoverable_remote";
      } else if (localExists) {
        state = indexed ? "local_indexed" : "local_only";
      } else {
        state = "missing_payload";
      }
    }
    items.push({ ...entry, state, localExists, index: indexed, remote });
  }

  const indexedDriveIds = new Set(
    indexes
      .filter((item) => item.locator.backend === "google-drive")
      .map((item) => item.locator.objectId)
  );
  const orphanRemote = [...remoteById.values()].filter(
    (item) => !indexedDriveIds.has(item.id)
  );
  const staleIndex = indexes.filter(
    (item) => !metadataKeys.has(key(item.storageClass, item.logicalId))
  );
  const count = (states: ItemState[]) => items.filter((item) => states.includes(item.state)).length;

  return {
    repositoryId: repository.id,
    backend: koshObjectStorageBackend(),
    checkedAt: new Date().toISOString(),
    driveErrors: drive.errors,
    summary: {
      metadataObjects: entries.length,
      indexedObjects: indexes.length,
      driveObjects: remoteById.size,
      healthy: count(["drive_indexed"]),
      migratable: count(["local_only", "local_indexed"]),
      recoverable: count(["recoverable_remote"]),
      missing: count(["drive_missing", "missing_payload"]),
      mismatched: count(["drive_mismatch"]),
      unchecked: count(["drive_unchecked"]),
      orphanRemote: orphanRemote.length,
      staleIndex: staleIndex.length
    },
    items,
    orphanRemote,
    staleIndex
  };
}

async function verifyRemoteLocator(entry: CatalogEntry, locator: KoshObjectLocator) {
  const directory = safePath(reconciliationRoot, entry.storageClass);
  await mkdir(directory, { recursive: true });
  const path = safePath(directory, randomUUID() + ".verify");
  try {
    await materializeKoshObject(locator, "", path);
    const info = await stat(path);
    const checksum = await hashFile(path);
    if (info.size !== entry.sizeBytes || checksum !== entry.sha256) {
      throw Object.assign(new Error("migrated_object_verification_failed"), { status: 409 });
    }
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

async function audit(
  repositoryId: string,
  actor: Actor,
  eventType: string,
  resourceId: string,
  metadata: Record<string, unknown>
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType: "storage_policy",
    resourceId,
    metadata
  });
}

async function storeEvidence(
  repository: StoredKoshRepository,
  actor: Actor,
  report: ReconciliationReport,
  operation: string
) {
  const policies = await platformStore.listResources("storage_policy", repository.id);
  const existing = policies.find((item) => item.key === "reconciliation:evidence");
  const payload = {
    kind: "reconciliation_evidence",
    backend: report.backend,
    checkedAt: report.checkedAt,
    operation,
    summary: report.summary,
    driveErrors: report.driveErrors
  };
  if (existing) {
    return platformStore.updateResource(existing.id, { state: "active", payload });
  }
  return platformStore.createResource({
    repositoryId: repository.id,
    namespace: repository.namespace,
    type: "storage_policy",
    key: "reconciliation:evidence",
    name: "Storage reconciliation evidence",
    state: "active",
    payload,
    createdByUserId: actor.id,
    createdByName: actor.displayName
  });
}

export async function getKoshStorageReconciliationEvidence(repositoryId: string) {
  await platformStore.ready();
  const policies = await platformStore.listResources("storage_policy", repositoryId);
  return policies.find((item) => item.key === "reconciliation:evidence") ?? null;
}

async function migrateOne(
  repository: StoredKoshRepository,
  actor: Actor,
  entry: ReconciledItem,
  deleteLocalAfterVerified: boolean
) {
  if (entry.state === "drive_indexed") return { logicalId: entry.logicalId, outcome: "already_migrated" };

  let locator: KoshObjectLocator | null = null;
  let uploaded = false;
  const recoverable = entry.remote && entry.remote.logicalId === entry.logicalId
    ? entry.remote
    : null;

  try {
    if (
      recoverable &&
      recoverable.sizeBytes === entry.sizeBytes &&
      recoverable.sha256 === entry.sha256
    ) {
      locator = {
        backend: "google-drive",
        objectId: recoverable.id,
        storageClass: entry.storageClass,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256
      };
      await verifyRemoteLocator(entry, locator);
    } else {
      if (!entry.localPath) {
        throw Object.assign(new Error("local_storage_source_missing"), { status: 409 });
      }
      const info = await stat(entry.localPath).catch(() => null);
      if (!info) {
        throw Object.assign(new Error("local_storage_source_missing"), { status: 404 });
      }
      const checksum = await hashFile(entry.localPath);
      if (info.size !== entry.sizeBytes || checksum !== entry.sha256) {
        throw Object.assign(new Error("local_storage_source_integrity_failure"), { status: 409 });
      }
      locator = await putKoshObjectFromFile({
        storageClass: entry.storageClass,
        repositoryId: repository.id,
        logicalId: entry.logicalId,
        filename: entry.filename,
        mediaType: entry.mediaType,
        sourcePath: entry.localPath,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        localPath: entry.localPath
      });
      uploaded = locator.backend === "google-drive";
      if (locator.backend !== "google-drive") {
        throw Object.assign(new Error("google_drive_backend_required_for_migration"), { status: 409 });
      }
      await verifyRemoteLocator(entry, locator);
    }

    await objectIndex.put({
      repositoryId: repository.id,
      storageClass: entry.storageClass,
      logicalId: entry.logicalId,
      locator
    });

    if (deleteLocalAfterVerified && entry.localPath) {
      await rm(entry.localPath, { force: true });
    }

    await audit(repository.id, actor, "storage_object_migrated", entry.sourceId, {
      storageClass: entry.storageClass,
      logicalId: entry.logicalId,
      objectId: locator.objectId,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      repairedExistingDriveObject: !uploaded,
      localDeleted: deleteLocalAfterVerified && Boolean(entry.localPath)
    });
    return {
      logicalId: entry.logicalId,
      storageClass: entry.storageClass,
      outcome: uploaded ? "uploaded_and_indexed" : "verified_and_index_repaired"
    };
  } catch (error) {
    if (uploaded && locator) {
      await deleteKoshObject(locator, "").catch(() => undefined);
    }
    throw error;
  }
}

function requestedClasses(value: unknown) {
  if (!Array.isArray(value)) return storageClasses;
  const classes = value
    .map((item) => String(item))
    .filter((item): item is KoshStorageClass => storageClasses.includes(item as KoshStorageClass));
  return classes.length ? [...new Set(classes)] : storageClasses;
}

async function migrate(
  repository: StoredKoshRepository,
  actor: Actor,
  body: Record<string, unknown>
) {
  const before = await reconcileKoshStorage(repository);
  const classes = requestedClasses(body.classes);
  const limit = Math.max(1, Math.min(500, Math.floor(Number(body.limit) || 100)));
  const apply = body.apply === true;
  const deleteLocalAfterVerified = body.deleteLocalAfterVerified === true;
  const candidates = before.items
    .filter(
      (item) =>
        classes.includes(item.storageClass) &&
        ["local_only", "local_indexed", "recoverable_remote"].includes(item.state)
    )
    .slice(0, limit);

  if (!apply) {
    await storeEvidence(repository, actor, before, "dry_run");
    return {
      applied: false,
      candidates: candidates.map((item) => ({
        storageClass: item.storageClass,
        logicalId: item.logicalId,
        filename: item.filename,
        sizeBytes: item.sizeBytes,
        state: item.state
      })),
      report: before
    };
  }
  if (koshObjectStorageBackend() !== "google-drive") {
    throw Object.assign(new Error("google_drive_backend_required_for_migration"), { status: 409 });
  }
  const failures: Array<{ logicalId: string; storageClass: KoshStorageClass; error: string }> = [];
  const migrated: unknown[] = [];
  for (const item of candidates) {
    try {
      migrated.push(await migrateOne(repository, actor, item, deleteLocalAfterVerified));
    } catch (error) {
      failures.push({
        logicalId: item.logicalId,
        storageClass: item.storageClass,
        error: error instanceof Error ? error.message : "migration_failed"
      });
    }
  }
  const after = await reconcileKoshStorage(repository);
  await storeEvidence(repository, actor, after, "migration");
  return { applied: true, migrated, failures, report: after };
}

async function deleteOrphans(
  repository: StoredKoshRepository,
  actor: Actor,
  body: Record<string, unknown>
) {
  if (clean(body.confirm, 200) !== repository.namespace + "/" + repository.slug) {
    throw Object.assign(new Error("storage_cleanup_confirmation_mismatch"), { status: 400 });
  }
  const ids = Array.isArray(body.objectIds)
    ? [...new Set(body.objectIds.map((item) => clean(item, 240)).filter(Boolean))].slice(0, 100)
    : [];
  if (!ids.length) {
    throw Object.assign(new Error("orphan_object_ids_required"), { status: 400 });
  }
  const before = await reconcileKoshStorage(repository);
  const allowed = new Map(before.orphanRemote.map((item) => [item.id, item]));
  const deleted: string[] = [];
  for (const id of ids) {
    const remote = allowed.get(id);
    if (!remote) continue;
    await deleteKoshObject(
      {
        backend: "google-drive",
        objectId: remote.id,
        storageClass: remote.storageClass,
        sizeBytes: remote.sizeBytes,
        sha256: remote.sha256
      },
      ""
    );
    deleted.push(id);
    await audit(repository.id, actor, "storage_orphan_deleted", id, {
      storageClass: remote.storageClass,
      logicalId: remote.logicalId,
      sizeBytes: remote.sizeBytes
    });
  }
  const after = await reconcileKoshStorage(repository);
  await storeEvidence(repository, actor, after, "orphan_cleanup");
  return { deleted, report: after };
}

async function deleteStaleIndexes(
  repository: StoredKoshRepository,
  actor: Actor,
  body: Record<string, unknown>
) {
  if (clean(body.confirm, 200) !== repository.namespace + "/" + repository.slug) {
    throw Object.assign(new Error("storage_cleanup_confirmation_mismatch"), { status: 400 });
  }
  const requests = Array.isArray(body.entries)
    ? body.entries.slice(0, 100).filter((item) => item && typeof item === "object") as Array<Record<string, unknown>>
    : [];
  const before = await reconcileKoshStorage(repository);
  const stale = new Map(before.staleIndex.map((item) => [key(item.storageClass, item.logicalId), item]));
  const deleted: Array<{ storageClass: KoshStorageClass; logicalId: string }> = [];
  for (const request of requests) {
    const storageClass = clean(request.storageClass, 20) as KoshStorageClass;
    const logicalId = clean(request.logicalId, 240);
    if (!storageClasses.includes(storageClass) || !logicalId) continue;
    const item = stale.get(key(storageClass, logicalId));
    if (!item) continue;
    if (await objectIndex.delete(repository.id, storageClass, logicalId)) {
      deleted.push({ storageClass, logicalId });
      await audit(repository.id, actor, "storage_stale_index_deleted", item.id, {
        storageClass,
        logicalId,
        objectId: item.locator.objectId
      });
    }
  }
  const after = await reconcileKoshStorage(repository);
  await storeEvidence(repository, actor, after, "stale_index_cleanup");
  return { deleted, report: after };
}

function requireAllowedOrigin(
  request: IncomingMessage,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (mutatingMethods.has(request.method ?? "") && origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

export async function handleKoshStorageReconciliationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/storage\/reconcile(?:\/(orphans\/delete|stale-index\/delete))?$/
  );
  if (!match) return false;

  try {
    requireAllowedOrigin(request, origin, allowedOrigins);
    const repository = await repositoryStore.get(match[1], match[2]);
    if (!repository) {
      sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
      return true;
    }
    const permission = request.method === "GET" ? "repository.read" as const : "repository.manage" as const;
    const authorization = await authorizeKoshRepositoryRequest(request, repository, permission);
    if (!authorization.identity || !authorization.decision.allowed) {
      sendJson(
        response,
        authorization.identity ? 403 : 401,
        { error: authorization.identity ? "repository_permission_denied" : "authentication_required" },
        origin,
        allowedOrigins
      );
      return true;
    }
    await Promise.all([platformStore.ready(), objectIndex.ready()]);

    if (request.method === "GET" && !match[3]) {
      sendJson(response, 200, await reconcileKoshStorage(repository), origin, allowedOrigins);
      return true;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "method_not_allowed" }, origin, allowedOrigins);
      return true;
    }

    const actor = {
      id: authorization.identity.user.id,
      displayName: authorization.identity.user.displayName
    };
    const body = await readJson(request);
    const result = match[3] === "orphans/delete"
      ? await deleteOrphans(repository, actor, body)
      : match[3] === "stale-index/delete"
        ? await deleteStaleIndexes(repository, actor, body)
        : await migrate(repository, actor, body);
    sendJson(response, 200, result, origin, allowedOrigins);
    return true;
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "storage_reconciliation_failed" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
