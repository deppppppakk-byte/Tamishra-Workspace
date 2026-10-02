import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve, sep } from "node:path";
import { resolveWorkspaceIdentity } from "./identity.js";
import { getKoshStore } from "./kosh-store.js";
import {
  automationStore,
  scheduleWorkflow,
  syncRunCheck,
  validateWorkflowDefinition
} from "./kosh-automation-service.js";
import type {
  KoshDeploymentStatus,
  KoshJobStatus
} from "./kosh-automation-store.js";

const repositoryStore = getKoshStore();
const store = automationStore();
const artifactRoot = resolve(
  process.env.KOSH_ARTIFACT_ROOT?.trim() || ".kosh/artifacts"
);

type JsonBody = Record<string, unknown>;

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
  maxBytes = 12 * 1024 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
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

function tokenMatches(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function runnerAuthorized(request: IncomingMessage) {
  const expected = process.env.KOSH_RUNNER_TOKEN?.trim();
  if (!expected) return process.env.NODE_ENV !== "production";
  const authorization = request.headers.authorization?.trim() ?? "";
  const token = authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
  return tokenMatches(token, expected);
}

async function requireIdentity(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const identity = await resolveWorkspaceIdentity(request);
  if (!identity) {
    sendJson(
      response,
      401,
      { error: "authentication_required" },
      origin,
      allowedOrigins
    );
    return null;
  }
  return identity;
}

async function repositoryById(repositoryId: string) {
  const repositories = await repositoryStore.list();
  return repositories.find((item) => item.id === repositoryId) ?? null;
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
    { error: error instanceof Error ? error.message : "kosh_automation_error" },
    origin,
    allowedOrigins
  );
}

async function handleRunner(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  if (!url.pathname.startsWith("/v1/kosh/automation/runner")) return false;

  if (!runnerAuthorized(request)) {
    sendJson(response, 401, { error: "runner_authentication_required" });
    return true;
  }

  try {
    await store.ready();

    if (
      request.method === "POST" &&
      url.pathname === "/v1/kosh/automation/runner/claim"
    ) {
      const body = await readJson(request, 64 * 1024);
      const runnerId = clean(body.runnerId, 160);
      if (!runnerId) {
        throw Object.assign(new Error("runner_id_required"), { status: 400 });
      }

      const job = await store.claimNextJob(runnerId);
      if (!job) {
        sendJson(response, 200, { job: null });
        return true;
      }

      const run = await store.getRun(job.repositoryId, job.runId);
      const repository = await repositoryById(job.repositoryId);
      if (!run || !repository) {
        await store.updateJobStatus(job.id, "failure");
        throw Object.assign(new Error("runner_job_context_missing"), {
          status: 500
        });
      }

      await syncRunCheck(run.id);

      const workflow = await store.getWorkflow(
        job.repositoryId,
        job.workflowId
      );

      sendJson(response, 200, {
        job,
        run,
        repository: {
          namespace: repository.namespace,
          slug: repository.slug,
          name: repository.name,
          cloneHttpUrl: repository.cloneHttpUrl
        },
        workflowEnv: workflow?.definition.env ?? {}
      });
      return true;
    }

    const logsMatch = url.pathname.match(
      /^\/v1\/kosh\/automation\/runner\/jobs\/([^/]+)\/logs$/
    );
    if (logsMatch && request.method === "POST") {
      const body = await readJson(request, 256 * 1024);
      const stream =
        body.stream === "stderr" || body.stream === "system"
          ? body.stream
          : "stdout";
      const text = String(body.text ?? "").slice(0, 64 * 1024);
      const log = await store.appendLog(
        decodeURIComponent(logsMatch[1]),
        stream,
        text
      );
      sendJson(response, 201, log);
      return true;
    }

    const completeMatch = url.pathname.match(
      /^\/v1\/kosh\/automation\/runner\/jobs\/([^/]+)\/complete$/
    );
    if (completeMatch && request.method === "POST") {
      const body = await readJson(request, 64 * 1024);
      const status =
        body.status === "success" ||
        body.status === "failure" ||
        body.status === "cancelled"
          ? body.status as KoshJobStatus
          : null;

      if (!status) {
        throw Object.assign(new Error("valid_job_status_required"), {
          status: 400
        });
      }

      const job = await store.updateJobStatus(
        decodeURIComponent(completeMatch[1]),
        status
      );
      if (!job) {
        throw Object.assign(new Error("job_not_found"), { status: 404 });
      }

      const run = await syncRunCheck(job.runId);
      sendJson(response, 200, { job, run });
      return true;
    }

    const artifactMatch = url.pathname.match(
      /^\/v1\/kosh\/automation\/runner\/jobs\/([^/]+)\/artifacts$/
    );
    if (artifactMatch && request.method === "POST") {
      const body = await readJson(request);
      const jobId = decodeURIComponent(artifactMatch[1]);
      const name = clean(body.name, 180);
      const encoded = String(body.base64 ?? "");

      if (!name || !encoded) {
        throw Object.assign(new Error("artifact_name_and_data_required"), {
          status: 400
        });
      }

      const jobs = await Promise.all(
        (await repositoryStore.list()).map(async (repository) => {
          const runs = await store.listRuns(repository.id, 500);
          for (const run of runs) {
            const runJobs = await store.listJobs(run.id);
            const found = runJobs.find((item) => item.id === jobId);
            if (found) return { job: found, run };
          }
          return null;
        })
      );
      const context = jobs.find(Boolean);
      if (!context) {
        throw Object.assign(new Error("job_not_found"), { status: 404 });
      }

      const buffer = Buffer.from(encoded, "base64");
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) {
        throw Object.assign(new Error("artifact_size_invalid"), { status: 413 });
      }

      const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180);
      const directory = resolve(artifactRoot, context.run.id, jobId);
      const rootPrefix = artifactRoot.endsWith(sep)
        ? artifactRoot
        : artifactRoot + sep;
      if (!directory.startsWith(rootPrefix)) {
        throw Object.assign(new Error("invalid_artifact_path"), { status: 400 });
      }

      await mkdir(directory, { recursive: true });
      const path = resolve(directory, safeName);
      await writeFile(path, buffer);

      const artifact = await store.createArtifact({
        runId: context.run.id,
        jobId,
        name: safeName,
        storagePath: path,
        sizeBytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex")
      });

      sendJson(response, 201, artifact);
      return true;
    }

    const deploymentMatch = url.pathname.match(
      /^\/v1\/kosh\/automation\/runner\/deployments\/([^/]+)$/
    );
    if (deploymentMatch && request.method === "PATCH") {
      const body = await readJson(request, 64 * 1024);
      const status =
        ["queued", "running", "success", "failure", "cancelled"].includes(
          String(body.status)
        )
          ? String(body.status) as KoshDeploymentStatus
          : null;
      if (!status) {
        throw Object.assign(new Error("valid_deployment_status_required"), {
          status: 400
        });
      }
      const deployment = await store.updateDeployment(
        decodeURIComponent(deploymentMatch[1]),
        status,
        body.url === undefined ? undefined : clean(body.url, 2000) || null
      );
      if (!deployment) {
        throw Object.assign(new Error("deployment_not_found"), { status: 404 });
      }
      sendJson(response, 200, deployment);
      return true;
    }

    sendJson(response, 404, { error: "runner_route_not_found" });
    return true;
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error
        ? Number((error as { status?: number }).status) || 500
        : 500;
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "runner_error" }
    );
    return true;
  }
}

