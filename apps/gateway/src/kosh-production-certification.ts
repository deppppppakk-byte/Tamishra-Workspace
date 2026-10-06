import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshControllerClusterStatus } from "./kosh-controller-cluster.js";
import { getKoshManagedBuildPoolStatus } from "./kosh-managed-build-pool.js";
import { getKoshPackageStore } from "./kosh-package-store.js";
import { getKoshReleaseStore } from "./kosh-release-store.js";
import { getKoshStore } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositories = getKoshStore();
const packages = getKoshPackageStore();
const releases = getKoshReleaseStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");

type Identity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function json(response: ServerResponse, status: number, body: unknown, origin: string | undefined, allowed: ReadonlySet<string>) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowed.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

function admin(identity: Identity) {
  const configured = new Set((process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  if (configured.size) return configured.has(identity.user.id);
  return identity.memberships.some((item) => !item.membership.disabled && ["owner", "admin"].includes(item.membership.role));
}

async function refCount(namespace: string, slug: string) {
  const repository = await repositories.get(namespace, slug);
  if (!repository) return { exists: false, refs: 0 };
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  try {
    const result = await execFileAsync(
      "git",
      ["--git-dir", path, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"],
      { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }
    );
    return {
      exists: true,
      refs: String(result.stdout).split(/\r?\n/).filter(Boolean).length
    };
  } catch {
    return { exists: true, refs: 0 };
  }
}

export async function getKoshProductionCertification() {
  const [buildPool, controllerCluster] = await Promise.all([
    getKoshManagedBuildPoolStatus(),
    getKoshControllerClusterStatus()
  ]);
  const [kavynRefs, osRefs, repoList] = await Promise.all([
    refCount("tamishra", "kavyn-2d"),
    refCount("tamishra", "os"),
    repositories.list()
  ]);

  let exePackages = 0;
  let apkPackages = 0;
  let aabPackages = 0;
  let publishedReleases = 0;
  let stableChannels = 0;

  for (const repository of repoList) {
    const [versions, releaseList, channels] = await Promise.all([
      packages.listVersions(repository.id),
      releases.listReleases(repository.id),
      releases.listChannels(repository.id)
    ]);
    exePackages += versions.filter((item) => item.state === "published" && item.filename.toLowerCase().endsWith(".exe")).length;
    apkPackages += versions.filter((item) => item.state === "published" && item.filename.toLowerCase().endsWith(".apk")).length;
    aabPackages += versions.filter((item) => item.state === "published" && item.filename.toLowerCase().endsWith(".aab")).length;
    publishedReleases += releaseList.filter((item) => item.state === "published").length;
    stableChannels += channels.filter((item) => item.channel === "stable").length;
  }

  const cloudEnabled = process.env.KOSH_CLOUD_ENABLED?.trim().toLowerCase() === "true";
  const checks = [
    {
      id: "online-persistence",
      ok: repositories.kind === "postgres" && Boolean(process.env.WORKSPACE_DATABASE_URL?.trim()),
      detail: repositories.kind === "postgres" ? "Postgres-backed Kosh repository metadata is active." : "Online Postgres persistence is not active."
    },
    {
      id: "cloud-controller",
      ok: cloudEnabled && controllerCluster.databaseBacked && controllerCluster.activeInstances >= 1,
      detail: cloudEnabled
        ? `${controllerCluster.activeInstances} active database-backed controller instance(s); leader ${controllerCluster.leader || "pending"}.`
        : "Kosh Cloud controller mode is disabled."
    },
    {
      id: "windows-build-capacity",
      ok: buildPool.windows.ready,
      detail: `${buildPool.windows.currentWorkers}/${buildPool.windows.desiredWorkers} current Windows build workers.`
    },
    {
      id: "android-build-capacity",
      ok: buildPool.android.ready,
      detail: `${buildPool.android.currentWorkers}/${buildPool.android.desiredWorkers} current Android build workers.`
    },
    {
      id: "kavyn-history",
      ok: kavynRefs.exists && kavynRefs.refs > 0,
      detail: `${kavynRefs.refs} Git refs found in tamishra/kavyn-2d.`
    },
    {
      id: "os-history",
      ok: osRefs.exists && osRefs.refs > 0,
      detail: `${osRefs.refs} Git refs found in tamishra/os.`
    },
    {
      id: "windows-exe-proof",
      ok: exePackages > 0,
      detail: `${exePackages} published EXE package(s) found.`
    },
    {
      id: "android-package-proof",
      ok: apkPackages > 0 && aabPackages > 0,
      detail: `${apkPackages} APK and ${aabPackages} AAB published package(s) found.`
    },
    {
      id: "release-proof",
      ok: publishedReleases > 0 && stableChannels > 0,
      detail: `${publishedReleases} published release(s), ${stableChannels} stable channel(s).`
    }
  ];

  return {
    checkedAt: new Date().toISOString(),
    certified: checks.every((check) => check.ok),
    passed: checks.filter((check) => check.ok).length,
    total: checks.length,
    checks,
    controllerCluster,
    buildPool,
    artifacts: { exePackages, apkPackages, aabPackages, publishedReleases, stableChannels }
  };
}

export async function handleKoshProductionCertificationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (url.pathname !== "/v1/kosh/systems/production-certification" || request.method !== "GET") return false;
  const identity = await resolveKoshIdentity(request);
  if (!identity || !admin(identity)) {
    json(response, identity ? 403 : 401, {
      error: identity ? "platform_admin_required" : "authentication_required"
    }, origin, allowedOrigins);
    return true;
  }
  try {
    json(response, 200, await getKoshProductionCertification(), origin, allowedOrigins);
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : "production_certification_failed"
    }, origin, allowedOrigins);
  }
  return true;
}
