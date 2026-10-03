#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const CLI_VERSION = "0.2.0";

type Config = {
  origin?: string;
  token?: string;
};

type RequestOptions = {
  token?: string;
  origin?: string;
  body?: unknown;
  authenticated?: boolean;
};

function configPath() {
  return resolve(
    process.env.KOSH_CONFIG?.trim() ||
      resolve(homedir(), ".kosh", "config.json")
  );
}

async function loadConfig(): Promise<Config> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Config)
      : {};
  } catch {
    return {};
  }
}

async function saveConfig(config: Config) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(path, 0o600).catch(() => undefined);
}

function normalizedOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Kosh origin must be a valid http(s) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Kosh origin must be an http(s) URL without embedded credentials.");
  }
  return url.toString().replace(/\/$/, "");
}

async function runtimeConfig() {
  const stored = await loadConfig();
  const origin = normalizedOrigin(
    process.env.KOSH_ORIGIN?.trim() || stored.origin || "http://localhost:4100"
  );
  const token = process.env.KOSH_TOKEN?.trim() || stored.token?.trim() || "";
  return { stored, origin, token };
}

function usage() {
  process.stdout.write(
    [
      `Kosh CLI ${CLI_VERSION}`,
      "",
      "Authentication:",
      "  kosh auth login --token kosh_pat_... [--origin https://kosh.example]",
      "  kosh auth status",
      "  kosh auth logout",
      "",
      "Configuration:",
      "  kosh config origin <https://gateway.example>",
      "",
      "Repositories:",
      "  kosh repo list",
      "  kosh repo view <namespace/repo>",
      "  kosh search <namespace/repo> <query> [code|paths|commits]",
      "  kosh issue list <namespace/repo>",
      "  kosh workflow runs <namespace/repo>",
      "  kosh release list <namespace/repo>",
      "  kosh resource list <namespace/repo> [type]",
      "",
      "Public API:",
      "  kosh api discover",
      "  kosh api get </v1/...>",
      "  kosh api request <GET|POST|PUT|PATCH|DELETE> </v1/...> [json]",
      "",
      "Environment overrides:",
      "  KOSH_ORIGIN   Gateway origin",
      "  KOSH_TOKEN    kosh_pat_... API token",
      "  KOSH_CONFIG   Alternate config file path",
      "",
      "Security: generic API paths must be relative to the configured Kosh origin.",
      ""
    ].join("\n")
  );
}

function flag(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? "" : "";
}

function repoParts(value: string) {
  const [namespace, slug, ...rest] = value.split("/");
  if (!namespace || !slug || rest.length) {
    throw new Error("Repository must be written as namespace/repo.");
  }
  return { namespace, slug };
}

function apiPath(value: string) {
  const path = value.trim();
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("API path must start with one / and be relative to the Kosh origin.");
  }
  if (/^[a-z]+:\/\//i.test(path)) {
    throw new Error("Absolute API URLs are not accepted.");
  }
  return path;
}

async function request(
  method: string,
  path: string,
  options: RequestOptions = {}
) {
  const runtime = await runtimeConfig();
  const origin = options.origin ? normalizedOrigin(options.origin) : runtime.origin;
  const token = options.token ?? runtime.token;
  const authenticated = options.authenticated !== false;
  if (authenticated && !token) {
    throw new Error(
      "No Kosh API token is configured. Use `kosh auth login --token ...` or KOSH_TOKEN."
    );
  }

  const headers: Record<string, string> = {
    accept: "application/json"
  };
  if (authenticated && token) headers.authorization = "Bearer " + token;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(origin + apiPath(path), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "error"
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : "HTTP " + response.status;
    throw new Error(message);
  }
  return payload;
}

