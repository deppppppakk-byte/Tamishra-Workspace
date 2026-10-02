import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import {
  getKoshSecurityStore,
  type KoshDetectedFinding,
  type KoshSecurityFindingState,
  type KoshSecuritySeverity
} from "./kosh-security-store.js";
import {
  getKoshStore,
  type StoredKoshRepository
} from "./kosh-store.js";

const execFileAsync = promisify(execFile);
const repositoryStore = getKoshStore();
const securityStore = getKoshSecurityStore();
const platformStore = getKoshPlatformStore();
const repositoryRoot = resolve(
  process.env.KOSH_REPO_ROOT?.trim() || ".kosh/repos"
);

type JsonBody = Record<string, unknown>;

type SecurityActor = {
  id: string;
  displayName: string;
};

type SbomComponent = {
  ecosystem: "npm" | "python";
  name: string;
  declaredVersion: string;
  scope: string;
  sourcePath: string;
};

type SecretRule = {
  id: string;
  title: string;
  severity: KoshSecuritySeverity;
  pattern: string;
  message: string;
};

const secretRules: SecretRule[] = [
  {
    id: "private-key-material",
    title: "Private key material committed",
    severity: "critical",
    pattern: "-----BEGIN (OPENSSH|RSA|EC|DSA) PRIVATE KEY-----",
    message: "Private key material is present in repository history."
  },
  {
    id: "kosh-personal-token",
    title: "Kosh personal access token committed",
    severity: "critical",
    pattern: "kosh_pat_[A-Za-z0-9_-]{20,}",
    message: "A Kosh personal access token appears in source."
  },
  {
    id: "credential-assignment",
    title: "Credential-like value committed",
    severity: "high",
    pattern:
      "(password|passwd|api[_-]?key|secret|token)[[:space:]]*[:=][[:space:]]*['\"]?[A-Za-z0-9_./+=:-]{12,}",
    message: "A credential-like assignment appears to contain a real value."
  },
  {
    id: "basic-auth-url",
    title: "Credential embedded in URL",
    severity: "high",
    pattern: "https?://[^/@[:space:]:]+:[^/@[:space:]]+@",
    message: "A URL appears to contain inline username/password credentials."
  }
];

const findingStates = new Set<KoshSecurityFindingState>([
  "open",
  "acknowledged",
  "resolved",
  "ignored"
]);

function repositoryPath(repository: StoredKoshRepository) {
  const path = resolve(
    repositoryRoot,
    repository.namespace,
    repository.slug + ".git"
  );
  const prefix = repositoryRoot.endsWith(sep)
    ? repositoryRoot
    : repositoryRoot + sep;
  if (!path.startsWith(prefix)) {
    throw Object.assign(new Error("invalid_repository_path"), {
      status: 400
    });
  }
  return path;
}

async function git(
  gitDir: string,
  args: string[],
  maxBuffer = 16 * 1024 * 1024
) {
  try {
    const result = await execFileAsync(
      "git",
      ["--git-dir", gitDir, ...args],
      {
        timeout: 60_000,
        maxBuffer,
        encoding: "utf8"
      }
    );
    return String(result.stdout);
  } catch (error) {
    const value = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (value.code === 1) {
      return String(value.stdout ?? "");
    }
    throw Object.assign(
      new Error(String(value.stderr || "security_git_command_failed").trim()),
      { status: 409 }
    );
  }
}

