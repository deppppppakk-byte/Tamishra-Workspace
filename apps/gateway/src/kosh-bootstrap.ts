import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { getKoshStore } from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const store = getKoshStore();
const repositoryRoot = resolve(process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos");

function validSegment(value: string, maxLength: number) {
  return value.length <= maxLength && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
}

function repositoryPath(namespace: string, slug: string) {
  if (!validSegment(namespace, 64) || !validSegment(slug, 100)) {
    throw new Error("invalid_bootstrap_repository");
  }
  const path = resolve(repositoryRoot, namespace, slug + ".git");
  const prefix = repositoryRoot.endsWith(sep) ? repositoryRoot : repositoryRoot + sep;
  if (!path.startsWith(prefix)) throw new Error("invalid_bootstrap_repository_path");
  return path;
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function configuredBootstrapRepositories() {
  return (process.env.KOSH_BOOTSTRAP_REPOSITORIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      const slash = value.indexOf("/");
      const namespace = slash > 0 ? value.slice(0, slash) : "";
      const slug = slash > 0 ? value.slice(slash + 1) : "";
      if (!validSegment(namespace, 64) || !validSegment(slug, 100)) {
        throw new Error("invalid_bootstrap_repository:" + value);
      }
      return { namespace, slug, key: namespace + "/" + slug };
    });
}

export function isConfiguredBootstrapRepository(namespace: string, slug: string) {
  return configuredBootstrapRepositories().some(
    (item) => item.namespace === namespace && item.slug === slug
  );
}

async function ensureBareRepository(namespace: string, slug: string) {
  const path = repositoryPath(namespace, slug);
  await mkdir(resolve(repositoryRoot, namespace), { recursive: true });
  if (!(await exists(resolve(path, "HEAD")))) {
    await execFileAsync("git", ["init", "--bare", "--initial-branch=main", path], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8"
    });
  }
  await execFileAsync("git", ["--git-dir", path, "config", "http.receivepack", "true"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  return path;
}

function cloneUrl(namespace: string, slug: string) {
  const origin = (process.env.KOSH_PUBLIC_ORIGIN ?? "https://kosh.tamishra.in").replace(/\/$/, "");
  return `${origin}/git/${namespace}/${slug}.git`;
}

export async function bootstrapConfiguredKoshRepositories() {
  const configured = configuredBootstrapRepositories();
  if (!configured.length) return [];

  await store.ready();
  const ready: string[] = [];
  for (const item of configured) {
    let repository = await store.get(item.namespace, item.slug);
    await ensureBareRepository(item.namespace, item.slug);
    if (!repository) {
      repository = await store.create({
        namespace: item.namespace,
        slug: item.slug,
        name: item.slug,
        description:
          item.key === "tamishra/os"
            ? "Tamishra OS source repository"
            : `Kosh native repository ${item.key}`,
        visibility: "private",
        defaultBranch: "main",
        state: "ready",
        cloneHttpUrl: cloneUrl(item.namespace, item.slug)
      });
    }
    ready.push(repository.namespace + "/" + repository.slug);
  }
  return ready;
}
