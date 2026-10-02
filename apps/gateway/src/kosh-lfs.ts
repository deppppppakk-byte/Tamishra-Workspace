import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import type { StoredKoshRepository } from "./kosh-store.js";

const lfsRoot = resolve(process.env.KOSH_LFS_ROOT?.trim() || ".kosh/lfs");
const maxObjectBytes =
  Math.max(1, Number(process.env.KOSH_LFS_MAX_MB) || 1024) *
  1024 *
  1024;

type LfsObject = {
  oid: string;
  size: number;
};

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader(
    "content-type",
    "application/vnd.git-lfs+json; charset=utf-8"
  );
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

function validOid(value: string) {
  return /^[0-9a-f]{64}$/i.test(value);
}

function objectPath(repositoryId: string, oid: string) {
  if (!validOid(oid)) {
    throw Object.assign(new Error("invalid_lfs_oid"), { status: 400 });
  }
  const path = resolve(
    lfsRoot,
    repositoryId,
    oid.slice(0, 2),
    oid.slice(2, 4),
    oid.toLowerCase()
  );
  const prefix = lfsRoot.endsWith(sep) ? lfsRoot : lfsRoot + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_lfs_path"), { status: 400 });
  }
  return path;
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 1024 * 1024
) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("lfs_payload_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw Object.assign(new Error("invalid_lfs_json"), { status: 400 });
  }
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function href(baseUrl: string, oid: string) {
  return baseUrl.replace(/\/$/, "") + "/info/lfs/objects/" + oid;
}

async function uploadObject(
  request: IncomingMessage,
  repositoryId: string,
  oid: string
) {
  const finalPath = objectPath(repositoryId, oid);
  const directory = resolve(finalPath, "..");
  await mkdir(directory, { recursive: true });

  if (await exists(finalPath)) {
    return stat(finalPath);
  }

  const tempPath = finalPath + ".tmp-" + randomUUID();
  const handle = await open(tempPath, "wx");
  const hash = createHash("sha256");
  let size = 0;

  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxObjectBytes) {
        throw Object.assign(new Error("lfs_object_too_large"), { status: 413 });
      }
      hash.update(buffer);
      await handle.write(buffer);
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  await handle.close();
  const digest = hash.digest("hex");
  if (digest.toLowerCase() !== oid.toLowerCase()) {
    await unlink(tempPath).catch(() => undefined);
    throw Object.assign(new Error("lfs_oid_mismatch"), { status: 422 });
  }

  await rename(tempPath, finalPath).catch(async (error) => {
    if (await exists(finalPath)) {
      await unlink(tempPath).catch(() => undefined);
      return;
    }
    throw error;
  });

  return stat(finalPath);
}

export async function handleKoshLfsRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  repository: StoredKoshRepository;
  suffix: string;
  baseUrl: string;
  canRead: boolean;
  canWrite: boolean;
}) {
  const {
    request,
    response,
    repository,
    suffix,
    baseUrl,
    canRead,
    canWrite
  } = input;

  if (!suffix.startsWith("/info/lfs/")) return false;

  try {
    if (
      request.method === "POST" &&
      suffix === "/info/lfs/objects/batch"
    ) {
      const body = await readJson(request);
      const operation =
        body.operation === "upload" || body.operation === "download"
          ? body.operation
          : "download";

      if (
        operation === "upload" &&
        !canWrite
      ) {
        response.statusCode = 401;
        response.setHeader("www-authenticate", 'Basic realm="Kosh Git LFS"');
        response.end();
        return true;
      }

      if (
        operation === "download" &&
        repository.visibility !== "public" &&
        !canRead
      ) {
        response.statusCode = 401;
        response.setHeader("www-authenticate", 'Basic realm="Kosh Git LFS"');
        response.end();
        return true;
      }

      const objects = Array.isArray(body.objects)
        ? body.objects.slice(0, 1000)
        : [];

      const result = [];
      for (const raw of objects) {
        const item =
          raw && typeof raw === "object"
            ? raw as Record<string, unknown>
            : {};
        const oid = String(item.oid ?? "").toLowerCase();
        const size = Number(item.size ?? 0);

        if (!validOid(oid) || !Number.isFinite(size) || size < 0) {
          result.push({
            oid,
            size,
            error: {
              code: 422,
              message: "Invalid LFS object descriptor."
            }
          });
          continue;
        }

        const path = objectPath(repository.id, oid);
        const present = await exists(path);

        if (operation === "download") {
          if (!present) {
            result.push({
              oid,
              size,
              error: { code: 404, message: "LFS object not found." }
            });
            continue;
          }

          result.push({
            oid,
            size,
            actions: {
              download: {
                href: href(baseUrl, oid)
              }
            }
          });
          continue;
        }

        result.push({
          oid,
          size,
          ...(present
            ? {}
            : {
                actions: {
                  upload: {
                    href: href(baseUrl, oid),
                    header: {
                      "content-type": "application/octet-stream"
                    }
                  },
                  verify: {
                    href: href(baseUrl, oid) + "/verify"
                  }
                }
              })
        });
      }

      json(response, 200, {
        transfer: "basic",
        objects: result
      });
      return true;
    }

    const objectMatch = suffix.match(
      /^\/info\/lfs\/objects\/([0-9a-fA-F]{64})(\/verify)?$/
    );
    if (!objectMatch) {
      json(response, 404, {
        message: "Kosh LFS route not found."
      });
      return true;
    }

    const oid = objectMatch[1].toLowerCase();
    const verify = Boolean(objectMatch[2]);

    if (verify && request.method === "POST") {
      if (!canWrite) {
        response.statusCode = 401;
        response.end();
        return true;
      }
      const body = await readJson(request, 128 * 1024);
      const expectedSize = Number(body.size ?? -1);
      const path = objectPath(repository.id, oid);
      if (!(await exists(path))) {
        json(response, 404, { message: "LFS object not found." });
        return true;
      }
      const info = await stat(path);
      json(
        response,
        info.size === expectedSize ? 200 : 422,
        info.size === expectedSize
          ? {}
          : { message: "LFS size mismatch." }
      );
      return true;
    }

    if (request.method === "PUT") {
      if (!canWrite) {
        response.statusCode = 401;
        response.end();
        return true;
      }
      const info = await uploadObject(request, repository.id, oid);
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ oid, size: info.size }));
      return true;
    }

    if (request.method === "GET") {
      if (repository.visibility !== "public" && !canRead) {
        response.statusCode = 401;
        response.end();
        return true;
      }
      const path = objectPath(repository.id, oid);
      if (!(await exists(path))) {
        response.statusCode = 404;
        response.end();
        return true;
      }
      const info = await stat(path);
      response.statusCode = 200;
      response.setHeader("content-type", "application/octet-stream");
      response.setHeader("content-length", String(info.size));
      response.setHeader("cache-control", "private, max-age=31536000, immutable");
      createReadStream(path).pipe(response);
      return true;
    }

    response.statusCode = 405;
    response.end();
    return true;
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status) || 500
        : 500;
    json(response, status, {
      message: error instanceof Error ? error.message : "Kosh LFS error."
    });
    return true;
  }
}