async function readGitText(
  gitDir: string,
  commitSha: string,
  path: string,
  maxBytes = 8 * 1024 * 1024
) {
  const result = await execFileAsync(
    "git",
    ["--git-dir", gitDir, "show", commitSha + ":" + path],
    {
      timeout: 30_000,
      maxBuffer: maxBytes,
      encoding: "utf8"
    }
  );
  return String(result.stdout);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function findingFingerprint(input: {
  scanner: string;
  ruleId: string;
  path: string;
  line: number | null;
  evidenceHash: string;
}) {
  return hash(
    [
      input.scanner,
      input.ruleId,
      input.path,
      String(input.line ?? 0),
      input.evidenceHash
    ].join("\0")
  );
}

function parseGrepLine(line: string, commitSha: string) {
  const withoutCommit = line.startsWith(commitSha + ":")
    ? line.slice(commitSha.length + 1)
    : line;
  const match = withoutCommit.match(/^(.+?):(\d+):(.*)$/);
  if (!match) return null;
  return {
    path: match[1],
    line: Number(match[2]),
    text: match[3]
  };
}

function ignoredSecretEvidence(path: string, text: string) {
  const lowerPath = path.toLowerCase();
  const lower = text.toLowerCase();

  if (
    lowerPath.endsWith(".env.example") ||
    lowerPath.endsWith(".env.sample") ||
    lowerPath.includes("/fixtures/") ||
    lowerPath.includes("/snapshots/")
  ) {
    return true;
  }

  return [
    "change-me",
    "changeme",
    "placeholder",
    "example-token",
    "example_secret",
    "example-secret",
    "dummy",
    "your_api_key",
    "your-api-key",
    "your_token",
    "your-token",
    "<secret>",
    "<token>",
    "xxxxxxxx"
  ].some((marker) => lower.includes(marker));
}

async function scanSecrets(
  gitDir: string,
  commitSha: string
): Promise<KoshDetectedFinding[]> {
  const findings: KoshDetectedFinding[] = [];

  for (const rule of secretRules) {
    const output = await git(
      gitDir,
      [
        "grep",
        "-n",
        "-I",
        "-i",
        "-E",
        rule.pattern,
        commitSha,
        "--"
      ],
      12 * 1024 * 1024
    );

    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const match = parseGrepLine(line, commitSha);
      if (!match || ignoredSecretEvidence(match.path, match.text)) continue;

      const evidenceHash = hash(match.text);
      findings.push({
        fingerprint: findingFingerprint({
          scanner: "secret",
          ruleId: rule.id,
          path: match.path,
          line: match.line,
          evidenceHash
        }),
        scanner: "secret",
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        path: match.path,
        line: match.line,
        message: rule.message,
        evidenceHash,
        metadata: {
          redacted: true
        }
      });
    }
  }

  const unique = new Map(
    findings.map((finding) => [finding.fingerprint, finding])
  );
  return [...unique.values()];
}

function dependencyFinding(input: {
  ruleId: string;
  title: string;
  severity: KoshSecuritySeverity;
  path: string;
  name: string;
  spec: string;
  ecosystem: string;
}): KoshDetectedFinding {
  const evidenceHash = hash(input.name + "\0" + input.spec);
  return {
    fingerprint: findingFingerprint({
      scanner: "dependency-policy",
      ruleId: input.ruleId,
      path: input.path,
      line: null,
      evidenceHash
    }),
    scanner: "dependency-policy",
    ruleId: input.ruleId,
    title: input.title,
    severity: input.severity,
    path: input.path,
    line: null,
    message:
      input.name +
      " uses dependency declaration " +
      JSON.stringify(input.spec) +
      ".",
    evidenceHash,
    metadata: {
      ecosystem: input.ecosystem,
      dependency: input.name,
      declaredVersion: input.spec
    }
  };
}

function inspectDependencySpec(input: {
  path: string;
  name: string;
  spec: string;
  ecosystem: string;
}) {
  const spec = input.spec.trim();
  const findings: KoshDetectedFinding[] = [];

  if (!spec || spec === "*" || spec.toLowerCase() === "latest") {
    findings.push(
      dependencyFinding({
        ...input,
        ruleId: "dependency-unbounded",
        title: "Unbounded dependency version",
        severity: "medium"
      })
    );
  }

  if (
    spec.startsWith("http://") ||
    spec.startsWith("git+http://") ||
    spec.startsWith("git://")
  ) {
    findings.push(
      dependencyFinding({
        ...input,
        ruleId: "dependency-insecure-transport",
        title: "Dependency uses insecure transport",
        severity: "high"
      })
    );
  }

  if (
    (spec.startsWith("git+https://") ||
      spec.startsWith("git+ssh://") ||
      spec.startsWith("ssh://")) &&
    !/#(?:[0-9a-f]{7,40})$/i.test(spec)
  ) {
    findings.push(
      dependencyFinding({
        ...input,
        ruleId: "dependency-vcs-unpinned",
        title: "VCS dependency is not pinned to a commit",
        severity: "medium"
      })
    );
  }

  return findings;
}

