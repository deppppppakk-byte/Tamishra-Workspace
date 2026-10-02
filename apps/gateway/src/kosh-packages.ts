import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  getKoshPackageStore,
  type KoshPackageState,
  type StoredKoshPackageVersion
} from "./kosh-package-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import {
  getKoshStore,
  type StoredKoshRepository
} from "./kosh-store.js";
import { dispatchKoshWebhooks } from "./kosh-webhooks.js";

const packageStore = getKoshPackageStore();
const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const packageRoot = resolve(
  process.env.KOSH_PACKAGE_ROOT?.trim() || ".kosh/packages"
);

type JsonBody = Record<string, unknown>;

type PackageActor = {
  id: string;
  displayName: string;
};

type PublishPackageInput = {
  repository: StoredKoshRepository;
  packageKey: string;
  name: string;
  version: string;
  filename: string;
  format: string;
  mediaType: string;
  bytes: Buffer;
  commitSha: string | null;
  runId: string | null;
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
  actor: PackageActor;
  channel?: string | null;
};

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function maxPackageBytes() {
  const configured = Number(process.env.KOSH_PACKAGE_MAX_MB ?? 64);
  const mb = Number.isFinite(configured)
    ? Math.max(1, Math.min(1024, configured))
    : 64;
  return Math.floor(mb * 1024 * 1024);
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function validPackageKey(value: string) {
  return (
    value.length > 0 &&
    value.length <= 120 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) &&
    !value.includes("..")
  );
}

function validVersion(value: string) {
  return (
    value.length > 0 &&
    value.length <= 100 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._+~-]*$/.test(value)
  );
}

function validChannel(value: string) {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
  );
}

function safeFilename(value: string) {
  return (
    value.length > 0 &&
    value.length <= 220 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".." &&
    !value.includes("\0")
  );
}

function safeStoragePath(root: string, ...parts: string[]) {
  const path = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (path !== root && !path.startsWith(prefix)) {
    throw Object.assign(new Error("package_storage_path_invalid"), {
      status: 400
    });
  }
  return path;
}

function packageArtifactPath(version: StoredKoshPackageVersion) {
  return safeStoragePath(
    packageRoot,
    version.repositoryId,
    version.id,
    version.filename
  );
}

async function readBuffer(request: IncomingMessage, maxBytes: number) {
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

  return Buffer.concat(chunks);
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 512 * 1024
): Promise<JsonBody> {
  const bytes = await readBuffer(request, maxBytes);
  if (!bytes.length) return {};
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function json(
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

async function audit(
  repositoryId: string,
  actor: PackageActor,
  eventType: string,
  resourceId: string | null,
  metadata: Record<string, unknown>
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType: "package",
    resourceId,
    metadata
  });
}

