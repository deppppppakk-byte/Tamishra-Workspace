import type { IncomingMessage, ServerResponse } from "node:http";
import { automationStore } from "./kosh-automation-service.js";
import type { KoshStorageClass } from "./kosh-storage-policy.js";
import {
  finalizeKoshStorageReservation,
  reserveKoshStorageCapacity
} from "./kosh-storage-reservations.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const automation = automationStore();

type StorageTarget = {
  repositoryId: string;
  storageClass: KoshStorageClass;
  encodedBody: boolean;
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

async function repositoryId(namespace: string, slug: string) {
  const repository = await repositoryStore.get(namespace, slug);
  return repository?.id ?? null;
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
    const id = await repositoryId(packageMatch[1], packageMatch[2]);
    return id
      ? { repositoryId: id, storageClass: "package", encodedBody: false }
      : null;
  }

  const releaseMatch = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/releases\/[^/]+\/assets\/?$/
  );
  if (releaseMatch) {
    const id = await repositoryId(releaseMatch[1], releaseMatch[2]);
    return id
      ? { repositoryId: id, storageClass: "release", encodedBody: false }
      : null;
  }

  const runnerMatch = url.pathname.match(
    /^\/v1\/kosh\/automation\/runner\/jobs\/([^/]+)\/(artifacts|packages)$/
  );
  if (runnerMatch) {
    const id = await repositoryIdForJob(decodeURIComponent(runnerMatch[1]));
    return id
      ? {
          repositoryId: id,
          storageClass: runnerMatch[2] === "artifacts" ? "artifact" : "package",
          encodedBody: true
        }
      : null;
  }

  return null;
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
    settle(response.writableFinished && response.statusCode >= 200 && response.statusCode < 300);
  });
}

export async function handleKoshStoragePreflight(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  const target = await targetFor(request, url);
  if (!target) return false;

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
