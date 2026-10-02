import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshPackageStore } from "./kosh-package-store.js";
import { verifyKoshPackageVersion } from "./kosh-packages.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import {
  getKoshReleaseStore,
  type StoredKoshRelease,
  type StoredKoshReleaseAsset
} from "./kosh-release-store.js";
import {
  getKoshStore,
  type StoredKoshRepository
} from "./kosh-store.js";
import { dispatchKoshWebhooks } from "./kosh-webhooks.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const packageStore = getKoshPackageStore();
const releaseStore = getKoshReleaseStore();
const platformStore = getKoshPlatformStore();
const repositoryRoot = resolve(
  process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos"
);
const releaseRoot = resolve(
  process.env.KOSH_RELEASE_ROOT?.trim() || ".kosh/releases"
);

type JsonBody = Record<string, unknown>;

type ReleaseActor = {
  id: string;
  displayName: string;
};

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validTag(value: string) {
  return (
    value.length > 0 &&
    value.length <= 180 &&
    !/[\s~^:?*\[]/.test(value) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
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

function maxReleaseAssetBytes() {
  const configured = Number(process.env.KOSH_RELEASE_ASSET_MAX_MB ?? 64);
  const mb = Number.isFinite(configured)
    ? Math.max(1, Math.min(2048, configured))
    : 64;
  return Math.floor(mb * 1024 * 1024);
}

function safeStoragePath(root: string, ...parts: string[]) {
  const path = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (path !== root && !path.startsWith(prefix)) {
    throw Object.assign(new Error("release_storage_path_invalid"), {
      status: 400
    });
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

function assetPath(asset: StoredKoshReleaseAsset) {
  return safeStoragePath(
    releaseRoot,
    asset.repositoryId,
    asset.releaseId,
    asset.id,
    asset.filename
  );
}

async function git(
  repository: StoredKoshRepository,
  args: string[],
  allowFailure = false
) {
  try {
    const result = await execFileAsync(
      "git",
      ["--git-dir", repositoryPath(repository), ...args],
      {
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8"
      }
    );
    return String(result.stdout).trim();
  } catch (error) {
    if (allowFailure) return "";
    const value = error as { stderr?: string };
    throw Object.assign(
      new Error(String(value.stderr || "release_git_command_failed").trim()),
      { status: 409 }
    );
  }
}

async function resolveCommit(
  repository: StoredKoshRepository,
  refName: string
) {
  const ref = refName || repository.defaultBranch;
  const sha = await git(repository, [
    "rev-parse",
    "--verify",
    ref + "^{commit}"
  ]);
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw Object.assign(new Error("release_ref_not_found"), {
      status: 404
    });
  }
  return sha;
}

async function ensureGitTag(
  repository: StoredKoshRepository,
  tag: string,
  commitSha: string
) {
  const existing = await git(
    repository,
    ["rev-parse", "--verify", "refs/tags/" + tag + "^{commit}"],
    true
  );

  if (existing) {
    if (existing !== commitSha) {
      throw Object.assign(new Error("release_tag_points_elsewhere"), {
        status: 409
      });
    }
    return false;
  }

  await git(repository, ["tag", tag, commitSha]);
  return true;
}

async function deleteGitTag(
  repository: StoredKoshRepository,
  tag: string,
  commitSha: string
) {
  await git(
    repository,
    ["update-ref", "-d", "refs/tags/" + tag, commitSha],
    true
  );
}

async function lockPublishedReleaseTag(
  repository: StoredKoshRepository,
  tag: string,
  commitSha: string
) {
  const gitDir = repositoryPath(repository);
  const path = safeStoragePath(gitDir, "kosh-release-tags");
  const temporary = safeStoragePath(
    gitDir,
    "kosh-release-tags.tmp-" + process.pid + "-" + randomUUID()
  );
  const ref = "refs/tags/" + tag;

  let lines: string[] = [];
  try {
    lines = (await readFile(path, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    lines = [];
  }

  const existing = lines.find((line) => line.split(/\s+/)[0] === ref);
  if (existing) {
    const expected = existing.split(/\s+/)[1] ?? "";
    if (expected !== commitSha) {
      throw Object.assign(new Error("release_tag_lock_conflict"), {
        status: 409
      });
    }
    return;
  }

  lines.push(ref + " " + commitSha);
  lines.sort();

  await writeFile(
    temporary,
    lines.join("\n") + "\n",
    { encoding: "utf8", flag: "wx" }
  );
  await rename(temporary, path);
}

async function readBuffer(
  request: IncomingMessage,
  maxBytes: number
) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("release_asset_too_large"), {
        status: 413
      });
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
  actor: ReleaseActor,
  eventType: string,
  releaseId: string,
  metadata: Record<string, unknown>
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType,
    resourceType: "release",
    resourceId: releaseId,
    metadata
  });
}

async function verifyReleaseAsset(asset: StoredKoshReleaseAsset) {
  let bytes: Buffer;
  try {
    bytes = await readFile(assetPath(asset));
  } catch {
    throw Object.assign(new Error("release_asset_missing"), {
      status: 500
    });
  }
  const actual = sha256(bytes);
  if (bytes.length !== asset.sizeBytes || actual !== asset.sha256) {
    throw Object.assign(new Error("release_asset_integrity_failure"), {
      status: 500
    });
  }
  return {
    sizeBytes: bytes.length,
    sha256: actual
  };
}

async function hydrateRelease(release: StoredKoshRelease) {
  const [assets, packages, channels] = await Promise.all([
    releaseStore.listAssets(release.id),
    releaseStore.listPackages(release.id),
    releaseStore.listChannels(release.repositoryId)
  ]);

  return {
    ...release,
    assets,
    packages,
    channels: channels.filter(
      (channel) => channel.releaseId === release.id
    )
  };
}

async function validateLinkedPackages(
  repositoryId: string,
  packageVersionIds: string[]
) {
  const result = [];
  for (const id of [...new Set(packageVersionIds)].slice(0, 100)) {
    const version = await packageStore.getVersionById(repositoryId, id);
    if (!version) {
      throw Object.assign(new Error("release_package_not_found"), {
        status: 404
      });
    }
    if (version.state !== "published") {
      throw Object.assign(new Error("release_package_not_published"), {
        status: 409
      });
    }
    await verifyKoshPackageVersion(version);
    result.push(version);
  }
  return result;
}

async function createRelease(input: {
  repository: StoredKoshRepository;
  tag: string;
  name: string;
  notes: string;
  refName: string;
  prerelease: boolean;
  packageVersionIds: string[];
  actor: ReleaseActor;
  provenance: Record<string, unknown>;
}) {
  if (!validTag(input.tag) || !input.name) {
    throw Object.assign(new Error("invalid_release_identity"), {
      status: 400
    });
  }

  await git(
    input.repository,
    ["check-ref-format", "refs/tags/" + input.tag]
  );

  const commitSha = await resolveCommit(
    input.repository,
    input.refName
  );
  const packages = await validateLinkedPackages(
    input.repository.id,
    input.packageVersionIds
  );

  const createdTag = await ensureGitTag(
    input.repository,
    input.tag,
    commitSha
  );

  let release: StoredKoshRelease | null = null;
  try {
    release = await releaseStore.createRelease({
      id: randomUUID(),
      repositoryId: input.repository.id,
      tag: input.tag,
      name: input.name,
      notes: input.notes,
      commitSha,
      state: "draft",
      prerelease: input.prerelease,
      provenance: {
        ...input.provenance,
        repositoryId: input.repository.id,
        namespace: input.repository.namespace,
        repository: input.repository.slug,
        tag: input.tag,
        commitSha
      },
      createdByUserId: input.actor.id,
      createdByName: input.actor.displayName
    });

    for (const packageVersion of packages) {
      await releaseStore.linkPackage({
        repositoryId: input.repository.id,
        releaseId: release.id,
        packageVersionId: packageVersion.id,
        packageKey: packageVersion.packageKey,
        version: packageVersion.version,
        sha256: packageVersion.sha256
      });
    }
  } catch (error) {
    if (release) {
      await releaseStore.deleteReleaseForRollback(
        input.repository.id,
        release.id
      ).catch(() => undefined);
    }
    if (createdTag) {
      await deleteGitTag(
        input.repository,
        input.tag,
        commitSha
      ).catch(() => undefined);
    }
    throw error;
  }

  if (!release) {
    throw Object.assign(new Error("release_creation_failed"), {
      status: 500
    });
  }

  await audit(
    input.repository.id,
    input.actor,
    "release_created",
    release.id,
    {
      tag: release.tag,
      commitSha: release.commitSha,
      prerelease: release.prerelease,
      packageVersionIds: packages.map((item) => item.id)
    }
  );

  return hydrateRelease(release);
}

async function publishRelease(input: {
  repository: StoredKoshRepository;
  release: StoredKoshRelease;
  actor: ReleaseActor;
  channel?: string | null;
}) {
  if (input.release.state !== "draft") {
    throw Object.assign(new Error("release_not_publishable"), {
      status: 409
    });
  }

  const tagCommit = await resolveCommit(
    input.repository,
    "refs/tags/" + input.release.tag
  );
  if (tagCommit !== input.release.commitSha) {
    throw Object.assign(new Error("release_tag_commit_mismatch"), {
      status: 409
    });
  }

  const [assets, packages] = await Promise.all([
    releaseStore.listAssets(input.release.id),
    releaseStore.listPackages(input.release.id)
  ]);

  for (const asset of assets) {
    await verifyReleaseAsset(asset);
  }

  for (const link of packages) {
    const packageVersion = await packageStore.getVersionById(
      input.repository.id,
      link.packageVersionId
    );
    if (
      !packageVersion ||
      packageVersion.state !== "published" ||
      packageVersion.sha256 !== link.sha256
    ) {
      throw Object.assign(new Error("release_package_integrity_failure"), {
        status: 409
      });
    }
    await verifyKoshPackageVersion(packageVersion);
  }

  if (input.channel && !validChannel(input.channel)) {
    throw Object.assign(new Error("invalid_release_channel"), {
      status: 400
    });
  }

  await lockPublishedReleaseTag(
    input.repository,
    input.release.tag,
    input.release.commitSha
  );

  const published = await releaseStore.setReleaseState(
    input.repository.id,
    input.release.id,
    "published"
  );
  if (!published) {
    throw Object.assign(new Error("release_not_found"), {
      status: 404
    });
  }

  let channel = null;
  if (input.channel) {
    channel = await releaseStore.putChannel({
      repositoryId: input.repository.id,
      channel: input.channel,
      releaseId: published.id,
      tag: published.tag,
      updatedByUserId: input.actor.id,
      updatedByName: input.actor.displayName
    });
  }

  await audit(
    input.repository.id,
    input.actor,
    "release_published",
    published.id,
    {
      tag: published.tag,
      commitSha: published.commitSha,
      prerelease: published.prerelease,
      channel: channel?.channel ?? null,
      packageCount: packages.length,
      assetCount: assets.length
    }
  );

  void dispatchKoshWebhooks(
    input.repository.id,
    "release.published",
    {
      releaseId: published.id,
      tag: published.tag,
      name: published.name,
      commitSha: published.commitSha,
      prerelease: published.prerelease,
      channel: channel?.channel ?? null,
      packageCount: packages.length,
      assetCount: assets.length
    }
  ).catch(() => undefined);

  return {
    release: await hydrateRelease(published),
    channel
  };
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
        error instanceof Error ? error.message : "kosh_release_error"
    },
    origin,
    allowedOrigins
  );
}

