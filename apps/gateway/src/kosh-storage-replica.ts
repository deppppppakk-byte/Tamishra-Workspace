import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { materializeKoshObject, readKoshObject, type KoshObjectLocator } from "./kosh-object-storage.js";
import type { KoshStorageClass } from "./kosh-storage-policy.js";

const replicaRoot = resolve(process.env.KOSH_REPLICA_ROOT?.trim() || ".kosh/replica");

function safePath(root: string, ...parts: string[]) {
  const path = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (path !== root && !path.startsWith(prefix)) {
    throw Object.assign(new Error("replica_path_invalid"), { status: 500 });
  }
  return path;
}

function hashFile(path: string) {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function koshReplicaConfigured() {
  return Boolean(process.env.KOSH_REPLICA_ROOT?.trim());
}

export function koshReplicaObjectPath(
  repositoryId: string,
  storageClass: KoshStorageClass,
  logicalId: string
) {
  const digest = createHash("sha256")
    .update(repositoryId)
    .update("\0")
    .update(storageClass)
    .update("\0")
    .update(logicalId)
    .digest("hex");
  return safePath(replicaRoot, repositoryId.replace(/[^a-zA-Z0-9._-]+/g, "_"), storageClass, digest + ".object");
}

export async function verifyKoshReplica(input: {
  repositoryId: string;
  storageClass: KoshStorageClass;
  logicalId: string;
  sizeBytes: number;
  sha256: string;
}) {
  if (!koshReplicaConfigured()) return { configured: false, valid: false, path: null };
  const path = koshReplicaObjectPath(input.repositoryId, input.storageClass, input.logicalId);
  const info = await stat(path).catch(() => null);
  if (!info || info.size !== input.sizeBytes) {
    return { configured: true, valid: false, path };
  }
  const checksum = await hashFile(path).catch(() => "");
  return {
    configured: true,
    valid: checksum === input.sha256,
    path,
    sizeBytes: info.size,
    sha256: checksum
  };
}

export async function materializeKoshObjectWithReplica(input: {
  repositoryId: string;
  storageClass: KoshStorageClass;
  logicalId: string;
  locator: KoshObjectLocator | null;
  localFallbackPath: string;
  destinationPath: string;
  sizeBytes: number;
  sha256: string;
}) {
  try {
    await materializeKoshObject(input.locator, input.localFallbackPath, input.destinationPath);
    return { path: input.destinationPath, source: "primary" as const };
  } catch (primaryError) {
    const replica = await verifyKoshReplica(input);
    if (!replica.valid || !replica.path) throw primaryError;
    await rm(input.destinationPath, { force: true }).catch(() => undefined);
    await mkdir(dirname(input.destinationPath), { recursive: true });
    await copyFile(replica.path, input.destinationPath);
    return { path: input.destinationPath, source: "replica" as const };
  }
}

export async function readKoshObjectWithReplica(input: {
  repositoryId: string;
  storageClass: KoshStorageClass;
  logicalId: string;
  locator: KoshObjectLocator | null;
  localFallbackPath: string;
  sizeBytes: number;
  sha256: string;
}) {
  try {
    return { bytes: await readKoshObject(input.locator, input.localFallbackPath), source: "primary" as const };
  } catch (primaryError) {
    const replica = await verifyKoshReplica(input);
    if (!replica.valid || !replica.path) throw primaryError;
    return { bytes: await readFile(replica.path), source: "replica" as const };
  }
}
