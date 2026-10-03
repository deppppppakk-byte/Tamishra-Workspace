import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { automationStore } from "./kosh-automation-service.js";
import type { StoredKoshArtifact } from "./kosh-automation-store.js";
import {
  deleteKoshObject,
  koshObjectStorageBackend,
  putKoshObject,
  readKoshObject
} from "./kosh-object-storage.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshObjectIndex } from "./kosh-storage-object-index.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const store = automationStore();
const objectIndex = getKoshObjectIndex();
const artifactRoot = resolve(
  process.env.KOSH_ARTIFACT_ROOT?.trim() || ".kosh/artifacts"
);

const artifactObjectPrefix = "kosh-object://artifact/";

type JsonBody = Record<string, unknown>;

type ArtifactContext = {
  repository: StoredKoshRepository;
  runId: string;
  jobId: string;
};

function allowedOrigins() {
  return new Set(
    (
      process.env.WORKSPACE_ALLOWED_ORIGINS ??
      process.env.WORKSPACE_WEB_ORIGIN ??
      "http://localhost:3000"
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  const origin = request.headers.origin;
  if (origin && allowedOrigins().has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

function tokenMatches(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function runnerAuthorized(request: IncomingMessage) {
  const expected = process.env.KOSH_RUNNER_TOKEN?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  const authorization = request.headers.authorization?.trim() ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  return tokenMatches(token, expected);
}

function runnerHeader(request: IncomingMessage, name: string) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value)
    ? value[0]?.trim() ?? ""
    : String(value ?? "").trim();
}

function maxArtifactBytes() {
  const configured = Number(process.env.KOSH_AUTOMATION_ARTIFACT_MAX_MB ?? 8);
  const mb = Number.isFinite(configured)
    ? Math.max(1, Math.min(1024, Math.floor(configured)))
    : 8;
  return mb * 1024 * 1024;
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number
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

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeArtifactName(value: string) {
  const name = value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180);
  return name && name !== "." && name !== ".." ? name : "";
}

async function findRunnerContext(jobId: string): Promise<ArtifactContext | null> {
  await store.ready();
  for (const repository of await repositoryStore.list()) {
    const runs = await store.listRuns(repository.id, 500);
    for (const run of runs) {
      const job = (await store.listJobs(run.id)).find((item) => item.id === jobId);
      if (job) {
        return {
          repository,
          runId: run.id,
          jobId: job.id
        };
      }
    }
  }
  return null;
}

async function requireRunnerLease(
  request: IncomingMessage,
  response: ServerResponse,
  jobId: string
) {
  if (!runnerAuthorized(request)) {
    sendJson(request, response, 401, {
      error: "runner_authentication_required"
    });
    return false;
  }

  const runnerId = runnerHeader(request, "x-kosh-runner-id");
  const leaseToken = runnerHeader(request, "x-kosh-job-lease");
  if (
    !runnerId ||
    !leaseToken ||
    !(await store.verifyJobLease(jobId, runnerId, leaseToken))
  ) {
    sendJson(request, response, 409, { error: "job_lease_expired" });
    return false;
  }
  return true;
}

function objectLogicalId(artifact: StoredKoshArtifact) {
  if (!artifact.storagePath.startsWith(artifactObjectPrefix)) return null;
  const value = artifact.storagePath.slice(artifactObjectPrefix.length).trim();
  return /^[a-zA-Z0-9._-]{1,240}$/.test(value) ? value : null;
}

async function storageForArtifact(
  repositoryId: string,
  artifact: StoredKoshArtifact
) {
  const logicalId = objectLogicalId(artifact);
  if (logicalId) {
    const indexed = await objectIndex.get(repositoryId, "artifact", logicalId);
    if (!indexed) {
      throw Object.assign(new Error("artifact_object_locator_missing"), {
        status: 500
      });
    }
    return {
      backend: indexed.locator.backend,
      locator: indexed.locator,
      localPath: ""
    };
  }

  const indexed = await objectIndex.get(repositoryId, "artifact", artifact.id);
  if (indexed) {
    return {
      backend: indexed.locator.backend,
      locator: indexed.locator,
      localPath: artifact.storagePath
    };
  }

  return {
    backend: "local" as const,
    locator: null,
    localPath: artifact.storagePath
  };
}

async function verifiedArtifactBytes(
  repositoryId: string,
  artifact: StoredKoshArtifact
) {
  const storage = await storageForArtifact(repositoryId, artifact);
  let bytes: Buffer;
  try {
    bytes = await readKoshObject(storage.locator, storage.localPath);
  } catch (error) {
    throw Object.assign(new Error("artifact_payload_missing"), {
      status: 404,
      cause: error
    });
  }
  const checksum = sha256(bytes);
  if (bytes.length !== artifact.sizeBytes || checksum !== artifact.sha256) {
    throw Object.assign(new Error("artifact_integrity_failure"), {
      status: 500
    });
  }
  return { bytes, checksum, backend: storage.backend };
}

async function uploadDriveArtifact(
  request: IncomingMessage,
  response: ServerResponse,
  jobId: string
) {
  if (koshObjectStorageBackend() !== "google-drive") return false;
  if (!(await requireRunnerLease(request, response, jobId))) return true;

  const context = await findRunnerContext(jobId);
  if (!context) {
    sendJson(request, response, 404, { error: "job_not_found" });
    return true;
  }

  const body = await readJson(
    request,
    Math.floor(maxArtifactBytes() * 1.45) + 512 * 1024
  );
  const name = safeArtifactName(clean(body.name, 180));
  const encoded = String(body.base64 ?? "");
  const bytes = Buffer.from(encoded, "base64");

  if (!name || !encoded) {
    sendJson(request, response, 400, {
      error: "artifact_name_and_data_required"
    });
    return true;
  }
  if (!bytes.length || bytes.length > maxArtifactBytes()) {
    sendJson(request, response, 413, { error: "artifact_size_invalid" });
    return true;
  }

  await Promise.all([platformStore.ready(), objectIndex.ready()]);

  const checksum = sha256(bytes);
  const logicalId = randomUUID();
  const localPath = resolve(artifactRoot, context.runId, jobId, name);
  const locator = await putKoshObject({
    storageClass: "artifact",
    repositoryId: context.repository.id,
    logicalId,
    filename: name,
    mediaType: "application/octet-stream",
    bytes,
    sha256: checksum,
    localPath
  });

  let indexed = false;
  try {
    await objectIndex.put({
      repositoryId: context.repository.id,
      storageClass: "artifact",
      logicalId,
      locator
    });
    indexed = true;

    const artifact = await store.createArtifact({
      runId: context.runId,
      jobId,
      name,
      storagePath: artifactObjectPrefix + logicalId,
      sizeBytes: bytes.length,
      sha256: checksum
    });

    await platformStore.appendAudit({
      repositoryId: context.repository.id,
      actorUserId: null,
      actorName: "Kosh Automation Runner",
      eventType: "automation_artifact_stored",
      resourceType: "artifact",
      resourceId: artifact.id,
      metadata: {
        runId: context.runId,
        jobId,
        name: artifact.name,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        storageBackend: locator.backend
      }
    });

    sendJson(request, response, 201, {
      ...artifact,
      storageBackend: locator.backend,
      downloadPath:
        "/v1/kosh/repos/" +
        encodeURIComponent(context.repository.namespace) +
        "/" +
        encodeURIComponent(context.repository.slug) +
        "/automation/runs/" +
        encodeURIComponent(context.runId) +
        "/artifacts/" +
        encodeURIComponent(artifact.id) +
        "/download"
    });
    return true;
  } catch (error) {
    if (indexed) {
      await objectIndex
        .delete(context.repository.id, "artifact", logicalId)
        .catch(() => undefined);
    }
    await deleteKoshObject(locator, localPath).catch(() => undefined);
    throw error;
  }
}

async function authorizeArtifactRead(
  request: IncomingMessage,
  response: ServerResponse,
  repository: StoredKoshRepository
) {
  const authorization = await authorizeKoshRepositoryRequest(
    request,
    repository,
    "repository.read"
  );
  if (!authorization.identity) {
    sendJson(request, response, 401, { error: "authentication_required" });
    return false;
  }
  if (!authorization.decision.allowed) {
    sendJson(request, response, 403, {
      error: "repository_permission_denied",
      permission: "repository.read",
      role: authorization.decision.role
    });
    return false;
  }
  return true;
}

async function readArtifactRoute(
  request: IncomingMessage,
  response: ServerResponse,
  namespace: string,
  slug: string,
  runId: string,
  artifactId: string,
  action: string
) {
  const repository = await repositoryStore.get(namespace, slug);
  if (!repository) {
    sendJson(request, response, 404, { error: "repository_not_found" });
    return true;
  }
  if (!(await authorizeArtifactRead(request, response, repository))) return true;

  await Promise.all([store.ready(), objectIndex.ready()]);
  const run = await store.getRun(repository.id, runId);
  if (!run) {
    sendJson(request, response, 404, { error: "run_not_found" });
    return true;
  }

  const artifact = (await store.listArtifacts(run.id)).find(
    (item) => item.id === artifactId
  );
  if (!artifact) {
    sendJson(request, response, 404, { error: "artifact_not_found" });
    return true;
  }

  if (!action) {
    const storage = await storageForArtifact(repository.id, artifact);
    sendJson(request, response, 200, {
      artifact,
      storageBackend: storage.backend,
      downloadPath:
        "/v1/kosh/repos/" +
        encodeURIComponent(repository.namespace) +
        "/" +
        encodeURIComponent(repository.slug) +
        "/automation/runs/" +
        encodeURIComponent(run.id) +
        "/artifacts/" +
        encodeURIComponent(artifact.id) +
        "/download",
      verifyPath:
        "/v1/kosh/repos/" +
        encodeURIComponent(repository.namespace) +
        "/" +
        encodeURIComponent(repository.slug) +
        "/automation/runs/" +
        encodeURIComponent(run.id) +
        "/artifacts/" +
        encodeURIComponent(artifact.id) +
        "/verify"
    });
    return true;
  }

  const verified = await verifiedArtifactBytes(repository.id, artifact);
  if (action === "verify") {
    sendJson(request, response, 200, {
      valid: true,
      artifactId: artifact.id,
      sizeBytes: verified.bytes.length,
      sha256: verified.checksum,
      expectedSha256: artifact.sha256,
      storageBackend: verified.backend
    });
    return true;
  }

  const filename = artifact.name.replace(/["\r\n]/g, "_");
  response.statusCode = 200;
  response.setHeader("content-type", "application/octet-stream");
  response.setHeader("content-length", String(verified.bytes.length));
  response.setHeader(
    "content-disposition",
    'attachment; filename="' + filename + '"'
  );
  response.setHeader("x-kosh-sha256", verified.checksum);
  response.setHeader("etag", '"' + verified.checksum + '"');
  response.setHeader("cache-control", "private, max-age=31536000, immutable");
  const origin = request.headers.origin;
  if (origin && allowedOrigins().has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(verified.bytes);
  return true;
}

export async function handleKoshArtifactStorageRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  try {
    const runnerMatch = url.pathname.match(
      /^\/v1\/kosh\/automation\/runner\/jobs\/([^/]+)\/artifacts\/?$/
    );
    if (runnerMatch && request.method === "POST") {
      return uploadDriveArtifact(
        request,
        response,
        decodeURIComponent(runnerMatch[1])
      );
    }

    const readMatch = url.pathname.match(
      /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/automation\/runs\/([^/]+)\/artifacts\/([^/]+)(?:\/(download|verify))?\/?$/
    );
    if (readMatch && request.method === "GET") {
      return readArtifactRoute(
        request,
        response,
        readMatch[1],
        readMatch[2],
        decodeURIComponent(readMatch[3]),
        decodeURIComponent(readMatch[4]),
        readMatch[5] ?? ""
      );
    }

    return false;
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status) || 500
        : 500;
    sendJson(request, response, status, {
      error:
        error instanceof Error
          ? error.message
          : "kosh_artifact_storage_error"
    });
    return true;
  }
}
