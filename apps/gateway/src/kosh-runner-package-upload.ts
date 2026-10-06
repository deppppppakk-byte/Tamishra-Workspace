import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { automationStore } from "./kosh-automation-service.js";
import { publishKoshPackage } from "./kosh-packages.js";
import { getKoshStore } from "./kosh-store.js";
import {
  finalizeKoshStorageReservation,
  reserveKoshStorageCapacity
} from "./kosh-storage-reservations.js";

const automation = automationStore();
const repositories = getKoshStore();

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function header(request: IncomingMessage, name: string) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0]?.trim() ?? "" : String(value ?? "").trim();
}

function tokenMatches(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function runnerAuthorized(request: IncomingMessage) {
  const expected = process.env.KOSH_RUNNER_TOKEN?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  const authorization = String(request.headers.authorization ?? "").trim();
  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  return tokenMatches(token, expected);
}

function maxPackageBytes() {
  const configured = Number(process.env.KOSH_PACKAGE_MAX_MB ?? 512);
  const mb = Number.isFinite(configured)
    ? Math.max(1, Math.min(1024, Math.floor(configured)))
    : 512;
  return mb * 1024 * 1024;
}

async function readBinary(request: IncomingMessage, maxBytes: number) {
  const declared = Number(header(request, "content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw Object.assign(new Error("package_size_invalid"), { status: 413 });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("package_size_invalid"), { status: 413 });
    }
    chunks.push(buffer);
  }
  if (!total) throw Object.assign(new Error("package_size_invalid"), { status: 400 });
  return Buffer.concat(chunks, total);
}

function metadataHeader(request: IncomingMessage) {
  const encoded = header(request, "x-kosh-package-metadata");
  if (!encoded) return {};
  if (encoded.length > 12 * 1024) {
    throw Object.assign(new Error("package_metadata_too_large"), { status: 413 });
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw Object.assign(new Error("package_metadata_invalid"), { status: 400 });
  }
}

async function contextForJob(jobId: string) {
  await automation.ready();
  for (const repository of await repositories.list()) {
    for (const run of await automation.listRuns(repository.id, 500)) {
      const job = (await automation.listJobs(run.id)).find((item) => item.id === jobId);
      if (job) return { repository, run, job };
    }
  }
  return null;
}

export async function handleKoshRunnerPackageUpload(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/automation\/runner\/jobs\/([^/]+)\/packages\/binary$/
  );
  if (!match) return false;

  if (request.method !== "POST") {
    json(response, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!runnerAuthorized(request)) {
    json(response, 401, { error: "runner_authentication_required" });
    return true;
  }

  const jobId = decodeURIComponent(match[1]);
  const runnerId = header(request, "x-kosh-runner-id");
  const leaseToken = header(request, "x-kosh-job-lease");
  if (
    !runnerId ||
    !leaseToken ||
    !(await automation.verifyJobLease(jobId, runnerId, leaseToken))
  ) {
    json(response, 409, { error: "job_lease_expired" });
    return true;
  }

  let reservationId = "";
  try {
    const context = await contextForJob(jobId);
    if (!context) throw Object.assign(new Error("job_not_found"), { status: 404 });
    if (context.job.definition.publishPackages !== true) {
      throw Object.assign(new Error("job_package_publish_not_enabled"), { status: 403 });
    }

    const packageKey = clean(header(request, "x-kosh-package-key"), 120);
    const name = clean(header(request, "x-kosh-package-name"), 180) || packageKey;
    const version = clean(header(request, "x-kosh-package-version"), 100);
    const filename = clean(header(request, "x-kosh-package-filename"), 220);
    const format = clean(header(request, "x-kosh-package-format"), 80) || "generic";
    const mediaType = clean(header(request, "x-kosh-package-media-type"), 160) || "application/octet-stream";
    const channel = clean(header(request, "x-kosh-package-channel"), 80) || null;
    if (!packageKey || !version || !filename) {
      throw Object.assign(new Error("package_identity_required"), { status: 400 });
    }

    const declared = Number(header(request, "content-length"));
    if (!Number.isFinite(declared) || declared <= 0) {
      throw Object.assign(new Error("content_length_required_for_package_upload"), { status: 411 });
    }
    if (declared > maxPackageBytes()) {
      throw Object.assign(new Error("package_size_invalid"), { status: 413 });
    }

    const reservation = await reserveKoshStorageCapacity(
      context.repository.id,
      "package",
      Math.floor(declared)
    );
    reservationId = reservation.id;

    const bytes = await readBinary(request, maxPackageBytes());
    if (bytes.length !== Math.floor(declared)) {
      throw Object.assign(new Error("package_content_length_mismatch"), { status: 400 });
    }

    // Keep the build/package lane large by default while preserving an explicit
    // deployment override. publishKoshPackage reads this policy at call time.
    if (!process.env.KOSH_PACKAGE_MAX_MB?.trim()) {
      process.env.KOSH_PACKAGE_MAX_MB = "512";
    }

    const actorId = context.run.actorUserId || "automation:" + context.job.id;
    const actorName = context.run.actorName || "Kosh Automation";
    const published = await publishKoshPackage({
      repository: context.repository,
      packageKey,
      name,
      version,
      filename,
      format,
      mediaType,
      bytes,
      commitSha: context.run.commitSha,
      runId: context.run.id,
      provenance: {
        source: "automation",
        transport: "binary",
        workflowId: context.job.workflowId,
        workflowName: context.run.workflowName,
        jobId: context.job.id,
        jobName: context.job.name,
        refName: context.run.refName,
        runnerId
      },
      metadata: metadataHeader(request),
      actor: { id: actorId, displayName: actorName },
      channel
    });

    await finalizeKoshStorageReservation(reservationId, "completed");
    reservationId = "";
    response.setHeader("x-kosh-package-transport", "binary-v1");
    json(response, 201, published);
  } catch (error) {
    if (reservationId) {
      await finalizeKoshStorageReservation(reservationId, "aborted").catch(() => undefined);
    }
    const status = Number((error as { status?: number })?.status ?? 500);
    json(response, status, {
      error: error instanceof Error ? error.message : "kosh_package_upload_failed"
    });
  }
  return true;
}
