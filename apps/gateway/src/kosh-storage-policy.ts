import { getKoshPackageStore } from "./kosh-package-store.js";
import { automationStore } from "./kosh-automation-service.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { getKoshReleaseStore } from "./kosh-release-store.js";

export type KoshStorageClass = "artifact" | "package" | "release" | "backup";

const platformStore = getKoshPlatformStore();
const packageStore = getKoshPackageStore();
const releaseStore = getKoshReleaseStore();
const automation = automationStore();

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

async function repositoryPolicy(repositoryId: string) {
  const policies = await platformStore.listResources("storage_policy", repositoryId);
  return policies.find((item) => item.key === "default" && item.state === "active") ?? null;
}

async function defaultQuotaBytes() {
  const settings = await platformStore.listResources("admin_setting", null);
  const setting = settings.find((item) => item.key === "default_storage_quota_bytes");
  return boundedNumber(setting?.payload.value, 50 * 1024 ** 3, 1024 ** 3, 10 * 1024 ** 4);
}

export async function koshKnownStorageUsage(repositoryId: string) {
  await Promise.all([platformStore.ready(), packageStore.ready(), releaseStore.ready(), automation.ready()]);

  const [packages, releases, runs, backups] = await Promise.all([
    packageStore.listVersions(repositoryId),
    releaseStore.listReleases(repositoryId),
    automation.listRuns(repositoryId, 500),
    platformStore.listResources("backup", repositoryId)
  ]);

  const releaseAssets = (
    await Promise.all(releases.slice(0, 500).map((release) => releaseStore.listAssets(release.id)))
  ).flat();
  const artifacts = (
    await Promise.all(runs.map((run) => automation.listArtifacts(run.id)))
  ).flat();

  const packageBytes = packages.reduce((total, item) => total + Math.max(0, item.sizeBytes), 0);
  const releaseBytes = releaseAssets.reduce((total, item) => total + Math.max(0, item.sizeBytes), 0);
  const artifactBytes = artifacts.reduce((total, item) => total + Math.max(0, item.sizeBytes), 0);
  const backupBytes = backups
    .filter((item) => item.payload.kind === "git-bundle" || !item.payload.kind)
    .reduce((total, item) => total + Math.max(0, Number(item.payload.sizeBytes) || 0), 0);

  return {
    packageBytes,
    releaseBytes,
    artifactBytes,
    backupBytes,
    knownBytes: packageBytes + releaseBytes + artifactBytes + backupBytes
  };
}

export async function koshStorageLimits(repositoryId: string) {
  await platformStore.ready();
  const [policy, fallbackTotal] = await Promise.all([
    repositoryPolicy(repositoryId),
    defaultQuotaBytes()
  ]);

  return {
    policyId: policy?.id ?? null,
    maxTotalBytes: boundedNumber(policy?.payload.maxTotalBytes, fallbackTotal, 1024 ** 3, 10 * 1024 ** 4),
    maxArtifactBytes: boundedNumber(policy?.payload.maxArtifactBytes, 1024 ** 3, 1024 ** 2, 10 * 1024 ** 3),
    // Desktop installers and CAD/engineering binaries routinely exceed 64 MB.
    // Keep individual Kosh packages at 512 MB by default, with a policy ceiling
    // of 2 GB when a repository explicitly opts in.
    maxPackageBytes: boundedNumber(policy?.payload.maxPackageBytes, 512 * 1024 ** 2, 1024 ** 2, 2 * 1024 ** 3),
    maxReleaseBytes: boundedNumber(policy?.payload.maxReleaseBytes, 2 * 1024 ** 3, 1024 ** 2, 20 * 1024 ** 3),
    maxBackupBytes: boundedNumber(policy?.payload.maxBackupBytes, 2 * 1024 ** 3, 16 * 1024 ** 2, 16 * 1024 ** 3)
  };
}

export function koshStorageObjectLimit(
  storageClass: KoshStorageClass,
  limits: Awaited<ReturnType<typeof koshStorageLimits>>
) {
  if (storageClass === "artifact") return limits.maxArtifactBytes;
  if (storageClass === "package") return limits.maxPackageBytes;
  if (storageClass === "release") return limits.maxReleaseBytes;
  return limits.maxBackupBytes;
}

export async function assertKoshStorageCapacity(
  repositoryId: string,
  storageClass: KoshStorageClass,
  incomingBytes: number
) {
  const bytes = Math.max(0, Math.floor(Number(incomingBytes) || 0));
  const [usage, limits] = await Promise.all([
    koshKnownStorageUsage(repositoryId),
    koshStorageLimits(repositoryId)
  ]);
  const perObjectLimit = koshStorageObjectLimit(storageClass, limits);

  if (bytes > perObjectLimit) {
    throw Object.assign(new Error("storage_object_limit_exceeded"), {
      status: 413,
      storageClass,
      incomingBytes: bytes,
      limitBytes: perObjectLimit
    });
  }

  if (usage.knownBytes + bytes > limits.maxTotalBytes) {
    throw Object.assign(new Error("repository_storage_quota_exceeded"), {
      status: 413,
      storageClass,
      incomingBytes: bytes,
      knownBytes: usage.knownBytes,
      limitBytes: limits.maxTotalBytes
    });
  }

  return {
    allowed: true as const,
    storageClass,
    incomingBytes: bytes,
    knownBytesBefore: usage.knownBytes,
    knownBytesAfter: usage.knownBytes + bytes,
    limits
  };
}
