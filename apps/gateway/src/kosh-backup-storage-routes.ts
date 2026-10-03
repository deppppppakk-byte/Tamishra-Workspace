import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import {
  deleteKoshObject,
  koshObjectStorageBackend,
  materializeKoshObject,
  putKoshObjectFromFile,
  type KoshObjectLocator
} from "./kosh-object-storage.js";
import {
  getKoshPlatformStore,
  type StoredKoshPlatformResource
} from "./kosh-platform-store.js";
import {
  finalizeKoshStorageReservation,
  reserveKoshStorageCapacity
} from "./kosh-storage-reservations.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const objectIndex = getKoshObjectIndex();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");
const backupRoot = resolve(process.env.KOSH_BACKUP_ROOT?.trim() || ".kosh/backups");

const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type JsonBody = Record<string, unknown>;
type BackupContext = {
  backup: StoredKoshPlatformResource;
  filename: string;
  logicalId: string | null;
  locator: KoshObjectLocator | null;
  localPath: string;
};

type Actor = {
  id: string;
  displayName: string;
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

async function readJson(
  request: IncomingMessage,
  maxBytes = 32 * 1024
): Promise<JsonBody> {
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
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.floor(number)))
    : fallback;
}

function safeStoragePath(root: string, ...segments: string[]) {
  const cleaned = segments.map((value) => {
    const part = value.trim();
    if (
      !part ||
      part.length > 240 ||
      part === "." ||
      part === ".." ||
      part.includes("/") ||
      part.includes("\\") ||
      part.includes("\0")
    ) {
      throw Object.assign(new Error("invalid_storage_segment"), { status: 400 });
    }
    return part;
  });
  const path = resolve(root, ...cleaned);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_storage_path"), { status: 400 });
  }
  return path;
}

function repositoryPath(repository: StoredKoshRepository) {
  return safeStoragePath(
    repositoryRoot,
    repository.namespace,
    repository.slug + ".git"
  );
}

function restoreStagePath(repository: StoredKoshRepository, backupId: string) {
  return safeStoragePath(
    repositoryRoot,
    repository.namespace,
    repository.slug + ".restore-" + backupId + ".git"
  );
}

function backupDirectory(repository: StoredKoshRepository) {
  return safeStoragePath(backupRoot, repository.id);
}

function temporaryBackupPath(
  repository: StoredKoshRepository,
  filename: string,
  purpose: string
) {
  const stem = filename.endsWith(".bundle")
    ? filename.slice(0, -7)
    : filename;
  const value =
    stem.slice(0, 150) +
    "." +
    purpose.slice(0, 30) +
    "." +
    randomUUID().slice(0, 8) +
    ".bundle";
  return safeStoragePath(backupDirectory(repository), value);
}

async function git(args: string[], cwd?: string, maxBuffer = 4 * 1024 * 1024) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      timeout: 120_000,
      maxBuffer,
      encoding: "utf8"
    });
    return String(result.stdout || result.stderr || "");
  } catch (error) {
    const value = error as { stderr?: string; stdout?: string };
    throw Object.assign(
      new Error(String(value.stderr || value.stdout || "git_command_failed").trim()),
      { status: 409 }
    );
  }
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

function maxBackupBytes() {
  const mb = boundedNumber(process.env.KOSH_BACKUP_MAX_MB, 2048, 16, 16_384);
  return mb * 1024 * 1024;
}

async function globalSetting(key: string) {
  const settings = await platformStore.listResources("admin_setting", null);
  return settings.find((item) => item.key === key)?.payload.value ?? null;
}

async function audit(
  repositoryId: string,
  actor: Actor,
  eventType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {}
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType: "backup",
    resourceId,
    metadata
  });
}

async function authorize(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository,
  permission: "repository.read" | "repository.manage",
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const result = await authorizeKoshRepositoryRequest(
    request,
    repository,
    permission
  );
  if (!result.decision.allowed || !result.identity) {
    sendJson(
      response,
      result.identity ? 403 : 401,
      {
        error: result.identity
          ? "repository_permission_denied"
          : "authentication_required",
        permission,
        role: result.decision.role
      },
      origin,
      allowedOrigins
    );
    return null;
  }
  return result.identity;
}