export async function handleKoshReleaseRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/releases(?:\/(.*))?$/
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
      releaseStore.ready(),
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
      const [releases, channels] = await Promise.all([
        releaseStore.listReleases(repository.id),
        releaseStore.listChannels(repository.id)
      ]);
      const hydrated = await Promise.all(
        releases.map((release) => hydrateRelease(release))
      );
      json(
        response,
        200,
        {
          releases: hydrated,
          channels,
          persistence: releaseStore.kind,
          maxAssetBytes: maxReleaseAssetBytes()
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "POST" && tail === "") {
      const body = await readJson(request);
      const packageVersionIds = Array.isArray(body.packageVersionIds)
        ? body.packageVersionIds.map(String).slice(0, 100)
        : [];

      const release = await createRelease({
        repository,
        tag: clean(body.tag, 180),
        name: clean(body.name, 240),
        notes: clean(body.notes, 100_000),
        refName: clean(body.ref, 240),
        prerelease: body.prerelease === true,
        packageVersionIds,
        actor: {
          id: identity.user.id,
          displayName: identity.user.displayName
        },
        provenance: {
          source: "api",
          actorUserId: identity.user.id,
          actorName: identity.user.displayName
        }
      });

      json(response, 201, release, origin, allowedOrigins);
      return true;
    }

    const channelMatch = tail.match(/^channels\/([^/]+)$/);
    if (channelMatch) {
      const channelName = decodeURIComponent(channelMatch[1]);
      if (!validChannel(channelName)) {
        throw Object.assign(new Error("invalid_release_channel"), {
          status: 400
        });
      }

      if (request.method === "GET") {
        const channel = await releaseStore.getChannel(
          repository.id,
          channelName
        );
        if (!channel) {
          throw Object.assign(new Error("release_channel_not_found"), {
            status: 404
          });
        }
        const release = await releaseStore.getReleaseById(
          repository.id,
          channel.releaseId
        );
        if (!release) {
          throw Object.assign(new Error("release_channel_target_missing"), {
            status: 500
          });
        }
        json(
          response,
          200,
          {
            channel,
            release: await hydrateRelease(release)
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (request.method === "POST" || request.method === "PUT") {
        const body = await readJson(request);
        const tag = clean(body.tag, 180);
        const release = await releaseStore.getRelease(
          repository.id,
          tag
        );
        if (!release) {
          throw Object.assign(new Error("release_not_found"), {
            status: 404
          });
        }
        if (release.state !== "published") {
          throw Object.assign(new Error("release_not_promotable"), {
            status: 409
          });
        }

        const channel = await releaseStore.putChannel({
          repositoryId: repository.id,
          channel: channelName,
          releaseId: release.id,
          tag: release.tag,
          updatedByUserId: identity.user.id,
          updatedByName: identity.user.displayName
        });

        await audit(
          repository.id,
          {
            id: identity.user.id,
            displayName: identity.user.displayName
          },
          "release_channel_promoted",
          release.id,
          {
            channel: channelName,
            tag: release.tag
          }
        );

        json(
          response,
          200,
          {
            channel,
            release: await hydrateRelease(release)
          },
          origin,
          allowedOrigins
        );
        return true;
      }
    }

    const releaseMatch = tail.match(/^([^/]+)(?:\/(.*))?$/);
    if (releaseMatch) {
      const tag = decodeURIComponent(releaseMatch[1]);
      const action = releaseMatch[2] ?? "";
      if (!validTag(tag)) {
        throw Object.assign(new Error("invalid_release_tag"), {
          status: 400
        });
      }

      const release = await releaseStore.getRelease(repository.id, tag);
      if (!release) {
        throw Object.assign(new Error("release_not_found"), {
          status: 404
        });
      }

      if (request.method === "GET" && action === "") {
        json(
          response,
          200,
          await hydrateRelease(release),
          origin,
          allowedOrigins
        );
        return true;
      }

      if (request.method === "POST" && action === "packages") {
        if (release.state !== "draft") {
          throw Object.assign(new Error("release_immutable_after_publish"), {
            status: 409
          });
        }
        const body = await readJson(request);
        const packageVersionId = clean(body.packageVersionId, 240);
        const versions = await validateLinkedPackages(
          repository.id,
          [packageVersionId]
        );
        const version = versions[0];
        if (!version) {
          throw Object.assign(new Error("release_package_not_found"), {
            status: 404
          });
        }
        const linked = await releaseStore.linkPackage({
          repositoryId: repository.id,
          releaseId: release.id,
          packageVersionId: version.id,
          packageKey: version.packageKey,
          version: version.version,
          sha256: version.sha256
        });
        json(response, 201, linked, origin, allowedOrigins);
        return true;
      }

      if (request.method === "POST" && action === "publish") {
        const body = await readJson(request);
        const result = await publishRelease({
          repository,
          release,
          actor: {
            id: identity.user.id,
            displayName: identity.user.displayName
          },
          channel: clean(body.channel, 80) || null
        });
        json(response, 200, result, origin, allowedOrigins);
        return true;
      }

      if (request.method === "POST" && action === "archive") {
        if (release.state !== "published") {
          throw Object.assign(new Error("release_not_archivable"), {
            status: 409
          });
        }
        const archived = await releaseStore.setReleaseState(
          repository.id,
          release.id,
          "archived"
        );
        if (!archived) {
          throw Object.assign(new Error("release_not_found"), {
            status: 404
          });
        }
        await audit(
          repository.id,
          {
            id: identity.user.id,
            displayName: identity.user.displayName
          },
          "release_archived",
          release.id,
          {
            tag: release.tag,
            commitSha: release.commitSha
          }
        );
        json(
          response,
          200,
          await hydrateRelease(archived),
          origin,
          allowedOrigins
        );
        return true;
      }

      const assetMatch = action.match(/^assets(?:\/([^/]+))?(?:\/(verify))?$/);
      if (assetMatch) {
        if (request.method === "POST" && !assetMatch[1]) {
          if (release.state !== "draft") {
            throw Object.assign(new Error("release_immutable_after_publish"), {
              status: 409
            });
          }

          const filename = clean(
            url.searchParams.get("filename"),
            220
          );
          const mediaType =
            clean(
              url.searchParams.get("mediaType") ||
                request.headers["content-type"],
              160
            ) || "application/octet-stream";

          if (!safeFilename(filename)) {
            throw Object.assign(new Error("release_asset_invalid"), {
              status: 400
            });
          }

          const bytes = await readBuffer(
            request,
            maxReleaseAssetBytes()
          );
          if (!bytes.length) {
            throw Object.assign(new Error("release_asset_invalid"), {
              status: 400
            });
          }

          const assetId = randomUUID();
          const directory = safeStoragePath(
            releaseRoot,
            repository.id,
            release.id,
            assetId
          );
          const path = safeStoragePath(directory, filename);
          await mkdir(directory, { recursive: true });

          try {
            await writeFile(path, bytes, { flag: "wx" });
          } catch (error) {
            await rm(directory, {
              recursive: true,
              force: true
            }).catch(() => undefined);
            throw error;
          }

          let asset: StoredKoshReleaseAsset;
          try {
            asset = await releaseStore.createAsset({
              id: assetId,
              repositoryId: repository.id,
              releaseId: release.id,
              filename,
              mediaType,
              sizeBytes: bytes.length,
              sha256: sha256(bytes)
            });
          } catch (error) {
            await rm(directory, {
              recursive: true,
              force: true
            }).catch(() => undefined);
            throw error;
          }

          await audit(
            repository.id,
            {
              id: identity.user.id,
              displayName: identity.user.displayName
            },
            "release_asset_added",
            release.id,
            {
              assetId: asset.id,
              filename: asset.filename,
              sizeBytes: asset.sizeBytes,
              sha256: asset.sha256
            }
          );

          json(response, 201, asset, origin, allowedOrigins);
          return true;
        }

        if (request.method === "GET" && assetMatch[1]) {
          const assetId = decodeURIComponent(assetMatch[1]);
          const asset = (await releaseStore.listAssets(release.id))
            .find((item) => item.id === assetId);
          if (!asset) {
            throw Object.assign(new Error("release_asset_not_found"), {
              status: 404
            });
          }

          const verification = await verifyReleaseAsset(asset);
          if (assetMatch[2] === "verify") {
            json(
              response,
              200,
              {
                valid: true,
                ...verification,
                expectedSha256: asset.sha256
              },
              origin,
              allowedOrigins
            );
            return true;
          }

          const bytes = await readFile(assetPath(asset));
          const filename = asset.filename.replace(/["\r\n]/g, "_");
          response.statusCode = 200;
          response.setHeader("content-type", asset.mediaType);
          response.setHeader("content-length", String(bytes.length));
          response.setHeader(
            "content-disposition",
            'attachment; filename="' + filename + '"'
          );
          response.setHeader("x-kosh-sha256", asset.sha256);
          response.setHeader("etag", '"' + asset.sha256 + '"');
          response.setHeader(
            "cache-control",
            "private, max-age=31536000, immutable"
          );
          response.end(bytes);
          return true;
        }
      }
    }

    json(
      response,
      404,
      { error: "kosh_release_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
