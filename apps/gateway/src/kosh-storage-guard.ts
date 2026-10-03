import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { handleKoshArtifactStorageRoute } from "./kosh-artifact-storage-routes.js";
import { automationStore } from "./kosh-automation-service.js";
import { handleKoshDriveChannelRoute } from "./kosh-drive-channel-routes.js";
import { handleKoshDriveStorageRoute } from "./kosh-drive-storage-routes.js";
import type { KoshStorageClass } from "./kosh-storage-policy.js";
import {
  finalizeKoshStorageReservation,
  reserveKoshStorageCapacity
} from "./kosh-storage-reservations.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const automation = automationStore();

type StorageTarget = {
  repositoryId: string;
  repository: StoredKoshRepository | null;
  storageClass: KoshStorageClass;
  encodedBody: boolean;
  permission: "packages.publish" | "releases.manage" | null;
  runnerJobId: string | null;
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

function contentLength(request: IncomingMessage) {
  const raw = request.headers["content-length"];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
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
  return Array.isArray(value) ? value[0]?.trim() ?? "" : String(value ?? "").trim();
}

async function repositoryFor(namespace: string, slug: string) {
  return repositoryStore.get(namespace, slug);
}

async function repositoryIdForJob(jobId: string) {
  await automation.ready();
  for (const repository of await repositoryStore.list()) {
    for (const run of await automation.listRuns(repository.id, 500)) {
      if ((await automation.listJobs(run.id)).some((job) => job.id === jobId)) {
        return repository.id;
      }
    }
  }
  return null;
}

async function targetFor(
  request: IncomingMessage,
  url: URL
): Promise<StorageTarget | null> {
  if (request.method !== "POST") return null;

  const packageMatch = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/packages(?:\/publish)?\/?$/
  );
  if (packageMatch) {
    const repository = await repositoryFor(packageMatch[1], packageMatch[2]);
    return repository
      ? {
          repositoryId: repository.id,
          repository,
          storageClass: "package",
          encodedBody: String(request.headers["content-type"] ?? "")
            .toLowerCase()
            .includes("application/json"),
          permission: "packages.publish",
          runnerJobId: null
        }
      : null;
  }

  const releaseMatch = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/releases\/[^/]+\/assets\/?$/
  );
  if (releaseMatch) {
    const repository = await repositoryFor(releaseMatch[1], releaseMatch[2]);
    return repository
      ? {
          repositoryId: repository.id,
          repository,
          storageClass: "release",
          encodedBody: false,
          permission: "releases.manage",
          runnerJobId: null
        }
      : null;
  }

  const runnerMatch = url.pathname.match(
    /^\/v1\/kosh\/automation\/runner\/jobs\/([^/]+)\/(artifacts|packages)$/
  );
  if (runnerMatch) {
    const jobId = decodeURIComponent(runnerMatch[1]);
    const repositoryId = await repositoryIdForJob(jobId);
    return repositoryId
      ? {
          repositoryId,
          repository: null,
          storageClass: runnerMatch[2] === "artifacts" ? "artifact" : "package",
          encodedBody: true,
          permission: null,
          runnerJobId: jobId
        }
      : null;
  }

  return null;
}

async function authorizeReservationTarget(
  request: IncomingMessage,
  response: ServerResponse,
  target: StorageTarget
) {
  if (target.repository && target.permission) {
    const authorization = await authorizeKoshRepositoryRequest(
      request,
      target.repository,
      target.permission
    );
    if (!authorization.decision.allowed || !authorization.identity) {
      json(
        response,
        authorization.identity ? 403 : 401,
        {
          error: authorization.identity
            ? "repository_permission_denied"
            : "authentication_required",
          permission: target.permission,
          role: authorization.decision.role
        }
      );
      return false;
    }
    return true;
  }

  if (target.runnerJobId) {
    if (!runnerAuthorized(request)) {
      json(response, 401, { error: "runner_authentication_required" });
      return false;
    }
    const runnerId = runnerHeader(request, "x-kosh-runner-id");
    const leaseToken = runnerHeader(request, "x-kosh-job-lease");
    if (
      !runnerId ||
      !leaseToken ||
      !(await automation.verifyJobLease(
        target.runnerJobId,
        runnerId,
        leaseToken
      ))
    ) {
      json(response, 409, { error: "job_lease_expired" });
      return false;
    }
    return true;
  }

  return false;
}

function registerReservationFinalizer(
  response: ServerResponse,
  reservationId: string
) {
  let settled = false;
  const settle = (completed: boolean) => {
    if (settled) return;
    settled = true;
    void finalizeKoshStorageReservation(
      reservationId,
      completed ? "completed" : "aborted"
    ).catch((error) => {
      console.error("Kosh storage reservation finalization failed", error);
    });
  };

  response.once("finish", () => {
    settle(response.statusCode >= 200 && response.statusCode < 300);
  });
  response.once("close", () => {
    settle(
      response.writableFinished &&
        response.statusCode >= 200 &&
        response.statusCode < 300
    );
  });
}

async function handleDriveNonReservedRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  if (await handleKoshArtifactStorageRoute(request, response, url)) {
    return true;
  }
  if (await handleKoshDriveChannelRoute(request, response, url)) {
    return true;
  }
  return handleKoshDriveStorageRoute(request, response, url);
}

export async function handleKoshStoragePreflight(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  const target = await targetFor(request, url);

  if (!target) {
    return handleDriveNonReservedRoute(request, response, url);
  }

  if (!(await authorizeReservationTarget(request, response, target))) {
    return true;
  }

  const length = contentLength(request);
  if (length == null) {
    if (process.env.NODE_ENV === "production") {
      json(response, 411, {
        error: "content_length_required_for_storage_write"
      });
      return true;
    }
    return false;
  }

  const estimatedBytes = target.encodedBody
    ? Math.ceil(length * 0.75)
    : length;

  try {
    const reservation = await reserveKoshStorageCapacity(
      target.repositoryId,
      target.storageClass,
      estimatedBytes
    );
    response.setHeader("x-kosh-storage-reservation", reservation.id);
    registerReservationFinalizer(response, reservation.id);

    if (await handleKoshArtifactStorageRoute(request, response, url)) {
      return true;
    }
    if (await handleKoshDriveStorageRoute(request, response, url)) {
      return true;
    }

    return false;
  } catch (error) {
    const value = error as Error & {
      status?: number;
      storageClass?: string;
      incomingBytes?: number;
      knownBytes?: number;
      reservedBytes?: number;
      limitBytes?: number;
    };
    json(response, value.status ?? 413, {
      error: value.message || "storage_policy_rejected_write",
      storageClass: value.storageClass ?? target.storageClass,
      incomingBytes: value.incomingBytes ?? estimatedBytes,
      knownBytes: value.knownBytes,
      reservedBytes: value.reservedBytes,
      limitBytes: value.limitBytes
    });
    return true;
  }
}