export async function publishKoshPackage(
  input: PublishPackageInput
) {
  await Promise.all([
    packageStore.ready(),
    platformStore.ready()
  ]);

  if (
    !validPackageKey(input.packageKey) ||
    !validVersion(input.version) ||
    !safeFilename(input.filename)
  ) {
    throw Object.assign(new Error("invalid_package_identity"), {
      status: 400
    });
  }

  if (!input.bytes.length || input.bytes.length > maxPackageBytes()) {
    throw Object.assign(new Error("package_size_invalid"), { status: 413 });
  }

  if (
    input.commitSha &&
    !/^[0-9a-f]{40}$/i.test(input.commitSha)
  ) {
    throw Object.assign(new Error("invalid_package_commit_sha"), {
      status: 400
    });
  }

  const checksum = sha256(input.bytes);
  const versionId = randomUUID();
  const directory = safeStoragePath(
    packageRoot,
    input.repository.id,
    versionId
  );
  const path = safeStoragePath(
    directory,
    input.filename
  );

  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path, input.bytes, { flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined
    );
    throw error;
  }

  let version: StoredKoshPackageVersion;
  try {
    version = await packageStore.createVersion({
      id: versionId,
      repositoryId: input.repository.id,
      packageKey: input.packageKey,
      name: input.name || input.packageKey,
      version: input.version,
      filename: input.filename,
      format: input.format || "generic",
      mediaType: input.mediaType || "application/octet-stream",
      sizeBytes: input.bytes.length,
      sha256: checksum,
      state: "published",
      commitSha: input.commitSha,
      runId: input.runId,
      provenance: {
        ...input.provenance,
        repositoryId: input.repository.id,
        namespace: input.repository.namespace,
        repository: input.repository.slug,
        commitSha: input.commitSha,
        runId: input.runId,
        sha256: checksum
      },
      metadata: input.metadata,
      createdByUserId: input.actor.id,
      createdByName: input.actor.displayName
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined
    );
    throw error;
  }

  let channel = null;
  if (input.channel) {
    if (!validChannel(input.channel)) {
      await packageStore.deleteVersionForRollback(
        input.repository.id,
        version.id
      ).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined
      );
      throw Object.assign(new Error("invalid_package_channel"), {
        status: 400
      });
    }

    channel = await packageStore.putChannel({
      repositoryId: input.repository.id,
      packageKey: input.packageKey,
      channel: input.channel,
      versionId: version.id,
      version: version.version,
      updatedByUserId: input.actor.id,
      updatedByName: input.actor.displayName
    });
  }

  await audit(
    input.repository.id,
    input.actor,
    "package_published",
    version.id,
    {
      packageKey: version.packageKey,
      version: version.version,
      filename: version.filename,
      format: version.format,
      sizeBytes: version.sizeBytes,
      sha256: version.sha256,
      commitSha: version.commitSha,
      runId: version.runId,
      channel: channel?.channel ?? null
    }
  );

  void dispatchKoshWebhooks(
    input.repository.id,
    "package.published",
    {
      packageKey: version.packageKey,
      version: version.version,
      filename: version.filename,
      format: version.format,
      sizeBytes: version.sizeBytes,
      sha256: version.sha256,
      channel: channel?.channel ?? null,
      runId: version.runId,
      commitSha: version.commitSha
    }
  ).catch(() => undefined);

  return { version, channel };
}

async function verifiedArtifact(version: StoredKoshPackageVersion) {
  const path = packageArtifactPath(version);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw Object.assign(new Error("package_artifact_missing"), {
      status: 500
    });
  }

  const checksum = sha256(bytes);
  if (
    bytes.length !== version.sizeBytes ||
    checksum !== version.sha256
  ) {
    throw Object.assign(new Error("package_integrity_failure"), {
      status: 500
    });
  }

  return bytes;
}

async function sendArtifact(
  response: ServerResponse,
  version: StoredKoshPackageVersion
) {
  if (version.state === "yanked") {
    response.statusCode = 410;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ error: "package_version_yanked" }));
    return;
  }

  const bytes = await verifiedArtifact(version);
  const filename = version.filename.replace(/["\r\n]/g, "_");
  response.statusCode = 200;
  response.setHeader("content-type", version.mediaType);
  response.setHeader("content-length", String(bytes.length));
  response.setHeader(
    "content-disposition",
    'attachment; filename="' + filename + '"'
  );
  response.setHeader("x-kosh-sha256", version.sha256);
  response.setHeader("etag", '"' + version.sha256 + '"');
  response.setHeader("cache-control", "private, max-age=31536000, immutable");
  response.end(bytes);
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
  json(
    response,
    status,
    {
      error:
        error instanceof Error ? error.message : "kosh_package_error"
    },
    origin,
    allowedOrigins
  );
}

function publishMetadataFromRequest(
  request: IncomingMessage,
  url: URL
) {
  const header = (name: string) => {
    const value = request.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] ?? "" : String(value ?? "");
  };

  return {
    packageKey: clean(
      url.searchParams.get("key") || header("x-kosh-package-key"),
      120
    ),
    name: clean(
      url.searchParams.get("name") || header("x-kosh-package-name"),
      180
    ),
    version: clean(
      url.searchParams.get("version") || header("x-kosh-package-version"),
      100
    ),
    filename: clean(
      url.searchParams.get("filename") || header("x-kosh-package-filename"),
      220
    ),
    format: clean(
      url.searchParams.get("format") || header("x-kosh-package-format"),
      80
    ) || "generic",
    mediaType: clean(
      url.searchParams.get("mediaType") ||
        header("x-kosh-package-media-type") ||
        request.headers["content-type"],
      160
    ) || "application/octet-stream",
    channel: clean(
      url.searchParams.get("channel") || header("x-kosh-package-channel"),
      80
    ) || null,
    commitSha: clean(
      url.searchParams.get("commitSha") ||
        header("x-kosh-commit-sha"),
      64
    ) || null,
    runId: clean(
      url.searchParams.get("runId") ||
        header("x-kosh-run-id"),
      240
    ) || null
  };
}

