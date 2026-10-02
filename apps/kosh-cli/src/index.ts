#!/usr/bin/env node

const origin = (
  process.env.KOSH_ORIGIN?.trim() ||
  "http://localhost:4100"
).replace(/\/$/, "");
const token = process.env.KOSH_TOKEN?.trim() || "";

function usage() {
  process.stdout.write(
    [
      "Kosh CLI",
      "",
      "Environment:",
      "  KOSH_ORIGIN   Kosh Gateway origin",
      "  KOSH_TOKEN    kosh_pat_... API token",
      "",
      "Commands:",
      "  kosh repo list",
      "  kosh search <namespace/repo> <query> [code|paths|commits]",
      "  kosh issue list <namespace/repo>",
      "  kosh workflow runs <namespace/repo>",
      "  kosh release list <namespace/repo>",
      "  kosh resource list <namespace/repo> [type]",
      ""
    ].join("\n")
  );
}

function repoParts(value: string) {
  const [namespace, slug, ...rest] = value.split("/");
  if (!namespace || !slug || rest.length) {
    throw new Error("Repository must be written as namespace/repo.");
  }
  return { namespace, slug };
}

async function request(path: string) {
  if (!token) {
    throw new Error("KOSH_TOKEN is required.");
  }
  const response = await fetch(origin + path, {
    headers: {
      authorization: "Bearer " + token,
      accept: "application/json"
    }
  });
  const body = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = body;
  }
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload
        ? String((payload as { error?: unknown }).error)
        : "HTTP " + response.status;
    throw new Error(message);
  }
  return payload;
}

function print(value: unknown) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  if (args[0] === "repo" && args[1] === "list") {
    print(await request("/v1/kosh/repos"));
    return;
  }

  if (args[0] === "search") {
    const repository = repoParts(args[1] || "");
    const query = args[2] || "";
    const mode = args[3] || "code";
    if (!query) throw new Error("Search query is required.");
    print(
      await request(
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
    const type = args[3]
      ? "?type=" + encodeURIComponent(args[3])
      : "";
    print(
      await request(
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