async function dependencyInventory(
  gitDir: string,
  commitSha: string
): Promise<{
  findings: KoshDetectedFinding[];
  components: SbomComponent[];
}> {
  const names = await git(
    gitDir,
    ["ls-tree", "-r", "--name-only", "-z", commitSha],
    16 * 1024 * 1024
  );
  const paths = names.split("\0").filter(Boolean);
  const manifests = paths
    .filter((path) => {
      const name = basename(path).toLowerCase();
      return name === "package.json" || name === "requirements.txt";
    })
    .slice(0, 250);

  const findings: KoshDetectedFinding[] = [];
  const components: SbomComponent[] = [];

  for (const path of manifests) {
    const name = basename(path).toLowerCase();

    if (name === "package.json") {
      try {
        const text = await readGitText(gitDir, commitSha, path);
        const document = JSON.parse(text) as Record<string, unknown>;
        for (const [scope, raw] of [
          ["runtime", document.dependencies],
          ["development", document.devDependencies],
          ["optional", document.optionalDependencies],
          ["peer", document.peerDependencies]
        ] as const) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          for (const [dependency, version] of Object.entries(
            raw as Record<string, unknown>
          )) {
            const spec = String(version ?? "").trim();
            components.push({
              ecosystem: "npm",
              name: dependency,
              declaredVersion: spec,
              scope,
              sourcePath: path
            });
            findings.push(
              ...inspectDependencySpec({
                path,
                name: dependency,
                spec,
                ecosystem: "npm"
              })
            );
          }
        }
      } catch {
        findings.push(
          dependencyFinding({
            ruleId: "manifest-invalid",
            title: "Dependency manifest could not be parsed",
            severity: "low",
            path,
            name: path,
            spec: "invalid-json",
            ecosystem: "npm"
          })
        );
      }
      continue;
    }

    if (name === "requirements.txt") {
      try {
        const text = await readGitText(gitDir, commitSha, path);
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith("#") || line.startsWith("-")) continue;

          const direct = line.match(
            /^([A-Za-z0-9_.-]+)\s*@\s*(\S+)$/
          );
          if (direct) {
            const dependency = direct[1];
            const spec = direct[2];
            components.push({
              ecosystem: "python",
              name: dependency,
              declaredVersion: spec,
              scope: "runtime",
              sourcePath: path
            });
            findings.push(
              ...inspectDependencySpec({
                path,
                name: dependency,
                spec,
                ecosystem: "python"
              })
            );
            continue;
          }

          const parsed = line.match(
            /^([A-Za-z0-9_.-]+)(?:\[[^\]]+\])?\s*(.*)$/
          );
          if (!parsed) continue;
          const dependency = parsed[1];
          const spec = parsed[2].trim();
          components.push({
            ecosystem: "python",
            name: dependency,
            declaredVersion: spec || "*",
            scope: "runtime",
            sourcePath: path
          });

          if (!/(===|==|~=|>=|<=|>|<)/.test(spec)) {
            findings.push(
              dependencyFinding({
                ruleId: "dependency-unbounded",
                title: "Python dependency is not version constrained",
                severity: "medium",
                path,
                name: dependency,
                spec: spec || "*",
                ecosystem: "python"
              })
            );
          }
          findings.push(
            ...inspectDependencySpec({
              path,
              name: dependency,
              spec,
              ecosystem: "python"
            })
          );
        }
      } catch {
        findings.push(
          dependencyFinding({
            ruleId: "manifest-unreadable",
            title: "Dependency manifest could not be read",
            severity: "low",
            path,
            name: path,
            spec: "unreadable",
            ecosystem: "python"
          })
        );
      }
    }
  }

  return { findings, components };
}