function requireAllowedOrigin(
  request: IncomingMessage,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (
    mutatingMethods.has(request.method ?? "") &&
    origin &&
    !allowedOrigins.has(origin)
  ) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

async function resolveBackup(
  repository: StoredKoshRepository,
  id: string
): Promise<BackupContext> {
  await objectIndex.ready();
  const backup = await platformStore.getResource(id);
  if (!backup || backup.repositoryId !== repository.id || backup.type !== "backup") {
    throw Object.assign(new Error("backup_not_found"), { status: 404 });
  }
  const filename = clean(backup.payload.filename, 240);
  if (!filename) {
    throw Object.assign(new Error("backup_file_missing"), { status: 409 });
  }
  const localPath = safeStoragePath(backupRoot, repository.id, filename);
  const logicalId = clean(backup.payload.storageLogicalId, 240) || null;
  const indexed = logicalId
    ? await objectIndex.get(repository.id, "backup", logicalId)
    : await objectIndex.get(repository.id, "backup", backup.id);
  return {
    backup,
    filename,
    logicalId,
    locator: indexed?.locator ?? null,
    localPath
  };
}

async function materializeBackup(
  repository: StoredKoshRepository,
  context: BackupContext,
  purpose: string
) {
  if (!context.locator || context.locator.backend === "local") {
    const info = await stat(context.localPath).catch(() => null);
    if (!info) {
      throw Object.assign(new Error("backup_file_missing"), { status: 404 });
    }
    return { path: context.localPath, temporary: false };
  }
  const path = temporaryBackupPath(repository, context.filename, purpose);
  await mkdir(backupDirectory(repository), { recursive: true });
  await materializeKoshObject(context.locator, "", path);
  return { path, temporary: true };
}

async function pruneBackups(repository: StoredKoshRepository) {
  const keep = boundedNumber(
    await globalSetting("backup_keep_count"),
    30,
    3,
    200
  );
  const backups = (await platformStore.listResources("backup", repository.id))
    .filter((item) => item.payload.kind === "git-bundle" || !item.payload.kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  for (const backup of backups.slice(keep)) {
    const filename = clean(backup.payload.filename, 240);
    const logicalId = clean(backup.payload.storageLogicalId, 240) || null;
    const localPath = filename
      ? safeStoragePath(backupRoot, repository.id, filename)
      : "";
    const indexed = logicalId
      ? await objectIndex.get(repository.id, "backup", logicalId)
      : await objectIndex.get(repository.id, "backup", backup.id);

    try {
      if (indexed) {
        await deleteKoshObject(indexed.locator, localPath);
        await objectIndex.delete(
          repository.id,
          "backup",
          logicalId || backup.id
        );
      } else if (localPath) {
        await rm(localPath, { force: true });
      }
      await platformStore.deleteResource(backup.id);
    } catch (error) {
      console.error("Kosh backup retention prune failed", {
        repositoryId: repository.id,
        backupId: backup.id,
        error
      });
    }
  }
}

async function createBackup(
  repository: StoredKoshRepository,
  actor: Actor,
  reason = "manual"
) {
  await Promise.all([platformStore.ready(), objectIndex.ready()]);
  const directory = backupDirectory(repository);
  await mkdir(directory, { recursive: true });
  const key =
    "repo-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    randomUUID().slice(0, 8);
  const filename = key + ".bundle";
  const path = safeStoragePath(directory, filename);

  await git([
    "--git-dir",
    repositoryPath(repository),
    "bundle",
    "create",
    path,
    "--all"
  ]);

  const info = await stat(path);
  if (info.size > maxBackupBytes()) {
    await rm(path, { force: true }).catch(() => undefined);
    throw Object.assign(new Error("backup_size_limit_exceeded"), { status: 413 });
  }
  const checksum = await hashFile(path);
  const reservation = await reserveKoshStorageCapacity(
    repository.id,
    "backup",
    info.size
  );

  let locator: KoshObjectLocator | null = null;
  let indexed = false;
  let resource: StoredKoshPlatformResource | null = null;
  try {
    if (koshObjectStorageBackend() === "google-drive") {
      locator = await putKoshObjectFromFile({
        storageClass: "backup",
        repositoryId: repository.id,
        logicalId: key,
        filename,
        mediaType: "application/x-git-bundle",
        sourcePath: path,
        sizeBytes: info.size,
        sha256: checksum,
        localPath: path
      });
    }

    resource = await platformStore.createResource({
      repositoryId: repository.id,
      namespace: repository.namespace,
      type: "backup",
      key,
      name: "Repository restore point " + new Date().toISOString(),
      state: "ready",
      payload: {
        kind: "git-bundle",
        filename,
        sizeBytes: info.size,
        sha256: checksum,
        reason,
        storageBackend: locator?.backend ?? "local",
        storageLogicalId: locator ? key : null
      },
      createdByUserId: actor.id,
      createdByName: actor.displayName
    });

    if (locator) {
      await objectIndex.put({
        repositoryId: repository.id,
        storageClass: "backup",
        logicalId: key,
        locator
      });
      indexed = true;
      await rm(path, { force: true }).catch(() => undefined);
    }

    await finalizeKoshStorageReservation(reservation.id, "completed");
    await audit(
      repository.id,
      actor,
      "recovery_backup_created",
      resource.id,
      {
        filename,
        sizeBytes: info.size,
        sha256: checksum,
        reason,
        storageBackend: locator?.backend ?? "local"
      }
    ).catch((error) => {
      console.error("Kosh backup audit failed", error);
    });
    await pruneBackups(repository);
    return resource;
  } catch (error) {
    await finalizeKoshStorageReservation(reservation.id, "aborted").catch(() => undefined);
    if (resource) {
      await platformStore.deleteResource(resource.id).catch(() => false);
    }
    if (indexed) {
      await objectIndex.delete(repository.id, "backup", key).catch(() => false);
    }
    if (locator) {
      await deleteKoshObject(locator, path).catch(() => undefined);
    }
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function verifyBackup(
  repository: StoredKoshRepository,
  id: string
) {
  const context = await resolveBackup(repository, id);
  const materialized = await materializeBackup(repository, context, "verify");
  try {
    const info = await stat(materialized.path).catch(() => null);
    if (!info) {
      throw Object.assign(new Error("backup_file_missing"), { status: 404 });
    }
    const checksum = await hashFile(materialized.path);
    const expected = clean(context.backup.payload.sha256, 128);
    let bundleValid = true;
    let verification = "";
    try {
      verification = await git([
        "--git-dir",
        repositoryPath(repository),
        "bundle",
        "verify",
        materialized.path
      ]);
    } catch (error) {
      bundleValid = false;
      verification = error instanceof Error
        ? error.message
        : "bundle_verify_failed";
    }
    const valid =
      bundleValid &&
      checksum === expected &&
      info.size === Number(context.backup.payload.sizeBytes);
    const updated = await platformStore.updateResource(context.backup.id, {
      state: valid ? "ready" : "invalid",
      payload: {
        ...context.backup.payload,
        lastVerifiedAt: new Date().toISOString(),
        verificationValid: valid,
        verificationBackend: context.locator?.backend ?? "local"
      }
    });
    return {
      valid,
      bundleValid,
      checksumValid: checksum === expected,
      sizeValid: info.size === Number(context.backup.payload.sizeBytes),
      sizeBytes: info.size,
      sha256: checksum,
      verification,
      storageBackend: context.locator?.backend ?? "local",
      backup: updated
    };
  } finally {
    if (materialized.temporary) {
      await rm(materialized.path, { force: true }).catch(() => undefined);
    }
  }
}

async function stageBackup(repository: StoredKoshRepository, id: string) {
  const verification = await verifyBackup(repository, id);
  if (!verification.valid) {
    throw Object.assign(new Error("backup_verification_failed"), { status: 409 });
  }
  const context = await resolveBackup(repository, id);
  const materialized = await materializeBackup(repository, context, "stage");
  const stagePath = restoreStagePath(repository, id);
  try {
    await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
    await git(["clone", "--bare", materialized.path, stagePath]);
    await git(["--git-dir", stagePath, "fsck", "--full"]);
    const current = repositoryPath(repository);
    await cp(resolve(current, "hooks"), resolve(stagePath, "hooks"), {
      recursive: true,
      force: true
    }).catch(() => undefined);
    for (const name of ["kosh-protected-refs", "kosh-release-tags"]) {
      await cp(resolve(current, name), resolve(stagePath, name), { force: true })
        .catch(() => undefined);
    }
    const updated = await platformStore.updateResource(context.backup.id, {
      payload: {
        ...context.backup.payload,
        stagedAt: new Date().toISOString(),
        staged: true
      }
    });
    return { staged: true, backup: updated };
  } finally {
    if (materialized.temporary) {
      await rm(materialized.path, { force: true }).catch(() => undefined);
    }
  }
}

async function activateStagedBackup(
  repository: StoredKoshRepository,
  id: string,
  actor: Actor,
  confirmation: string
) {
  if (confirmation !== repository.namespace + "/" + repository.slug) {
    throw Object.assign(new Error("restore_confirmation_mismatch"), { status: 400 });
  }
  const context = await resolveBackup(repository, id);
  if (context.backup.payload.staged !== true) {
    throw Object.assign(new Error("backup_must_be_staged_first"), { status: 409 });
  }
  const stagePath = restoreStagePath(repository, id);
  const staged = await stat(stagePath).catch(() => null);
  if (!staged) {
    throw Object.assign(new Error("staged_restore_missing"), { status: 409 });
  }
  await git(["--git-dir", stagePath, "fsck", "--full"]);

  const safety = await createBackup(repository, actor, "pre_restore_safety");
  const current = repositoryPath(repository);
  const oldPath = safeStoragePath(
    repositoryRoot,
    repository.namespace,
    repository.slug + ".pre-restore-" + randomUUID() + ".git"
  );
  await rename(current, oldPath);
  try {
    await rename(stagePath, current);
  } catch (error) {
    await rename(oldPath, current).catch(() => undefined);
    throw error;
  }
  await rm(oldPath, { recursive: true, force: true }).catch(() => undefined);
  const updated = await platformStore.updateResource(context.backup.id, {
    state: "restored",
    payload: {
      ...context.backup.payload,
      staged: false,
      restoredAt: new Date().toISOString(),
      safetyBackupId: safety.id
    }
  });
  await audit(
    repository.id,
    actor,
    "recovery_restore_activated",
    id,
    { safetyBackupId: safety.id }
  );
  return { restored: true, backup: updated, safetyBackup: safety };
}

async function downloadBackup(
  response: ServerResponse,
  repository: StoredKoshRepository,
  id: string,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const verification = await verifyBackup(repository, id);
  if (!verification.valid) {
    throw Object.assign(new Error("backup_verification_failed"), { status: 409 });
  }
  const context = await resolveBackup(repository, id);
  const materialized = await materializeBackup(repository, context, "download");
  try {
    const bytes = await readFile(materialized.path);
    response.statusCode = 200;
    response.setHeader("content-type", "application/x-git-bundle");
    response.setHeader("content-length", String(bytes.length));
    response.setHeader(
      "content-disposition",
      'attachment; filename="' + context.filename.replace(/["\r\n]/g, "_") + '"'
    );
    response.setHeader("x-kosh-sha256", String(context.backup.payload.sha256 ?? ""));
    response.setHeader("cache-control", "private, no-store");
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("vary", "origin");
    }
    response.end(bytes);
  } finally {
    if (materialized.temporary) {
      await rm(materialized.path, { force: true }).catch(() => undefined);
    }
  }
}

function routeError(
  response: ServerResponse,
  error: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
  sendJson(
    response,
    status,
    { error: error instanceof Error ? error.message : "kosh_backup_error" },
    origin,
    allowedOrigins
  );
}

export async function handleKoshBackupStorageRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems\/recovery(?:\/(.*))?$/
  );
  if (!match) return false;

  const namespace = match[1];
  const slug = match[2];
  const tail = match[3] ?? "";
  const repository = await repositoryStore.get(namespace, slug);
  if (!repository) {
    sendJson(response, 404, { error: "repository_not_found" }, origin, allowedOrigins);
    return true;
  }

  try {
    requireAllowedOrigin(request, origin, allowedOrigins);
    await Promise.all([platformStore.ready(), objectIndex.ready()]);

    if (request.method === "POST" && tail === "backups") {
      const identity = await authorize(
        request,
        response,
        repository,
        "repository.manage",
        origin,
        allowedOrigins
      );
      if (!identity) return true;
      const body = await readJson(request);
      const backup = await createBackup(
        repository,
        identity.user,
        clean(body.reason, 200) || "manual"
      );
      sendJson(response, 201, backup, origin, allowedOrigins);
      return true;
    }

    const actionMatch = tail.match(/^backups\/([^/]+)\/(verify|stage|activate|download)$/);
    if (!actionMatch) return false;
    const id = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];

    if (request.method === "GET" && action === "download") {
      const identity = await authorize(
        request,
        response,
        repository,
        "repository.read",
        origin,
        allowedOrigins
      );
      if (!identity) return true;
      await downloadBackup(response, repository, id, origin, allowedOrigins);
      return true;
    }

    if (request.method !== "POST" || action === "download") return false;

    const identity = await authorize(
      request,
      response,
      repository,
      "repository.manage",
      origin,
      allowedOrigins
    );
    if (!identity) return true;

    if (action === "verify") {
      const result = await verifyBackup(repository, id);
      await audit(
        repository.id,
        identity.user,
        "recovery_backup_verified",
        id,
        { valid: result.valid, storageBackend: result.storageBackend }
      ).catch(() => undefined);
      sendJson(response, 200, result, origin, allowedOrigins);
      return true;
    }

    if (action === "stage") {
      const result = await stageBackup(repository, id);
      await audit(
        repository.id,
        identity.user,
        "recovery_restore_staged",
        id
      ).catch(() => undefined);
      sendJson(response, 200, result, origin, allowedOrigins);
      return true;
    }

    const body = await readJson(request);
    const result = await activateStagedBackup(
      repository,
      id,
      identity.user,
      clean(body.confirm, 200)
    );
    sendJson(response, 200, result, origin, allowedOrigins);
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
