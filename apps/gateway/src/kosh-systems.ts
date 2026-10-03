import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { automationStore } from "./kosh-automation-service.js";
import { getKoshPackageStore } from "./kosh-package-store.js";
import {
  getKoshPlatformStore,
  type StoredKoshPlatformResource
} from "./kosh-platform-store.js";
import { getKoshReleaseStore } from "./kosh-release-store.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const automationStore = automationStore();
const packageStore = getKoshPackageStore();
const releaseStore = getKoshReleaseStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");
const backupRoot = resolve(process.env.KOSH_BACKUP_ROOT?.trim() || ".kosh/backups");

const mutatingMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const extensionCapabilities = new Set([
  "asset-preview",
  "automation-step",
  "code-intelligence",
  "deployment-gate",
  "project-panel",
  "storage-adapter",
  "webhook-transform"
]);
const extensionPermissions = new Set([
  "network.egress",
  "repository.manage",
  "repository.read",
  "repository.write",
  "storage.read",
  "storage.write"
]);
const adminSettingKeys = new Set([
  "backup_keep_count",
  "default_storage_quota_bytes",
  "extension_policy",
  "platform_notice"
]);

type JsonBody = Record<string, unknown>;
type RequestIdentity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  allowedOrigins?: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins?.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 256 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(bytes);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_json");
    }
    return parsed as JsonBody;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanStringArray(value: unknown, maxItems = 100, maxLength = 160) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((item) => clean(item, maxLength))
      .filter(Boolean)
  )].slice(0, maxItems);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(min, Math.min(max, Math.floor(number)))
    : fallback;
}

function validDate(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw Object.assign(new Error("invalid_date"), { status: 400 });
  }
  return date.toISOString();
}