function activeFinding(finding: {
  state: KoshSecurityFindingState;
}) {
  return finding.state === "open" || finding.state === "acknowledged";
}

export async function getKoshSecuritySummary(repositoryId: string) {
  await securityStore.ready();
  const [findings, scans, sbom] = await Promise.all([
    securityStore.listFindings(repositoryId),
    securityStore.listScans(repositoryId),
    securityStore.getSbom(repositoryId)
  ]);

  const active = findings.filter(activeFinding);
  const counts: Record<string, number> = {
    total: findings.length,
    active: active.length,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    open: 0,
    acknowledged: 0,
    resolved: 0,
    ignored: 0
  };

  for (const finding of findings) {
    counts[finding.state] = (counts[finding.state] ?? 0) + 1;
    if (activeFinding(finding)) {
      counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    }
  }

  const state =
    counts.critical > 0
      ? "critical"
      : counts.high > 0
        ? "degraded"
        : counts.medium > 0
          ? "watch"
          : "clear";

  return {
    state,
    counts,
    latestScan: scans[0] ?? null,
    sbom: sbom
      ? {
          commitSha: sbom.commitSha,
          format: sbom.format,
          generatedAt: sbom.generatedAt,
          componentCount: Array.isArray(sbom.document.components)
            ? sbom.document.components.length
            : 0
        }
      : null
  };
}

export async function runKoshSecurityScan(
  repository: StoredKoshRepository,
  actor: SecurityActor
) {
  await Promise.all([
    securityStore.ready(),
    platformStore.ready()
  ]);

  const startedAt = new Date().toISOString();
  const gitDir = repositoryPath(repository);
  const commitSha = (
    await git(gitDir, [
      "rev-parse",
      "--verify",
      "refs/heads/" + repository.defaultBranch + "^{commit}"
    ])
  ).trim();

  if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
    throw Object.assign(new Error("repository_has_no_scannable_commit"), {
      status: 409
    });
  }

  const [secrets, dependencies] = await Promise.all([
    scanSecrets(gitDir, commitSha),
    dependencyInventory(gitDir, commitSha)
  ]);

  const components = dependencies.components
    .sort((a, b) =>
      (a.ecosystem + ":" + a.name + ":" + a.sourcePath).localeCompare(
        b.ecosystem + ":" + b.name + ":" + b.sourcePath
      )
    )
    .slice(0, 50_000);

  await securityStore.putSbom({
    repositoryId: repository.id,
    commitSha,
    format: "kosh-sbom-v1",
    document: {
      schema: "kosh-sbom-v1",
      repository: {
        id: repository.id,
        namespace: repository.namespace,
        slug: repository.slug
      },
      commitSha,
      generatedAt: new Date().toISOString(),
      componentCount: components.length,
      components
    },
    generatedAt: new Date().toISOString()
  });

  const scan = await securityStore.reconcileScan({
    repositoryId: repository.id,
    commitSha,
    scanners: ["secret", "dependency-policy"],
    findings: [...secrets, ...dependencies.findings],
    createdByUserId: actor.id,
    createdByName: actor.displayName,
    startedAt
  });

  const summary = await getKoshSecuritySummary(repository.id);

  await platformStore.appendAudit({
    repositoryId: repository.id,
    actorUserId: actor.id,
    actorName: actor.displayName,
    eventType: "security_scan_completed",
    resourceType: "security_scan",
    resourceId: scan.id,
    metadata: {
      commitSha,
      scanners: scan.scanners,
      counts: scan.counts,
      state: summary.state
    }
  });

  return { scan, summary };
}