export async function handleKoshAutomationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (await handleRunner(request, response, url)) return true;

  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/automation(.*)$/
  );
  if (!match) return false;

  const identity = await requireIdentity(
    request,
    response,
    origin,
    allowedOrigins
  );
  if (!identity) return true;

  try {
    await store.ready();
    const namespace = match[1];
    const slug = match[2];
    const tail = match[3] || "";
    const repository = await repositoryStore.get(namespace, slug);

    if (!repository) {
      throw Object.assign(new Error("repository_not_found"), { status: 404 });
    }

    if (request.method === "GET" && (tail === "" || tail === "/summary")) {
      const [workflows, runs, environments, deployments] = await Promise.all([
        store.listWorkflows(repository.id),
        store.listRuns(repository.id, 100),
        store.listEnvironments(repository.id),
        store.listDeployments(repository.id, 100)
      ]);

      sendJson(
        response,
        200,
        {
          workflows,
          runs,
          environments,
          deployments,
          runnerConfigured: Boolean(process.env.KOSH_RUNNER_TOKEN?.trim())
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/workflows" && request.method === "GET") {
      sendJson(
        response,
        200,
        { workflows: await store.listWorkflows(repository.id) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/workflows" && request.method === "POST") {
      const body = await readJson(request, 512 * 1024);
      const definition = validateWorkflowDefinition(body.definition);
      const path =
        clean(body.path, 300) ||
        ".kosh/workflows/" +
          definition.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") +
          ".kosh.json";

      const workflow = await store.createWorkflow({
        repositoryId: repository.id,
        name: definition.name,
        path,
        enabled: body.enabled !== false,
        definition,
        createdByUserId: identity.user.id,
        createdByName: identity.user.displayName
      });

      sendJson(response, 201, workflow, origin, allowedOrigins);
      return true;
    }

    const workflowMatch = tail.match(/^\/workflows\/([^/]+)$/);
    if (workflowMatch && request.method === "PATCH") {
      const workflowId = decodeURIComponent(workflowMatch[1]);
      const body = await readJson(request, 512 * 1024);
      const definition =
        body.definition === undefined
          ? undefined
          : validateWorkflowDefinition(body.definition);

      const workflow = await store.updateWorkflow(
        repository.id,
        workflowId,
        {
          name: body.name === undefined ? undefined : clean(body.name, 120),
          path: body.path === undefined ? undefined : clean(body.path, 300),
          enabled:
            body.enabled === undefined ? undefined : body.enabled === true,
          definition
        }
      );
      if (!workflow) {
        throw Object.assign(new Error("workflow_not_found"), { status: 404 });
      }
      sendJson(response, 200, workflow, origin, allowedOrigins);
      return true;
    }

    const runWorkflowMatch = tail.match(
      /^\/workflows\/([^/]+)\/runs$/
    );
    if (runWorkflowMatch && request.method === "POST") {
      const workflowId = decodeURIComponent(runWorkflowMatch[1]);
      const body = await readJson(request, 64 * 1024);
      const refName = clean(body.refName, 240) || repository.defaultBranch;
      const commitSha = clean(body.commitSha, 40);

      if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
        throw Object.assign(new Error("valid_commit_sha_required"), {
          status: 400
        });
      }

      const run = await scheduleWorkflow(
        repository,
        workflowId,
        "manual",
        refName,
        commitSha,
        { id: identity.user.id, name: identity.user.displayName },
        null
      );
      sendJson(response, 201, run, origin, allowedOrigins);
      return true;
    }

    if (tail === "/runs" && request.method === "GET") {
      sendJson(
        response,
        200,
        { runs: await store.listRuns(repository.id, 200) },
        origin,
        allowedOrigins
      );
      return true;
    }

    const runMatch = tail.match(/^\/runs\/([^/]+)$/);
    if (runMatch && request.method === "GET") {
      const runId = decodeURIComponent(runMatch[1]);
      const run = await store.getRun(repository.id, runId);
      if (!run) {
        throw Object.assign(new Error("run_not_found"), { status: 404 });
      }
      const jobs = await store.listJobs(run.id);
      const jobDetails = await Promise.all(
        jobs.map(async (job) => ({
          ...job,
          logs: await store.listLogs(job.id)
        }))
      );
      sendJson(
        response,
        200,
        {
          run,
          jobs: jobDetails,
          artifacts: await store.listArtifacts(run.id)
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/environments" && request.method === "GET") {
      sendJson(
        response,
        200,
        { environments: await store.listEnvironments(repository.id) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/environments" && request.method === "POST") {
      const body = await readJson(request, 64 * 1024);
      const name = clean(body.name, 100);
      if (!name) {
        throw Object.assign(new Error("environment_name_required"), {
          status: 400
        });
      }

      const environment = await store.createEnvironment({
        repositoryId: repository.id,
        name,
        requiredApprovals: Math.max(
          0,
          Math.min(20, Number(body.requiredApprovals) || 0)
        ),
        protectedBranches: Array.isArray(body.protectedBranches)
          ? body.protectedBranches.map(String).slice(0, 100)
          : []
      });

      sendJson(response, 201, environment, origin, allowedOrigins);
      return true;
    }

    if (tail === "/deployments" && request.method === "GET") {
      sendJson(
        response,
        200,
        { deployments: await store.listDeployments(repository.id, 200) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/deployments" && request.method === "POST") {
      const body = await readJson(request, 64 * 1024);
      const environmentId = clean(body.environmentId, 160);
      const environment = (await store.listEnvironments(repository.id))
        .find((item) => item.id === environmentId);
      if (!environment) {
        throw Object.assign(new Error("environment_not_found"), { status: 404 });
      }

      const commitSha = clean(body.commitSha, 40);
      if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
        throw Object.assign(new Error("valid_commit_sha_required"), {
          status: 400
        });
      }

      const refName = clean(body.refName, 240) || repository.defaultBranch;
      if (
        environment.protectedBranches.length &&
        !environment.protectedBranches.includes(refName)
      ) {
        throw Object.assign(new Error("environment_branch_not_allowed"), {
          status: 403
        });
      }

      const deployment = await store.createDeployment({
        repositoryId: repository.id,
        environmentId: environment.id,
        environmentName: environment.name,
        runId: clean(body.runId, 160) || null,
        refName,
        commitSha,
        status: "queued",
        url: null,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName
      });

      sendJson(response, 201, deployment, origin, allowedOrigins);
      return true;
    }

    sendJson(
      response,
      404,
      { error: "kosh_automation_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