function slug(value: unknown, maxLength = 100) {
  return clean(value, maxLength)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

async function hashFile(path: string) {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
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

function requireAllowedOrigin(
  request: IncomingMessage,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (mutatingMethods.has(request.method ?? "") && origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

function requirePlatformAdministrator(identity: RequestIdentity) {
  const configured = new Set(
    (process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const allowed =
    configured.size > 0
      ? configured.has(identity.user.id)
      : process.env.NODE_ENV !== "production" &&
        identity.memberships.some(
          (item) => item.membership.role === "owner" || item.membership.role === "admin"
        );
  if (!allowed) {
    throw Object.assign(new Error("platform_admin_required"), { status: 403 });
  }
}

async function audit(
  repositoryId: string | null,
  actor: { id: string; displayName: string },
  eventType: string,
  resourceType: string,
  resourceId: string | null,
  metadata: Record<string, unknown> = {}
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType,
    resourceId,
    metadata
  });
}

async function repositoryAuthorization(
  request: IncomingMessage,
  namespace: string,
  repositorySlug: string,
  permission:
    | "repository.read"
    | "repository.manage"
    | "repository.merge"
    | "releases.manage"
) {
  const repository = await repositoryStore.get(namespace, repositorySlug);
  if (!repository) {
    throw Object.assign(new Error("repository_not_found"), { status: 404 });
  }
  const authorization = await authorizeKoshRepositoryRequest(
    request,
    repository,
    permission
  );
  if (!authorization.identity || !authorization.decision.allowed) {
    throw Object.assign(
      new Error(
        authorization.identity
          ? "repository_permission_denied"
          : "authentication_required"
      ),
      { status: authorization.identity ? 403 : 401 }
    );
  }
  return { repository, identity: authorization.identity };
}

async function globalSetting(key: string) {
  const settings = await platformStore.listResources("admin_setting", null);
  const item = settings.find((candidate) => candidate.key === key);
  return item?.payload.value ?? null;
}

async function putGlobalSetting(
  key: string,
  value: unknown,
  identity: RequestIdentity
) {
  const settings = await platformStore.listResources("admin_setting", null);
  const existing = settings.find((candidate) => candidate.key === key);
  const payload = { kind: "setting", value };
  if (existing) {
    return platformStore.updateResource(existing.id, {
      state: "active",
      payload
    });
  }
  return platformStore.createResource({
    repositoryId: null,
    namespace: "kosh",
    type: "admin_setting",
    key,
    name: key.replace(/_/g, " "),
    state: "active",
    payload,
    createdByUserId: identity.user.id,
    createdByName: identity.user.displayName
  });
}

function projectKind(resource: StoredKoshPlatformResource) {
  return clean(resource.payload.kind, 40) || "project";
}

async function listProjects(repositoryId: string) {
  const resources = await platformStore.listResources("project_field", repositoryId);
  return {
    projects: resources.filter((item) => projectKind(item) === "project"),
    fields: resources.filter((item) => projectKind(item) === "field"),
    iterations: resources.filter((item) => projectKind(item) === "iteration"),
    items: resources.filter((item) => projectKind(item) === "item")
  };
}

async function requireProject(repositoryId: string, id: string) {
  const resource = await platformStore.getResource(id);
  if (
    !resource ||
    resource.repositoryId !== repositoryId ||
    resource.type !== "project_field" ||
    projectKind(resource) !== "project"
  ) {
    throw Object.assign(new Error("project_not_found"), { status: 404 });
  }
  return resource;
}

async function createProjectChild(
  repository: StoredKoshRepository,
  project: StoredKoshPlatformResource,
  identity: RequestIdentity,
  kind: "field" | "iteration" | "item",
  name: string,
  payload: Record<string, unknown>
) {
  const resource = await platformStore.createResource({
    repositoryId: repository.id,
    namespace: repository.namespace,
    type: "project_field",
    key: kind + ":" + project.id + ":" + randomUUID(),
    name,
    state: "active",
    payload: { kind, projectId: project.id, ...payload },
    createdByUserId: identity.user.id,
    createdByName: identity.user.displayName
  });
  await audit(
    repository.id,
    identity.user,
    "project_" + kind + "_created",
    "project_field",
    resource.id,
    { projectId: project.id }
  );
  return resource;
}

async function deploymentPolicy(repositoryId: string, environmentName: string) {
  const policies = await platformStore.listResources("deployment_policy", repositoryId);
  return policies.find(
    (item) =>
      item.payload.kind === "policy" &&
      String(item.payload.environmentName ?? "") === environmentName
  ) ?? null;
}

async function createDeploymentRequest(input: {
  repository: StoredKoshRepository;
  identity: RequestIdentity;
  environmentName: string;
  releaseId?: string | null;
  commitSha: string;
  refName: string;
  sourceDeploymentId?: string | null;
  reason?: string | null;
}) {
  const policy = await deploymentPolicy(input.repository.id, input.environmentName);
  const requiredApprovals = boundedNumber(
    policy?.payload.requiredApprovals,
    0,
    0,
    20
  );
  if (policy?.payload.freeze === true) {
    throw Object.assign(new Error("deployment_environment_frozen"), { status: 409 });
  }
  let environment = (await automationStore.listEnvironments(input.repository.id))
    .find((item) => item.name === input.environmentName);
  if (!environment) {
    environment = await automationStore.createEnvironment({
      repositoryId: input.repository.id,
      name: input.environmentName,
      requiredApprovals,
      protectedBranches: cleanStringArray(policy?.payload.protectedBranches, 100, 200)
    });
  }
  const resource = await platformStore.createResource({
    repositoryId: input.repository.id,
    namespace: input.repository.namespace,
    type: "deployment_policy",
    key: "request:" + randomUUID(),
    name: "Deploy " + input.refName + " to " + input.environmentName,
    state: requiredApprovals > 0 ? "pending_approval" : "ready",
    payload: {
      kind: "request",
      environmentId: environment.id,
      environmentName: environment.name,
      releaseId: input.releaseId ?? null,
      commitSha: input.commitSha,
      refName: input.refName,
      sourceDeploymentId: input.sourceDeploymentId ?? null,
      reason: input.reason ?? null,
      requiredApprovals,
      approvals: [],
      requestedAt: new Date().toISOString()
    },
    createdByUserId: input.identity.user.id,
    createdByName: input.identity.user.displayName
  });
  await audit(
    input.repository.id,
    input.identity.user,
    "deployment_requested",
    "deployment_policy",
    resource.id,
    {
      environmentName: input.environmentName,
      commitSha: input.commitSha,
      releaseId: input.releaseId ?? null
    }
  );
  return resource;
}

async function storageUsage(repositoryId: string) {
  const [packages, releases, runs, backups] = await Promise.all([
    packageStore.listVersions(repositoryId),
    releaseStore.listReleases(repositoryId),
    automationStore.listRuns(repositoryId, 100),
    platformStore.listResources("backup", repositoryId)
  ]);
  const releaseAssets = (
    await Promise.all(releases.slice(0, 200).map((release) => releaseStore.listAssets(release.id)))
  ).flat();
  const artifacts = (
    await Promise.all(runs.map((run) => automationStore.listArtifacts(run.id)))
  ).flat();
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const packageBytes = sum(packages.map((item) => item.sizeBytes));
  const releaseBytes = sum(releaseAssets.map((item) => item.sizeBytes));
  const artifactBytes = sum(artifacts.map((item) => item.sizeBytes));
  const backupBytes = sum(
    backups
      .filter((item) => item.payload.kind === "git-bundle" || !item.payload.kind)
      .map((item) => Number(item.payload.sizeBytes) || 0)
  );
  return {
    packageBytes,
    releaseBytes,
    artifactBytes,
    backupBytes,
    knownBytes: packageBytes + releaseBytes + artifactBytes + backupBytes,
    packageVersions: packages.length,
    releaseAssets: releaseAssets.length,
    artifacts: artifacts.length,
    backups: backups.length,
    lfsBytes: null
  };
}

async function currentStoragePolicy(repository: StoredKoshRepository) {
  const policies = await platformStore.listResources("storage_policy", repository.id);
  return policies.find((item) => item.key === "default") ?? null;
}

function maxBackupBytes() {
  const mb = boundedNumber(process.env.KOSH_BACKUP_MAX_MB, 2048, 16, 16_384);
  return mb * 1024 * 1024;
}

async function createBackup(
  repository: StoredKoshRepository,
  identity: RequestIdentity,
  reason = "manual"
) {
  const directory = safeStoragePath(backupRoot, repository.id);
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
  const resource = await platformStore.createResource({
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
      reason
    },
    createdByUserId: identity.user.id,
    createdByName: identity.user.displayName
  });
  await audit(
    repository.id,
    identity.user,
    "recovery_backup_created",
    "backup",
    resource.id,
    { filename, sizeBytes: info.size, sha256: checksum, reason }
  );
  await pruneBackups(repository);
  return resource;
}

async function pruneBackups(repository: StoredKoshRepository) {
  const configured = await globalSetting("backup_keep_count");
  const keep = boundedNumber(configured, 30, 3, 200);
  const backups = (await platformStore.listResources("backup", repository.id))
    .filter((item) => item.payload.kind === "git-bundle" || !item.payload.kind)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const backup of backups.slice(keep)) {
    const filename = clean(backup.payload.filename, 240);
    if (filename) {
      const path = safeStoragePath(backupRoot, repository.id, filename);
      await rm(path, { force: true }).catch(() => undefined);
    }
    await platformStore.deleteResource(backup.id).catch(() => false);
  }
}

async function requireBackup(repository: StoredKoshRepository, id: string) {
  const backup = await platformStore.getResource(id);
  if (!backup || backup.repositoryId !== repository.id || backup.type !== "backup") {
    throw Object.assign(new Error("backup_not_found"), { status: 404 });
  }
  const filename = clean(backup.payload.filename, 240);
  if (!filename) {
    throw Object.assign(new Error("backup_file_missing"), { status: 409 });
  }
  return {
    backup,
    filename,
    path: safeStoragePath(backupRoot, repository.id, filename)
  };
}

async function verifyBackup(repository: StoredKoshRepository, id: string) {
  const value = await requireBackup(repository, id);
  const info = await stat(value.path).catch(() => null);
  if (!info) {
    throw Object.assign(new Error("backup_file_missing"), { status: 404 });
  }
  const checksum = await hashFile(value.path);
  const expected = clean(value.backup.payload.sha256, 128);
  let bundleValid = true;
  let verification = "";
  try {
    verification = await git([
      "--git-dir",
      repositoryPath(repository),
      "bundle",
      "verify",
      value.path
    ]);
  } catch (error) {
    bundleValid = false;
    verification = error instanceof Error ? error.message : "bundle_verify_failed";
  }
  const valid = bundleValid && checksum === expected;
  const updated = await platformStore.updateResource(value.backup.id, {
    state: valid ? "ready" : "invalid",
    payload: {
      ...value.backup.payload,
      lastVerifiedAt: new Date().toISOString(),
      verificationValid: valid
    }
  });
  return {
    valid,
    bundleValid,
    checksumValid: checksum === expected,
    sizeBytes: info.size,
    sha256: checksum,
    verification,
    backup: updated
  };
}

function restoreStagePath(repository: StoredKoshRepository, backupId: string) {
  return safeStoragePath(
    repositoryRoot,
    repository.namespace,
    repository.slug + ".restore-" + backupId + ".git"
  );
}

async function stageBackup(repository: StoredKoshRepository, id: string) {
  const verification = await verifyBackup(repository, id);
  if (!verification.valid) {
    throw Object.assign(new Error("backup_verification_failed"), { status: 409 });
  }
  const value = await requireBackup(repository, id);
  const stagePath = restoreStagePath(repository, id);
  await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
  await git(["clone", "--bare", value.path, stagePath]);
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
  const updated = await platformStore.updateResource(value.backup.id, {
    payload: {
      ...value.backup.payload,
      stagedAt: new Date().toISOString(),
      staged: true
    }
  });
  return { staged: true, backup: updated };
}

async function activateStagedBackup(
  repository: StoredKoshRepository,
  id: string,
  identity: RequestIdentity,
  confirmation: string
) {
  if (confirmation !== repository.namespace + "/" + repository.slug) {
    throw Object.assign(new Error("restore_confirmation_mismatch"), { status: 400 });
  }
  const value = await requireBackup(repository, id);
  if (value.backup.payload.staged !== true) {
    throw Object.assign(new Error("backup_must_be_staged_first"), { status: 409 });
  }
  const stagePath = restoreStagePath(repository, id);
  const staged = await stat(stagePath).catch(() => null);
  if (!staged) {
    throw Object.assign(new Error("staged_restore_missing"), { status: 409 });
  }
  await git(["--git-dir", stagePath, "fsck", "--full"]);
  const safety = await createBackup(repository, identity, "pre_restore_safety");
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
  const updated = await platformStore.updateResource(value.backup.id, {
    state: "restored",
    payload: {
      ...value.backup.payload,
      staged: false,
      restoredAt: new Date().toISOString(),
      safetyBackupId: safety.id
    }
  });
  await audit(
    repository.id,
    identity.user,
    "recovery_restore_activated",
    "backup",
    id,
    { safetyBackupId: safety.id }
  );
  return { restored: true, backup: updated, safetyBackup: safety };
}

function validateExtensionManifest(value: unknown) {
  const input = safeObject(value);
  const id = clean(input.id, 100).toLowerCase();
  const name = clean(input.name, 160);
  const version = clean(input.version, 80);
  const description = clean(input.description, 1000);
  const runtime = clean(input.runtime, 40) || "declarative";
  if (!/^[a-z][a-z0-9._-]{1,99}$/.test(id) || !name) {
    throw Object.assign(new Error("invalid_extension_identity"), { status: 400 });
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
    throw Object.assign(new Error("invalid_extension_version"), { status: 400 });
  }
  if (runtime !== "declarative") {
    throw Object.assign(new Error("extension_runtime_not_supported"), { status: 400 });
  }
  const capabilities = cleanStringArray(input.capabilities, 32, 80);
  const permissions = cleanStringArray(input.permissions, 32, 80);
  if (capabilities.some((item) => !extensionCapabilities.has(item))) {
    throw Object.assign(new Error("invalid_extension_capability"), { status: 400 });
  }
  if (permissions.some((item) => !extensionPermissions.has(item))) {
    throw Object.assign(new Error("invalid_extension_permission"), { status: 400 });
  }
  return {
    schemaVersion: 1,
    id,
    name,
    version,
    description,
    runtime,
    entrypoint: clean(input.entrypoint, 240) || null,
    capabilities,
    permissions,
    assetKinds: cleanStringArray(input.assetKinds, 64, 100),
    homepage: clean(input.homepage, 500) || null
  };
}

async function handleRepositorySystems(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/systems(?:\/(.*))?$/
  );
  if (!match) return false;
  const namespace = match[1];
  const repositorySlug = match[2];
  const tail = "/" + (match[3] ?? "").replace(/^\/+/, "");
  requireAllowedOrigin(request, origin, allowedOrigins);

  const defaultPermission = request.method === "GET"
    ? "repository.read" as const
    : "repository.manage" as const;
  const permission = tail.startsWith("/merge-queue")
    ? (request.method === "GET" ? "repository.read" as const : "repository.merge" as const)
    : tail.startsWith("/deployments")
      ? (request.method === "GET" ? "repository.read" as const : "releases.manage" as const)
      : defaultPermission;
  const { repository, identity } = await repositoryAuthorization(
    request,
    namespace,
    repositorySlug,
    permission
  );
  await platformStore.ready();
  await automationStore.ready();

  if (tail === "/" && request.method === "GET") {
    const [projects, mergeQueue, storage, backups, auditEvents] = await Promise.all([
      listProjects(repository.id),
      platformStore.listResources("merge_queue_entry", repository.id),
      currentStoragePolicy(repository),
      platformStore.listResources("backup", repository.id),
      platformStore.listAudit(repository.id, 50)
    ]);
    sendJson(response, 200, {
      repository: { id: repository.id, namespace, slug: repository.slug },
      modules: {
        mergeQueue: { entries: mergeQueue.length },
        projects: { projects: projects.projects.length, items: projects.items.length },
        storage: { configured: Boolean(storage) },
        recovery: { restorePoints: backups.length },
        observability: { recentAuditEvents: auditEvents.length }
      }
    }, origin, allowedOrigins);
    return true;
  }

  if (tail === "/merge-queue" && request.method === "GET") {
    const entries = (await platformStore.listResources("merge_queue_entry", repository.id))
      .sort((a, b) => {
        const priority = Number(b.payload.priority ?? 0) - Number(a.payload.priority ?? 0);
        return priority || a.createdAt.localeCompare(b.createdAt);
      });
    sendJson(response, 200, {
      entries,
      counts: Object.fromEntries(
        ["queued", "blocked", "processing", "merged", "cancelled", "failed"].map(
          (state) => [state, entries.filter((item) => item.state === state).length]
        )
      ),
      processEndpoint: `/v1/kosh/repos/${namespace}/${repository.slug}/merge-queue/process`
    }, origin, allowedOrigins);
    return true;
  }

  const queueMatch = tail.match(/^\/merge-queue\/([^/]+)$/);
  if (queueMatch && request.method === "PATCH") {
    const entry = await platformStore.getResource(decodeURIComponent(queueMatch[1]));
    if (!entry || entry.repositoryId !== repository.id || entry.type !== "merge_queue_entry") {
      throw Object.assign(new Error("merge_queue_entry_not_found"), { status: 404 });
    }
    if (["merged", "processing"].includes(entry.state)) {
      throw Object.assign(new Error("merge_queue_entry_locked"), { status: 409 });
    }
    const body = await readJson(request, 64 * 1024);
    const action = clean(body.action, 40);
    const nextState = action === "cancel"
      ? "cancelled"
      : action === "resume"
        ? "queued"
        : action === "pause"
          ? "blocked"
          : entry.state;
    const priority = body.priority === undefined
      ? Number(entry.payload.priority ?? 0)
      : boundedNumber(body.priority, 0, -1000, 1000);
    const updated = await platformStore.updateResource(entry.id, {
      state: nextState,
      payload: { ...entry.payload, priority, updatedByUserId: identity.user.id }
    });
    await audit(repository.id, identity.user, "merge_queue_entry_updated", "merge_queue_entry", entry.id, {
      action: action || "priority",
      priority,
      state: nextState
    });
    sendJson(response, 200, updated, origin, allowedOrigins);
    return true;
  }

  if (tail === "/projects" && request.method === "GET") {
    sendJson(response, 200, await listProjects(repository.id), origin, allowedOrigins);
    return true;
  }

  if (tail === "/projects" && request.method === "POST") {
    const body = await readJson(request);
    const name = clean(body.name, 180);
    if (!name) {
      throw Object.assign(new Error("project_name_required"), { status: 400 });
    }
    const project = await platformStore.createResource({
      repositoryId: repository.id,
      namespace: repository.namespace,
      type: "project_field",
      key: "project:" + (slug(name) || randomUUID()) + ":" + randomUUID().slice(0, 8),
      name,
      state: clean(body.status, 40) || "active",
      payload: {
        kind: "project",
        description: clean(body.description, 4000),
        owner: clean(body.owner, 160) || null,
        startDate: validDate(body.startDate),
        dueDate: validDate(body.dueDate),
        roadmapOrder: boundedNumber(body.roadmapOrder, 0, -10000, 10000)
      },
      createdByUserId: identity.user.id,
      createdByName: identity.user.displayName
    });
    await audit(repository.id, identity.user, "project_created", "project_field", project.id);
    sendJson(response, 201, project, origin, allowedOrigins);
    return true;
  }

  const childMatch = tail.match(/^\/projects\/([^/]+)\/(fields|iterations|items)$/);
  if (childMatch && request.method === "POST") {
    const project = await requireProject(repository.id, decodeURIComponent(childMatch[1]));
    const body = await readJson(request);
    const kind = childMatch[2] === "fields"
      ? "field" as const
      : childMatch[2] === "iterations"
        ? "iteration" as const
        : "item" as const;
    let name = clean(body.name ?? body.title, 180);
    if (!name) {
      throw Object.assign(new Error("project_resource_name_required"), { status: 400 });
    }
    let payload: Record<string, unknown> = {};
    if (kind === "field") {
      const fieldType = ["text", "number", "date", "single_select", "multi_select", "boolean"]
        .includes(String(body.fieldType))
        ? String(body.fieldType)
        : "text";
      payload = {
        fieldType,
        required: body.required === true,
        options: cleanStringArray(body.options, 100, 120),
        order: boundedNumber(body.order, 0, -10000, 10000)
      };
    } else if (kind === "iteration") {
      payload = {
        startDate: validDate(body.startDate),
        endDate: validDate(body.endDate),
        goal: clean(body.goal, 2000),
        status: clean(body.status, 40) || "planned"
      };
    } else {
      const itemType = ["issue", "change_request", "note"].includes(String(body.itemType))
        ? String(body.itemType)
        : "note";
      payload = {
        itemType,
        reference: clean(body.reference, 240) || null,
        status: clean(body.status, 40) || "todo",
        iterationId: clean(body.iterationId, 160) || null,
        fields: safeObject(body.fields),
        order: boundedNumber(body.order, 0, -10000, 10000)
      };
    }
    const resource = await createProjectChild(
      repository,
      project,
      identity,
      kind,
      name,
      payload
    );
    sendJson(response, 201, resource, origin, allowedOrigins);
    return true;
  }

  const projectResourceMatch = tail.match(/^\/projects\/resources\/([^/]+)$/);
  if (projectResourceMatch && request.method === "PATCH") {
    const id = decodeURIComponent(projectResourceMatch[1]);
    const resource = await platformStore.getResource(id);
    if (!resource || resource.repositoryId !== repository.id || resource.type !== "project_field") {
      throw Object.assign(new Error("project_resource_not_found"), { status: 404 });
    }
    const body = await readJson(request);
    const payload = body.payload === undefined
      ? undefined
      : {
          ...resource.payload,
          ...safeObject(body.payload),
          kind: resource.payload.kind,
          projectId: resource.payload.projectId
        };
    const updated = await platformStore.updateResource(id, {
      name: body.name === undefined ? undefined : clean(body.name, 180) || resource.name,
      state: body.state === undefined ? undefined : clean(body.state, 40) || resource.state,
      payload
    });
    await audit(repository.id, identity.user, "project_resource_updated", "project_field", id);
    sendJson(response, 200, updated, origin, allowedOrigins);
    return true;
  }

  if (tail === "/deployments" && request.method === "GET") {
    const [resources, environments, deployments] = await Promise.all([
      platformStore.listResources("deployment_policy", repository.id),
      automationStore.listEnvironments(repository.id),
      automationStore.listDeployments(repository.id, 200)
    ]);
    sendJson(response, 200, {
      policies: resources.filter((item) => item.payload.kind === "policy"),
      requests: resources.filter((item) => item.payload.kind === "request"),
      environments,
      deployments
    }, origin, allowedOrigins);
    return true;
  }

  const policyMatch = tail.match(/^\/deployments\/policies\/([^/]+)$/);
  if (policyMatch && request.method === "PUT") {
    const environmentName = decodeURIComponent(policyMatch[1]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(environmentName)) {
      throw Object.assign(new Error("invalid_environment_name"), { status: 400 });
    }
    const body = await readJson(request, 64 * 1024);
    const requiredApprovals = boundedNumber(body.requiredApprovals, 0, 0, 20);
    const payload = {
      kind: "policy",
      environmentName,
      requiredApprovals,
      protectedBranches: cleanStringArray(body.protectedBranches, 100, 200),
      freeze: body.freeze === true,
      allowedChannels: cleanStringArray(body.allowedChannels, 50, 80),
      retentionDays: boundedNumber(body.retentionDays, 30, 1, 3650)
    };
    const existing = await deploymentPolicy(repository.id, environmentName);
    const policy = existing
      ? await platformStore.updateResource(existing.id, {
          name: "Deployment policy: " + environmentName,
          state: "active",
          payload
        })
      : await platformStore.createResource({
          repositoryId: repository.id,
          namespace: repository.namespace,
          type: "deployment_policy",
          key: "policy:" + environmentName,
          name: "Deployment policy: " + environmentName,
          state: "active",
          payload,
          createdByUserId: identity.user.id,
          createdByName: identity.user.displayName
        });
    const environment = (await automationStore.listEnvironments(repository.id))
      .find((item) => item.name === environmentName) ??
      await automationStore.createEnvironment({
        repositoryId: repository.id,
        name: environmentName,
        requiredApprovals,
        protectedBranches: payload.protectedBranches
      });
    await audit(repository.id, identity.user, "deployment_policy_updated", "deployment_policy", policy?.id ?? null, {
      environmentName,
      environmentId: environment.id
    });
    sendJson(response, existing ? 200 : 201, { policy, environment }, origin, allowedOrigins);
    return true;
  }

  if (tail === "/deployments/requests" && request.method === "POST") {
    const body = await readJson(request, 64 * 1024);
    const environmentName = clean(body.environmentName, 80);
    if (!environmentName) {
      throw Object.assign(new Error("environment_name_required"), { status: 400 });
    }
    const releaseId = clean(body.releaseId, 160) || null;
    let commitSha = clean(body.commitSha, 64);
    let refName = clean(body.refName, 240);
    if (releaseId) {
      const release = await releaseStore.getReleaseById(repository.id, releaseId);
      if (!release) {
        throw Object.assign(new Error("release_not_found"), { status: 404 });
      }
      if (release.state !== "published") {
        throw Object.assign(new Error("release_not_published"), { status: 409 });
      }
      commitSha = release.commitSha;
      refName = "refs/tags/" + release.tag;
    }
    if (!/^[0-9a-f]{40}$/i.test(commitSha) || !refName) {
      throw Object.assign(new Error("deployment_commit_and_ref_required"), { status: 400 });
    }
    const created = await createDeploymentRequest({
      repository,
      identity,
      environmentName,
      releaseId,
      commitSha,
      refName,
      reason: clean(body.reason, 1000) || null
    });
    sendJson(response, 201, created, origin, allowedOrigins);
    return true;
  }

  const approvalMatch = tail.match(/^\/deployments\/requests\/([^/]+)\/approve$/);
  if (approvalMatch && request.method === "POST") {
    const id = decodeURIComponent(approvalMatch[1]);
    const resource = await platformStore.getResource(id);
    if (!resource || resource.repositoryId !== repository.id || resource.type !== "deployment_policy" || resource.payload.kind !== "request") {
      throw Object.assign(new Error("deployment_request_not_found"), { status: 404 });
    }
    if (!["pending_approval", "ready"].includes(resource.state)) {
      throw Object.assign(new Error("deployment_request_not_approvable"), { status: 409 });
    }
    const approvals = Array.isArray(resource.payload.approvals)
      ? resource.payload.approvals.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
      : [];
    if (!approvals.some((item) => item.userId === identity.user.id)) {
      approvals.push({
        userId: identity.user.id,
        name: identity.user.displayName,
        approvedAt: new Date().toISOString()
      });
    }
    const required = boundedNumber(resource.payload.requiredApprovals, 0, 0, 20);
    const updated = await platformStore.updateResource(id, {
      state: approvals.length >= required ? "ready" : "pending_approval",
      payload: { ...resource.payload, approvals }
    });
    await audit(repository.id, identity.user, "deployment_request_approved", "deployment_policy", id, {
      approvals: approvals.length,
      required
    });
    sendJson(response, 200, updated, origin, allowedOrigins);
    return true;
  }

  const executeMatch = tail.match(/^\/deployments\/requests\/([^/]+)\/execute$/);
  if (executeMatch && request.method === "POST") {
    const id = decodeURIComponent(executeMatch[1]);
    const resource = await platformStore.getResource(id);
    if (!resource || resource.repositoryId !== repository.id || resource.type !== "deployment_policy" || resource.payload.kind !== "request") {
      throw Object.assign(new Error("deployment_request_not_found"), { status: 404 });
    }
    if (resource.state !== "ready") {
      throw Object.assign(new Error("deployment_request_not_ready"), { status: 409 });
    }
    const environmentId = clean(resource.payload.environmentId, 160);
    const environmentName = clean(resource.payload.environmentName, 80);
    const commitSha = clean(resource.payload.commitSha, 64);
    const refName = clean(resource.payload.refName, 240);
    const environment = (await automationStore.listEnvironments(repository.id))
      .find((item) => item.id === environmentId);
    if (!environment || !/^[0-9a-f]{40}$/i.test(commitSha) || !refName) {
      throw Object.assign(new Error("deployment_request_context_invalid"), { status: 409 });
    }
    const deployment = await automationStore.createDeployment({
      repositoryId: repository.id,
      environmentId: environment.id,
      environmentName,
      runId: null,
      refName,
      commitSha,
      status: "queued",
      url: null,
      actorUserId: identity.user.id,
      actorName: identity.user.displayName
    });
    const updated = await platformStore.updateResource(id, {
      state: "queued",
      payload: {
        ...resource.payload,
        deploymentId: deployment.id,
        executedAt: new Date().toISOString()
      }
    });
    await audit(repository.id, identity.user, "deployment_request_executed", "deployment_policy", id, {
      deploymentId: deployment.id
    });
    sendJson(response, 201, { request: updated, deployment }, origin, allowedOrigins);
    return true;
  }

  if ((tail === "/deployments/promote" || tail === "/deployments/rollback") && request.method === "POST") {
    const body = await readJson(request, 64 * 1024);
    const deploymentId = clean(body.deploymentId ?? body.targetDeploymentId, 160);
    const source = (await automationStore.listDeployments(repository.id, 500))
      .find((item) => item.id === deploymentId);
    if (!source) {
      throw Object.assign(new Error("deployment_not_found"), { status: 404 });
    }
    if (source.status !== "success") {
      throw Object.assign(new Error("deployment_must_be_successful"), { status: 409 });
    }
    const environmentName = tail.endsWith("promote")
      ? clean(body.targetEnvironmentName, 80)
      : clean(body.environmentName, 80) || source.environmentName;
    if (!environmentName) {
      throw Object.assign(new Error("environment_name_required"), { status: 400 });
    }
    const created = await createDeploymentRequest({
      repository,
      identity,
      environmentName,
      commitSha: source.commitSha,
      refName: source.refName,
      sourceDeploymentId: source.id,
      reason: tail.endsWith("promote") ? "promotion" : "rollback"
    });
    sendJson(response, 201, created, origin, allowedOrigins);
    return true;
  }

  if (tail === "/storage" && request.method === "GET") {
    const [policy, usage] = await Promise.all([
      currentStoragePolicy(repository),
      storageUsage(repository.id)
    ]);
    sendJson(response, 200, {
      policy,
      usage,
      adapter: "filesystem",
      roots: {
        git: "KOSH_REPO_ROOT",
        lfs: "KOSH_LFS_ROOT",
        artifacts: "KOSH_ARTIFACT_ROOT",
        packages: "KOSH_PACKAGE_ROOT",
        releases: "KOSH_RELEASE_ROOT",
        backups: "KOSH_BACKUP_ROOT"
      }
    }, origin, allowedOrigins);
    return true;
  }

  if (tail === "/storage/policy" && request.method === "PUT") {
    const body = await readJson(request, 64 * 1024);
    const fallbackQuota = boundedNumber(await globalSetting("default_storage_quota_bytes"), 50 * 1024 ** 3, 1024 ** 3, 10 * 1024 ** 4);
    const payload = {
      kind: "policy",
      adapter: "filesystem",
      maxTotalBytes: boundedNumber(body.maxTotalBytes, fallbackQuota, 1024 ** 3, 10 * 1024 ** 4),
      maxArtifactBytes: boundedNumber(body.maxArtifactBytes, 1024 ** 3, 1024 ** 2, 10 * 1024 ** 3),
      maxPackageBytes: boundedNumber(body.maxPackageBytes, 64 * 1024 ** 2, 1024 ** 2, 2 * 1024 ** 3),
      maxReleaseBytes: boundedNumber(body.maxReleaseBytes, 2 * 1024 ** 3, 1024 ** 2, 20 * 1024 ** 3),
      maxBackupBytes: boundedNumber(body.maxBackupBytes, maxBackupBytes(), 16 * 1024 ** 2, 16 * 1024 ** 3),
      retentionDays: boundedNumber(body.retentionDays, 90, 1, 3650)
    };
    const existing = await currentStoragePolicy(repository);
    const policy = existing
      ? await platformStore.updateResource(existing.id, { state: "active", payload })
      : await platformStore.createResource({
          repositoryId: repository.id,
          namespace: repository.namespace,
          type: "storage_policy",
          key: "default",
          name: "Repository storage policy",
          state: "active",
          payload,
          createdByUserId: identity.user.id,
          createdByName: identity.user.displayName
        });
    await audit(repository.id, identity.user, "storage_policy_updated", "storage_policy", policy?.id ?? null, payload);
    sendJson(response, existing ? 200 : 201, policy, origin, allowedOrigins);
    return true;
  }

  if (tail === "/recovery" && request.method === "GET") {
    const backups = (await platformStore.listResources("backup", repository.id))
      .filter((item) => item.payload.kind === "git-bundle" || !item.payload.kind);
    sendJson(response, 200, {
      backups,
      keepCount: boundedNumber(await globalSetting("backup_keep_count"), 30, 3, 200),
      staged: backups.filter((item) => item.payload.staged === true).length,
      verified: backups.filter((item) => item.payload.verificationValid === true).length
    }, origin, allowedOrigins);
    return true;
  }

  if (tail === "/recovery/backups" && request.method === "POST") {
    const body = await readJson(request, 32 * 1024);
    const backup = await createBackup(repository, identity, clean(body.reason, 200) || "manual");
    sendJson(response, 201, backup, origin, allowedOrigins);
    return true;
  }

  const recoveryMatch = tail.match(/^\/recovery\/backups\/([^/]+)\/(verify|stage|activate)$/);
  if (recoveryMatch && request.method === "POST") {
    const id = decodeURIComponent(recoveryMatch[1]);
    const action = recoveryMatch[2];
    let result: unknown;
    if (action === "verify") {
      result = await verifyBackup(repository, id);
      await audit(repository.id, identity.user, "recovery_backup_verified", "backup", id, {
        valid: (result as { valid: boolean }).valid
      });
    } else if (action === "stage") {
      result = await stageBackup(repository, id);
      await audit(repository.id, identity.user, "recovery_restore_staged", "backup", id);
    } else {
      const body = await readJson(request, 32 * 1024);
      result = await activateStagedBackup(
        repository,
        id,
        identity,
        clean(body.confirm, 200)
      );
    }
    sendJson(response, 200, result, origin, allowedOrigins);
    return true;
  }

  if (tail === "/observability" && request.method === "GET") {
    const [resources, auditEvents, runs, deployments, usage] = await Promise.all([
      platformStore.listResources(undefined, repository.id),
      platformStore.listAudit(repository.id, 200),
      automationStore.listRuns(repository.id, 200),
      automationStore.listDeployments(repository.id, 200),
      storageUsage(repository.id)
    ]);
    const resourceStates = Object.fromEntries(
      [...new Set(resources.map((item) => item.state))].map(
        (state) => [state, resources.filter((item) => item.state === state).length]
      )
    );
    const runStates = Object.fromEntries(
      ["queued", "running", "success", "failure", "cancelled"].map(
        (state) => [state, runs.filter((item) => item.status === state).length]
      )
    );
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      repository: { id: repository.id, namespace, slug: repository.slug },
      persistence: platformStore.kind,
      resources: { total: resources.length, states: resourceStates },
      automation: { runs: runStates, deployments: deployments.slice(0, 25) },
      storage: usage,
      recentAudit: auditEvents.slice(0, 50),
      recentFailures: [
        ...runs.filter((item) => item.status === "failure").slice(0, 20),
        ...resources.filter((item) => ["error", "failed", "invalid"].includes(item.state)).slice(0, 20)
      ]
    }, origin, allowedOrigins);
    return true;
  }

  return false;
}