export function triggerKoshSecurityScanAfterPush(
  repository: StoredKoshRepository,
  actor: { id: string | null; name: string },
  changedBranches: string[]
) {
  if (process.env.KOSH_SECURITY_SCAN_ON_PUSH?.trim().toLowerCase() === "false") {
    return;
  }

  if (!changedBranches.includes(repository.defaultBranch)) {
    return;
  }

  void runKoshSecurityScan(repository, {
    id: actor.id ?? "kosh-system",
    displayName: actor.name
  }).catch(async (error) => {
    await platformStore.appendAudit({
      repositoryId: repository.id,
      actorUserId: actor.id,
      actorName: actor.name,
      eventType: "security_scan_failed",
      resourceType: "security_scan",
      resourceId: null,
      metadata: {
        reason: error instanceof Error ? error.message : "unknown error"
      }
    }).catch(() => undefined);
  });
}

function sendJson(
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

async function readJson(
  request: IncomingMessage,
  limit = 128 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
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
  sendJson(
    response,
    status,
    {
      error:
        error instanceof Error ? error.message : "kosh_security_error"
    },
    origin,
    allowedOrigins
  );
}

export async function handleKoshSecurityRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/security(?:\/(.*))?$/
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
    sendJson(
      response,
      401,
      { error: "authentication_required" },
      origin,
      allowedOrigins
    );
    return true;
  }

  try {
    const repository = await repositoryStore.get(namespace, slug);
    if (!repository) {
      throw Object.assign(new Error("repository_not_found"), { status: 404 });
    }

    if (
      request.method === "GET" &&
      (tail === "" || tail === "summary")
    ) {
      const [summary, findings, scans] = await Promise.all([
        getKoshSecuritySummary(repository.id),
        securityStore.listFindings(repository.id),
        securityStore.listScans(repository.id)
      ]);
      sendJson(
        response,
        200,
        {
          summary,
          findings: findings.slice(0, 500),
          scans: scans.slice(0, 20)
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "GET" && tail === "findings") {
      const stateValue = clean(url.searchParams.get("state"), 30);
      const state = findingStates.has(stateValue as KoshSecurityFindingState)
        ? stateValue as KoshSecurityFindingState
        : undefined;
      sendJson(
        response,
        200,
        { findings: await securityStore.listFindings(repository.id, state) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "POST" && tail === "scan") {
      const result = await runKoshSecurityScan(repository, {
        id: identity.user.id,
        displayName: identity.user.displayName
      });
      sendJson(response, 201, result, origin, allowedOrigins);
      return true;
    }

    if (request.method === "GET" && tail === "sbom") {
      const sbom = await securityStore.getSbom(repository.id);
      if (!sbom) {
        throw Object.assign(new Error("security_sbom_not_generated"), {
          status: 404
        });
      }
      sendJson(response, 200, sbom, origin, allowedOrigins);
      return true;
    }

    const findingMatch = tail.match(/^findings\/([^/]+)$/);
    if (findingMatch && request.method === "PATCH") {
      const id = decodeURIComponent(findingMatch[1]);
      const body = await readJson(request);
      const state = clean(body.state, 30) as KoshSecurityFindingState;
      const note = clean(body.note, 2000);

      if (!findingStates.has(state)) {
        throw Object.assign(new Error("invalid_security_finding_state"), {
          status: 400
        });
      }

      const updated = await securityStore.updateFindingState(
        repository.id,
        id,
        state,
        note
      );
      if (!updated) {
        throw Object.assign(new Error("security_finding_not_found"), {
          status: 404
        });
      }

      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "security_finding_updated",
        resourceType: "security_finding",
        resourceId: updated.id,
        metadata: {
          state: updated.state,
          severity: updated.severity,
          ruleId: updated.ruleId
        }
      });

      sendJson(response, 200, updated, origin, allowedOrigins);
      return true;
    }

    sendJson(
      response,
      404,
      { error: "kosh_security_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
