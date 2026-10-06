import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshCloudStore } from "./kosh-cloud-store.js";
import { koshDeployDomainStatus, koshDeployHostname, koshDeployPublicUrl } from "./kosh-deploy-domain.js";
import { failKoshDeployRevision } from "./kosh-deploy-failure.js";
import { getKoshDeployStore } from "./kosh-deploy-store.js";
import { getKoshStore } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositories = getKoshStore();
const cloud = getKoshCloudStore();
const deploy = getKoshDeployStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");

type JsonBody = Record<string, unknown>;

type Identity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function json(response: ServerResponse, status: number, body: unknown, origin?: string, allowedOrigins?: ReadonlySet<string>) {
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

async function readJson(request: IncomingMessage, limit = 128 * 1024): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > limit) throw Object.assign(new Error("payload_too_large"), { status: 413 });
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonBody : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanSlug(value: unknown) {
  return clean(value, 100).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function safeRelativePath(value: unknown, fallback: string) {
  const path = clean(value, 240) || fallback;
  if (path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path) || path.split(/[\\/]+/).includes("..")) {
    throw Object.assign(new Error("invalid_deploy_path"), { status: 400 });
  }
  return path.replace(/\\/g, "/");
}

function cleanHealthPath(value: unknown) {
  const path = clean(value, 500) || "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[\r\n]/.test(path)) {
    throw Object.assign(new Error("invalid_health_path"), { status: 400 });
  }
  return path;
}

function validRef(value: string) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._\/-]{0,199}$/.test(value) && !value.includes("..") && !value.includes("@{") && !value.includes("//");
}