function print(value: unknown) {
  if (typeof value === "string") {
    process.stdout.write(value + (value.endsWith("\n") ? "" : "\n"));
    return;
  }
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function login(args: string[]) {
  const runtime = await runtimeConfig();
  const suppliedToken = flag(args, "--token") || process.env.KOSH_TOKEN?.trim() || "";
  const suppliedOrigin = flag(args, "--origin") || runtime.origin;
  if (!suppliedToken.startsWith("kosh_pat_")) {
    throw new Error("A valid kosh_pat_... token is required.");
  }
  const origin = normalizedOrigin(suppliedOrigin);
  const identity = await request("GET", "/v1/kosh/api/me", {
    token: suppliedToken,
    origin
  });
  await saveConfig({ origin, token: suppliedToken });
  print({ saved: true, config: configPath(), origin, identity });
}

async function logout() {
  const runtime = await runtimeConfig();
  await saveConfig({ origin: runtime.stored.origin || runtime.origin });
  print({ loggedOut: true, config: configPath() });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(CLI_VERSION + "\n");
    return;
  }

  if (args[0] === "auth" && args[1] === "login") {
    await login(args.slice(2));
    return;
  }
  if (args[0] === "auth" && args[1] === "status") {
    const runtime = await runtimeConfig();
    const identity = await request("GET", "/v1/kosh/api/me");
    print({ origin: runtime.origin, config: configPath(), identity });
    return;
  }
  if (args[0] === "auth" && args[1] === "logout") {
    await logout();
    return;
  }

  if (args[0] === "config" && args[1] === "origin") {
    const value = normalizedOrigin(args[2] || "");
    const runtime = await runtimeConfig();
    await saveConfig({ ...runtime.stored, origin: value });
    print({ origin: value, config: configPath() });
    return;
  }

  if (args[0] === "api" && args[1] === "discover") {
    print(
      await request("GET", "/v1/kosh/api", {
        authenticated: false
      })
    );
    return;
  }
  if (args[0] === "api" && args[1] === "get") {
    print(await request("GET", apiPath(args[2] || "")));
    return;
  }
  if (args[0] === "api" && args[1] === "request") {
    const method = String(args[2] || "").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new Error("API method must be GET, POST, PUT, PATCH, or DELETE.");
    }
    const path = apiPath(args[3] || "");
    const body = args[4] === undefined ? undefined : parseJson(args[4]);
    print(await request(method, path, { body }));
    return;
  }

  if (args[0] === "repo" && args[1] === "list") {
    print(await request("GET", "/v1/kosh/api/repositories"));
    return;
  }
  if (args[0] === "repo" && args[1] === "view") {
    const repository = repoParts(args[2] || "");
    print(
      await request(
        "GET",
        "/v1/kosh/repos/" +
          encodeURIComponent(repository.namespace) +
          "/" +
          encodeURIComponent(repository.slug)
      )
    );
    return;
  }

  if (args[0] === "search") {
    const repository = repoParts(args[1] || "");
    const query = args[2] || "";
    const mode = args[3] || "code";
    if (!query) throw new Error("Search query is required.");
    if (!["code", "paths", "commits"].includes(mode)) {
      throw new Error("Search mode must be code, paths, or commits.");
    }
    print(
      await request(
        "GET",
        "/v1/kosh/repos/" +
          encodeURIComponent(repository.namespace) +
          "/" +
          encodeURIComponent(repository.slug) +
          "/platform/search?q=" +
          encodeURIComponent(query) +
          "&mode=" +
          encodeURIComponent(mode)
      )
    );
    return;
  }

  if (args[0] === "issue" && args[1] === "list") {
    const repository = repoParts(args[2] || "");
    print(
      await request(
        "GET",
        "/v1/kosh/repos/" +
          encodeURIComponent(repository.namespace) +
          "/" +
          encodeURIComponent(repository.slug) +
          "/work/issues"
      )
    );
    return;
  }

  if (args[0] === "workflow" && args[1] === "runs") {
    const repository = repoParts(args[2] || "");
    print(
      await request(
        "GET",
        "/v1/kosh/repos/" +
          encodeURIComponent(repository.namespace) +
          "/" +
          encodeURIComponent(repository.slug) +
          "/automation/runs"
      )
    );
    return;
  }

  if (args[0] === "release" && args[1] === "list") {
    const repository = repoParts(args[2] || "");
    print(
      await request(
        "GET",
        "/v1/kosh/repos/" +
          encodeURIComponent(repository.namespace) +
          "/" +
          encodeURIComponent(repository.slug) +
          "/platform/resources?type=release"
      )
    );
    return;
  }

  if (args[0] === "resource" && args[1] === "list") {
    const repository = repoParts(args[2] || "");
    const type = args[3] ? "?type=" + encodeURIComponent(args[3]) : "";
    print(
      await request(
        "GET",
        "/v1/kosh/repos/" +
          encodeURIComponent(repository.namespace) +
          "/" +
          encodeURIComponent(repository.slug) +
          "/platform/resources" +
          type
      )
    );
    return;
  }

  usage();
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(
    "Kosh CLI: " +
      (error instanceof Error ? error.message : "Unknown error") +
      "\n"
  );
  process.exitCode = 1;
});