export async function handleKoshPackageRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/packages(?:\/(.*))?$/
  );
  if (!match) return false;

  const namespace = match[1];
  const slug = match[2];
  const tail = match[3] ?? "";
  const identity = await resolveKoshIdentity(
    request,
    request.method === "GET" ? "repo:read" : "repo:write"
  );

  if (!identity) {
    json(
      response,
      401,
      { error: "authentication_required" },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method || "") &&
    origin &&
    !allowedOrigins.has(origin)
  ) {
    json(
      response,
      403,
      { error: "origin_not_allowed" },
      origin,
      allowedOrigins
    );
    return true;
  }

  try {
    await Promise.all([
      packageStore.ready(),
      platformStore.ready()
    ]);

    const repository = await repositoryStore.get(namespace, slug);
    if (!repository) {
      throw Object.assign(new Error("repository_not_found"), {
        status: 404
      });
    }

    if (request.method === "GET" && tail === "") {
      const key = clean(url.searchParams.get("key"), 120);
      const [versions, channels] = await Promise.all([
        packageStore.listVersions(repository.id, key || undefined),
        packageStore.listChannels(repository.id, key || undefined)
      ]);

      const packageKeys = [...new Set(
        versions.map((item) => item.packageKey)
      )].sort();

      json(
        response,
        200,
        {
          packages: packageKeys.map((packageKey) => {
            const packageVersions = versions.filter(
              (item) => item.packageKey === packageKey
            );
            return {
              key: packageKey,
              name: packageVersions[0]?.name ?? packageKey,
              versions: packageVersions,
              channels: channels.filter(
                (item) => item.packageKey === packageKey
              )
            };
          }),
          versions,
          channels,
          persistence: packageStore.kind,
          maxPackageBytes: maxPackageBytes()
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      request.method === "POST" &&
      (tail === "" || tail === "publish")
    ) {
      const contentType = String(
        request.headers["content-type"] ?? ""
      ).toLowerCase();

      let metadata: ReturnType<typeof publishMetadataFromRequest>;
      let bytes: Buffer;
      let extraMetadata: Record<string, unknown> = {};

      if (contentType.includes("application/json")) {
        const body = await readJson(
          request,
          Math.floor(maxPackageBytes() * 1.45) + 1024 * 1024
        );
        metadata = {
          packageKey: clean(body.key, 120),
          name: clean(body.name, 180),
          version: clean(body.version, 100),
          filename: clean(body.filename, 220),
          format: clean(body.format, 80) || "generic",
          mediaType:
            clean(body.mediaType, 160) || "application/octet-stream",
          channel: clean(body.channel, 80) || null,
          commitSha: clean(body.commitSha, 64) || null,
          runId: clean(body.runId, 240) || null
        };
        const encoded = String(body.base64 ?? "");
        bytes = Buffer.from(encoded, "base64");
        extraMetadata =
          body.metadata &&
          typeof body.metadata === "object" &&
          !Array.isArray(body.metadata)
            ? body.metadata as Record<string, unknown>
            : {};
      } else {
        metadata = publishMetadataFromRequest(request, url);
        bytes = await readBuffer(request, maxPackageBytes());
      }

      const result = await publishKoshPackage({
        repository,
        packageKey: metadata.packageKey,
        name: metadata.name || metadata.packageKey,
        version: metadata.version,
        filename: metadata.filename,
        format: metadata.format,
        mediaType: metadata.mediaType,
        bytes,
        commitSha: metadata.commitSha,
        runId: metadata.runId,
        provenance: {
          source: "api",
          actorUserId: identity.user.id,
          actorName: identity.user.displayName
        },
        metadata: extraMetadata,
        actor: {
          id: identity.user.id,
          displayName: identity.user.displayName
        },
        channel: metadata.channel
      });

      json(response, 201, result, origin, allowedOrigins);
      return true;
    }

    const channelMatch = tail.match(
      /^([^/]+)\/channels\/([^/]+)(?:\/(download))?$/
    );
    if (channelMatch) {
      const packageKey = decodeURIComponent(channelMatch[1]);
      const channelName = decodeURIComponent(channelMatch[2]);

      if (
        !validPackageKey(packageKey) ||
        !validChannel(channelName)
      ) {
        throw Object.assign(new Error("invalid_package_channel"), {
          status: 400
        });
      }

      if (request.method === "GET") {
        const channel = await packageStore.getChannel(
          repository.id,
          packageKey,
          channelName
        );
        if (!channel) {
          throw Object.assign(new Error("package_channel_not_found"), {
            status: 404
          });
        }
        const version = await packageStore.getVersionById(
          repository.id,
          channel.versionId
        );
        if (!version) {
          throw Object.assign(new Error("package_channel_target_missing"), {
            status: 500
          });
        }

        if (channelMatch[3] === "download") {
          await sendArtifact(response, version);
          return true;
        }

        json(
          response,
          200,
          { channel, version },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (request.method === "POST" || request.method === "PUT") {
        const body = await readJson(request);
        const versionName = clean(body.version, 100);
        const version = await packageStore.getVersion(
          repository.id,
          packageKey,
          versionName
        );
        if (!version) {
          throw Object.assign(new Error("package_version_not_found"), {
            status: 404
          });
        }
        if (version.state !== "published") {
          throw Object.assign(new Error("package_version_not_promotable"), {
            status: 409
          });
        }

        await verifiedArtifact(version);

        const channel = await packageStore.putChannel({
          repositoryId: repository.id,
          packageKey,
          channel: channelName,
          versionId: version.id,
          version: version.version,
          updatedByUserId: identity.user.id,
          updatedByName: identity.user.displayName
        });

        await audit(
          repository.id,
          {
            id: identity.user.id,
            displayName: identity.user.displayName
          },
          "package_channel_promoted",
          version.id,
          {
            packageKey,
            channel: channel.channel,
            version: version.version
          }
        );

        json(
          response,
          200,
          { channel, version },
          origin,
          allowedOrigins
        );
        return true;
      }
    }

    const versionMatch = tail.match(
      /^([^/]+)\/versions\/([^/]+)(?:\/(download|yank|verify))?$/
    );
    if (versionMatch) {
      const packageKey = decodeURIComponent(versionMatch[1]);
      const versionName = decodeURIComponent(versionMatch[2]);
      const action = versionMatch[3] ?? "";

      if (
        !validPackageKey(packageKey) ||
        !validVersion(versionName)
      ) {
        throw Object.assign(new Error("invalid_package_identity"), {
          status: 400
        });
      }

      const version = await packageStore.getVersion(
        repository.id,
        packageKey,
        versionName
      );
      if (!version) {
        throw Object.assign(new Error("package_version_not_found"), {
          status: 404
        });
      }

      if (request.method === "GET" && action === "download") {
        await sendArtifact(response, version);
        return true;
      }

      if (request.method === "GET" && action === "verify") {
        const bytes = await verifiedArtifact(version);
        json(
          response,
          200,
          {
            valid: true,
            sizeBytes: bytes.length,
            sha256: sha256(bytes),
            expectedSha256: version.sha256
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (request.method === "POST" && action === "yank") {
        const body = await readJson(request);
        const state: KoshPackageState =
          body.yanked === false ? "published" : "yanked";
        const updated = await packageStore.setVersionState(
          repository.id,
          version.id,
          state
        );
        if (!updated) {
          throw Object.assign(new Error("package_version_not_found"), {
            status: 404
          });
        }

        await audit(
          repository.id,
          {
            id: identity.user.id,
            displayName: identity.user.displayName
          },
          state === "yanked"
            ? "package_version_yanked"
            : "package_version_restored",
          updated.id,
          {
            packageKey,
            version: versionName,
            sha256: updated.sha256
          }
        );

        json(response, 200, updated, origin, allowedOrigins);
        return true;
      }

      if (request.method === "GET" && action === "") {
        json(response, 200, version, origin, allowedOrigins);
        return true;
      }
    }

    json(
      response,
      404,
      { error: "kosh_package_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