function isAdmin(identity: Identity) {
  const configured = new Set((process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  if (configured.size) return configured.has(identity.user.id);
  return identity.memberships.some((item) => !item.membership.disabled && ["owner", "admin"].includes(item.membership.role));
}

async function requireAdmin(request: IncomingMessage, response: ServerResponse, origin: string | undefined, allowedOrigins: ReadonlySet<string>) {
  const identity = await resolveKoshIdentity(request, "repo:write");
  if (!identity) {
    json(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
    return null;
  }
  if (!isAdmin(identity)) {
    json(response, 403, { error: "deploy_admin_required" }, origin, allowedOrigins);
    return null;
  }
  return identity;
}

async function resolveCommit(namespace: string, slug: string, refName: string) {
  if (!validRef(refName)) throw Object.assign(new Error("invalid_deploy_ref"), { status: 400 });
  const gitDir = resolve(repositoryRoot, namespace, slug + ".git");
  const candidates = [`refs/heads/${refName}^{commit}`, `refs/tags/${refName}^{commit}`, `${refName}^{commit}`];
  for (const candidate of candidates) {
    try {
      const result = await execFileAsync("git", ["--git-dir", gitDir, "rev-parse", "--verify", candidate], {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf8"
      });
      const sha = String(result.stdout).trim();
      if (/^[a-f0-9]{40}$/i.test(sha)) return sha.toLowerCase();
    } catch {}
  }
  throw Object.assign(new Error("deploy_ref_not_found"), { status: 404 });
}

function cloudSlug(serviceSlug: string, revision: number) {
  const suffix = `-r${revision}`;
  return serviceSlug.slice(0, Math.max(1, 99 - suffix.length)) + suffix;
}

async function presentService(service: Awaited<ReturnType<typeof deploy.getService>>) {
  if (!service) return null;
  const revisions = await deploy.listRevisions(service.id);
  return {
    ...service,
    hostname: koshDeployHostname(service.slug),
    publicUrl: koshDeployPublicUrl(service.slug),
    activeRevision: revisions.find((item) => item.id === service.activeRevisionId) ?? null,
    pendingRevision: revisions.find((item) => item.id === service.pendingRevisionId) ?? null,
    revisions
  };
}

async function createDeployRevision(identity: Identity, body: JsonBody, rollbackOfRevision: number | null = null) {
  const namespace = clean(body.namespace, 64);
  const repositorySlug = clean(body.repositorySlug ?? body.slug, 100);
  const repository = await repositories.get(namespace, repositorySlug);
  if (!repository) throw Object.assign(new Error("repository_not_found"), { status: 404 });

  const refName = clean(body.refName || repository.defaultBranch, 200);
  const commitSha = clean(body.commitSha, 40) || await resolveCommit(namespace, repositorySlug, refName);
  if (!/^[a-f0-9]{40}$/i.test(commitSha)) throw Object.assign(new Error("invalid_commit_sha"), { status: 400 });

  const name = clean(body.name, 120) || repository.name || repository.slug;
  const serviceSlug = cleanSlug(body.serviceSlug || name || repository.slug);
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(serviceSlug)) throw Object.assign(new Error("invalid_deploy_service_slug"), { status: 400 });

  const containerPort = Math.floor(Number(body.containerPort || 3000));
  if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535) {
    throw Object.assign(new Error("invalid_container_port"), { status: 400 });
  }
  const exposure = clean(body.exposure, 20) === "public" ? "public" as const : "private" as const;
  const dockerfilePath = safeRelativePath(body.dockerfilePath, "Dockerfile");
  const contextPath = safeRelativePath(body.contextPath, ".");
  const healthPath = cleanHealthPath(body.healthPath);

  const created = await deploy.createRevision({
    slug: serviceSlug,
    name,
    repositoryId: repository.id,
    namespace,
    repositorySlug,
    refName,
    commitSha,
    containerPort,
    dockerfilePath,
    contextPath,
    healthPath,
    exposure,
    createdByUserId: identity.user.id,
    rollbackOfRevision
  });

  try {
    const revisionCloudSlug = cloudSlug(serviceSlug, created.revision.revision);
    const image = `kosh-source://${created.service.id}/${created.revision.id}`;
    const cloudDeployment = await cloud.createDeployment({
      slug: revisionCloudSlug,
      name: `${name} r${created.revision.revision}`,
      image,
      containerPort,
      createdByUserId: identity.user.id
    });
    await deploy.attachCloudDeployment(created.revision.id, cloudDeployment.id, revisionCloudSlug);
    const scheduled = await cloud.scheduleDeployment(cloudDeployment.id);
    return {
      service: await presentService(await deploy.getService(serviceSlug)),
      deployment: scheduled ?? cloudDeployment,
      domain: koshDeployDomainStatus()
    };
  } catch (error) {
    await failKoshDeployRevision(created.revision.id).catch(() => undefined);
    throw error;
  }
}

export async function handleKoshDeployRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/kosh/deploy")) return false;
  try {
    await deploy.ready();

    if (request.method === "GET" && url.pathname === "/v1/kosh/deploy/services") {
      const identity = await requireAdmin(request, response, origin, allowedOrigins);
      if (!identity) return true;
      const services = await deploy.listServices();
      const output = [];
      for (const service of services) output.push(await presentService(service));
      json(response, 200, {
        product: "Kosh Deploy",
        domain: koshDeployDomainStatus(),
        services: output
      }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "POST" && url.pathname === "/v1/kosh/deploy/services") {
      const identity = await requireAdmin(request, response, origin, allowedOrigins);
      if (!identity) return true;
      if (origin && !allowedOrigins.has(origin)) throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
      const body = await readJson(request);
      const result = await createDeployRevision(identity, body);
      json(response, 202, result, origin, allowedOrigins);
      return true;
    }

    const revisionsMatch = url.pathname.match(/^\/v1\/kosh\/deploy\/services\/([a-z0-9][a-z0-9._-]{0,99})\/revisions$/);
    if (request.method === "GET" && revisionsMatch) {
      const identity = await requireAdmin(request, response, origin, allowedOrigins);
      if (!identity) return true;
      const service = await deploy.getService(revisionsMatch[1]);
      if (!service) throw Object.assign(new Error("deploy_service_not_found"), { status: 404 });
      json(response, 200, {
        domain: koshDeployDomainStatus(),
        service: await presentService(service)
      }, origin, allowedOrigins);
      return true;
    }

    const rollbackMatch = url.pathname.match(/^\/v1\/kosh\/deploy\/services\/([a-z0-9][a-z0-9._-]{0,99})\/rollback$/);
    if (request.method === "POST" && rollbackMatch) {
      const identity = await requireAdmin(request, response, origin, allowedOrigins);
      if (!identity) return true;
      if (origin && !allowedOrigins.has(origin)) throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
      const service = await deploy.getService(rollbackMatch[1]);
      if (!service) throw Object.assign(new Error("deploy_service_not_found"), { status: 404 });
      const body = await readJson(request);
      const targetNumber = Math.floor(Number(body.revision));
      const revisions = await deploy.listRevisions(service.id);
      const target = revisions.find((item) => item.revision === targetNumber);
      if (!target) throw Object.assign(new Error("deploy_revision_not_found"), { status: 404 });
      const result = await createDeployRevision(identity, {
        namespace: service.namespace,
        repositorySlug: service.repositorySlug,
        refName: target.refName,
        commitSha: target.commitSha,
        name: service.name,
        serviceSlug: service.slug,
        containerPort: service.containerPort,
        dockerfilePath: service.dockerfilePath,
        contextPath: service.contextPath,
        healthPath: service.healthPath,
        exposure: service.exposure
      }, target.revision);
      json(response, 202, result, origin, allowedOrigins);
      return true;
    }

    json(response, 404, { error: "kosh_deploy_route_not_found" }, origin, allowedOrigins);
    return true;
  } catch (error) {
    console.error("Kosh Deploy request failed", error);
    json(response, Number((error as { status?: number })?.status ?? 500), {
      error: error instanceof Error ? error.message : "kosh_deploy_failed"
    }, origin, allowedOrigins);
    return true;
  }
}
