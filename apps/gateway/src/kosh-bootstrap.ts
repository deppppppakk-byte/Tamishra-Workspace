import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import postgres from "postgres";
import { createIdentityStore } from "./identity-store.js";
import { getKoshAccessStore } from "./kosh-access-store.js";
import { getKoshStore } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const store = getKoshStore();
const accessStore = getKoshAccessStore();
const identityStore = createIdentityStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");
let ownerRetryTimer: ReturnType<typeof setInterval> | null = null;

function validSegment(value: string, maxLength: number) {
  return value.length <= maxLength && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

function repositoryPath(namespace: string, slug: string) {
  if (!validSegment(namespace, 64) || !validSegment(slug, 100)) throw new Error("invalid_bootstrap_repository");
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;
  if (!path.startsWith(prefix)) throw new Error("invalid_bootstrap_repository_path");
  return path;
}

async function exists(path: string) {
  try { await stat(path); return true; } catch { return false; }
}

export function configuredBootstrapRepositories() {
  return (process.env.KOSH_BOOTSTRAP_REPOSITORIES ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean)
    .map((value) => {
      const slash = value.indexOf("/");
      const namespace = slash > 0 ? value.slice(0, slash) : "";
      const slug = slash > 0 ? value.slice(slash + 1) : "";
      if (!validSegment(namespace, 64) || !validSegment(slug, 100)) throw new Error("invalid_bootstrap_repository:" + value);
      return { namespace, slug, key: namespace + "/" + slug };
    });
}

async function ensureBareRepository(namespace: string, slug: string) {
  const path = repositoryPath(namespace, slug);
  await mkdir(resolve(repositoryRoot, namespace), { recursive: true });
  if (!(await exists(resolve(path, "HEAD")))) {
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", path], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" });
  }
  await execFileAsync("git", ["--git-dir", path, "config", "http.receivepack", "true"], { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
}

function cloneUrl(namespace: string, slug: string) {
  const origin = (process.env.KOSH_PUBLIC_ORIGIN ?? "https://kosh.tamishra.in").replace(/\/$/, "");
  return `${origin}/git/${namespace}/${slug}.git`;
}

type OwnerCandidate = { organization_id: string; user_id: string; display_name: string; role: "owner" | "admin" };

function singleOwnerFallbackEnabled() {
  const value = (process.env.KOSH_BOOTSTRAP_SINGLE_OWNER_FALLBACK ?? "").trim().toLowerCase();
  return value === "true" || value === "1";
}

async function uniqueNamespaceOwner(namespace: string, organizationId?: string | null) {
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!databaseUrl) return null;
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    const scoped = organizationId
      ? await sql<OwnerCandidate[]>`SELECT o.id AS organization_id, u.id AS user_id, u.display_name, m.role FROM workspace_organizations o JOIN workspace_memberships m ON m.organization_id=o.id JOIN workspace_users u ON u.id=m.user_id WHERE o.id=${organizationId} AND m.disabled=FALSE AND u.disabled=FALSE AND m.role IN ('owner','admin') ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END, m.joined_at ASC`
      : await sql<OwnerCandidate[]>`SELECT o.id AS organization_id, u.id AS user_id, u.display_name, m.role FROM workspace_organizations o JOIN workspace_memberships m ON m.organization_id=o.id JOIN workspace_users u ON u.id=m.user_id WHERE o.slug=${namespace} AND m.disabled=FALSE AND u.disabled=FALSE AND m.role IN ('owner','admin') ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END, m.joined_at ASC`;
    const scopedOwners = scoped.filter((row) => row.role === "owner");
    if (scopedOwners.length === 1) return scopedOwners[0];
    if (scopedOwners.length === 0 && scoped.length === 1) return scoped[0];

    // Initial self-hosted Kosh installs generate a unique personal workspace slug
    // at registration. When explicitly enabled, allow bootstrap only when there is
    // exactly one active owner/admin identity across the entire installation.
    // The moment there is ambiguity, no automatic claim is performed.
    if (!organizationId && scoped.length === 0 && singleOwnerFallbackEnabled()) {
      const all = await sql<OwnerCandidate[]>`SELECT o.id AS organization_id, u.id AS user_id, u.display_name, m.role FROM workspace_organizations o JOIN workspace_memberships m ON m.organization_id=o.id JOIN workspace_users u ON u.id=m.user_id WHERE m.disabled=FALSE AND u.disabled=FALSE AND m.role IN ('owner','admin') ORDER BY CASE WHEN m.role='owner' THEN 0 ELSE 1 END, m.joined_at ASC`;
      const uniqueUsers = new Set(all.map((row) => row.user_id));
      if (uniqueUsers.size === 1 && all.length >= 1) {
        return all.find((row) => row.role === "owner") ?? all[0] ?? null;
      }
    }
    return null;
  } catch (error) {
    console.warn("Kosh bootstrap owner lookup skipped", { namespace, error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function ensureRepositoryOwner(repository: { id: string; namespace: string; slug: string }) {
  const grants = await accessStore.listRepositoryGrants(repository.id);
  if (grants.length > 0) return "existing-owner" as const;
  const existingBinding = await accessStore.getNamespaceBinding(repository.namespace);
  const candidate = await uniqueNamespaceOwner(repository.namespace, existingBinding?.organizationId ?? null);
  if (!candidate) return "owner-pending" as const;
  if (!existingBinding) {
    await accessStore.bindNamespace({ namespace: repository.namespace, organizationId: candidate.organization_id, createdByUserId: candidate.user_id, createdByName: candidate.display_name });
  }
  await accessStore.putRepositoryGrant({ repositoryId: repository.id, subjectType: "user", subjectId: candidate.user_id, role: "owner", createdByUserId: candidate.user_id, createdByName: candidate.display_name });
  console.log("Kosh bootstrap repository owner assigned", { repository: repository.namespace + "/" + repository.slug });
  return "owner-assigned" as const;
}

async function retryPendingOwners() {
  let pending = 0;
  for (const item of configuredBootstrapRepositories()) {
    const repository = await store.get(item.namespace, item.slug);
    if (!repository) continue;
    const state = await ensureRepositoryOwner(repository);
    if (state === "owner-pending") pending += 1;
  }
  if (pending === 0 && ownerRetryTimer) {
    clearInterval(ownerRetryTimer);
    ownerRetryTimer = null;
  }
}

function watchPendingOwners() {
  if (ownerRetryTimer) return;
  ownerRetryTimer = setInterval(() => {
    void retryPendingOwners().catch((error) => {
      console.warn("Kosh bootstrap owner retry failed", error instanceof Error ? error.message : String(error));
    });
  }, 30_000);
  ownerRetryTimer.unref?.();
}

export async function bootstrapConfiguredKoshRepositories() {
  const configured = configuredBootstrapRepositories();
  if (!configured.length) return [];
  await Promise.all([store.ready(), accessStore.ready(), identityStore.ready()]);
  const ready: Array<{ repository: string; ownership: string }> = [];
  let pending = false;
  for (const item of configured) {
    let repository = await store.get(item.namespace, item.slug);
    await ensureBareRepository(item.namespace, item.slug);
    if (!repository) {
      repository = await store.create({ namespace: item.namespace, slug: item.slug, name: item.slug, description: item.key === "tamishra/os" ? "Tamishra OS source repository" : `Kosh native repository ${item.key}`, visibility: "private", defaultBranch: "main", state: "ready", cloneHttpUrl: cloneUrl(item.namespace, item.slug) });
    }
    const ownership = await ensureRepositoryOwner(repository);
    if (ownership === "owner-pending") pending = true;
    ready.push({ repository: repository.namespace + "/" + repository.slug, ownership });
  }
  if (pending) watchPendingOwners();
  return ready;
}