async function handleGlobalSystems(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/kosh/systems/")) return false;
  requireAllowedOrigin(request, origin, allowedOrigins);
  const identity = await resolveKoshIdentity(request, request.method === "GET" ? "repo:read" : "repo:write");
  if (!identity) {
    throw Object.assign(new Error("authentication_required"), { status: 401 });
  }
  await platformStore.ready();

  if (url.pathname === "/v1/kosh/systems/observability" && request.method === "GET") {
    requirePlatformAdministrator(identity);
    const [repositories, resources, auditEvents] = await Promise.all([
      repositoryStore.list(),
      platformStore.listResources(),
      platformStore.listAudit(undefined, 500)
    ]);
    const resourceTypes = Object.fromEntries(
      [...new Set(resources.map((item) => item.type))].map(
        (type) => [type, resources.filter((item) => item.type === type).length]
      )
    );
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      repositories: repositories.length,
      persistence: platformStore.kind,
      resources: { total: resources.length, byType: resourceTypes },
      recentAudit: auditEvents.slice(0, 100),
      alerts: resources
        .filter((item) => ["error", "failed", "invalid", "blocked"].includes(item.state))
        .slice(0, 100)
    }, origin, allowedOrigins);
    return true;
  }

  if (url.pathname === "/v1/kosh/systems/admin" && request.method === "GET") {
    requirePlatformAdministrator(identity);
    const settings = await platformStore.listResources("admin_setting", null);
    sendJson(response, 200, {
      settings,
      allowedSettings: [...adminSettingKeys],
      runtime: {
        persistence: platformStore.kind,
        legacyAccessMode: process.env.KOSH_ACCESS_LEGACY_MODE || (process.env.NODE_ENV === "production" ? "deny" : "authenticated"),
        webhookPrivateNetworksBlocked: process.env.KOSH_WEBHOOK_BLOCK_PRIVATE_NETWORKS !== "false",
        securityScanOnPush: process.env.KOSH_SECURITY_SCAN_ON_PUSH !== "false",
        codeIndexOnPush: process.env.KOSH_CODE_INDEX_ON_PUSH !== "false",
        runnerNetworkEnabled: process.env.KOSH_RUNNER_ALLOW_NETWORK === "true"
      }
    }, origin, allowedOrigins);
    return true;
  }

  const adminSettingMatch = url.pathname.match(/^\/v1\/kosh\/systems\/admin\/settings\/([^/]+)$/);
  if (adminSettingMatch && request.method === "PUT") {
    requirePlatformAdministrator(identity);
    if (identity.authType !== "session") {
      throw Object.assign(new Error("interactive_session_required"), { status: 403 });
    }
    const key = decodeURIComponent(adminSettingMatch[1]);
    if (!adminSettingKeys.has(key)) {
      throw Object.assign(new Error("unsupported_admin_setting"), { status: 400 });
    }
    const body = await readJson(request, 32 * 1024);
    let value: unknown = body.value;
    if (key === "backup_keep_count") {
      value = boundedNumber(value, 30, 3, 200);
    } else if (key === "default_storage_quota_bytes") {
      value = boundedNumber(value, 50 * 1024 ** 3, 1024 ** 3, 10 * 1024 ** 4);
    } else if (key === "extension_policy") {
      value = ["enabled", "disabled"].includes(String(value)) ? String(value) : "enabled";
    } else {
      value = clean(value, 1000);
    }
    const setting = await putGlobalSetting(key, value, identity);
    await audit(null, identity.user, "platform_setting_updated", "admin_setting", setting?.id ?? null, { key });
    sendJson(response, 200, setting, origin, allowedOrigins);
    return true;
  }

  if (url.pathname === "/v1/kosh/systems/extensions" && request.method === "GET") {
    const extensions = await platformStore.listResources("extension", null);
    sendJson(response, 200, {
      extensions,
      schemaVersion: 1,
      capabilities: [...extensionCapabilities].sort(),
      permissions: [...extensionPermissions].sort(),
      runtime: "declarative"
    }, origin, allowedOrigins);
    return true;
  }

  if (url.pathname === "/v1/kosh/systems/extensions" && request.method === "POST") {
    requirePlatformAdministrator(identity);
    if (identity.authType !== "session") {
      throw Object.assign(new Error("interactive_session_required"), { status: 403 });
    }
    if ((await globalSetting("extension_policy")) === "disabled") {
      throw Object.assign(new Error("extension_installation_disabled"), { status: 409 });
    }
    const body = await readJson(request, 128 * 1024);
    const manifest = validateExtensionManifest(body.manifest ?? body);
    const existing = (await platformStore.listResources("extension", null))
      .find((item) => item.key === manifest.id + "@" + manifest.version);
    if (existing) {
      throw Object.assign(new Error("extension_version_exists"), { status: 409 });
    }
    const extension = await platformStore.createResource({
      repositoryId: null,
      namespace: "kosh",
      type: "extension",
      key: manifest.id + "@" + manifest.version,
      name: manifest.name,
      state: body.enable === true ? "enabled" : "disabled",
      payload: { kind: "manifest", manifest },
      createdByUserId: identity.user.id,
      createdByName: identity.user.displayName
    });
    await audit(null, identity.user, "extension_registered", "extension", extension.id, {
      id: manifest.id,
      version: manifest.version,
      capabilities: manifest.capabilities
    });
    sendJson(response, 201, extension, origin, allowedOrigins);
    return true;
  }

  const extensionMatch = url.pathname.match(/^\/v1\/kosh\/systems\/extensions\/([^/]+)$/);
  if (extensionMatch && request.method === "PATCH") {
    requirePlatformAdministrator(identity);
    if (identity.authType !== "session") {
      throw Object.assign(new Error("interactive_session_required"), { status: 403 });
    }
    const id = decodeURIComponent(extensionMatch[1]);
    const extension = await platformStore.getResource(id);
    if (!extension || extension.type !== "extension" || extension.repositoryId !== null) {
      throw Object.assign(new Error("extension_not_found"), { status: 404 });
    }
    const body = await readJson(request, 32 * 1024);
    const state = body.enabled === true ? "enabled" : body.enabled === false ? "disabled" : extension.state;
    const updated = await platformStore.updateResource(id, { state });
    await audit(null, identity.user, "extension_state_changed", "extension", id, { state });
    sendJson(response, 200, updated, origin, allowedOrigins);
    return true;
  }

  return false;
}

export async function handleKoshSystemsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const recognized =
    url.pathname.includes("/systems") &&
    url.pathname.startsWith("/v1/kosh/");
  if (!recognized) return false;
  try {
    if (
      await handleRepositorySystems(
        request,
        response,
        url,
        origin,
        allowedOrigins
      )
    ) {
      return true;
    }
    if (
      await handleGlobalSystems(
        request,
        response,
        url,
        origin,
        allowedOrigins
      )
    ) {
      return true;
    }
    sendJson(response, 404, { error: "kosh_systems_route_not_found" }, origin, allowedOrigins);
    return true;
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: unknown }).status) || 500
        : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "kosh_systems_error" },
      origin,
      allowedOrigins
    );
    return true;
  }
}
