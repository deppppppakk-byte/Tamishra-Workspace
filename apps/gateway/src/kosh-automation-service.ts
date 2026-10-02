import type { StoredKoshRepository } from "./kosh-store.js";
import {
  getKoshAutomationStore,
  type KoshTriggerType,
  type KoshWorkflowDefinition,
  type StoredKoshWorkflowRun
} from "./kosh-automation-store.js";

const store = getKoshAutomationStore();

export type KoshAutomationActor = {
  id: string | null;
  name: string | null;
};

function branchMatches(branch: string, patterns?: string[]) {
  if (!patterns?.length) return true;
  return patterns.some((pattern) => {
    const value = pattern.trim();
    if (!value) return false;
    if (value === "*" || value === "**") return true;
    if (!value.includes("*")) return value === branch;

    const escaped = value
      .replace(/[.*+?^()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*");
    return new RegExp("^" + escaped + "$").test(branch);
  });
}

export function validateWorkflowDefinition(
  value: unknown
): KoshWorkflowDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("workflow_definition_required"), {
      status: 400
    });
  }

  const input = value as Partial<KoshWorkflowDefinition>;
  const name = String(input.name ?? "").trim().slice(0, 120);
  const triggers =
    input.triggers && typeof input.triggers === "object"
      ? input.triggers
      : {};

  if (!name) {
    throw Object.assign(new Error("workflow_name_required"), { status: 400 });
  }

  if (!Array.isArray(input.jobs) || input.jobs.length < 1 || input.jobs.length > 50) {
    throw Object.assign(new Error("workflow_jobs_required"), { status: 400 });
  }

  const ids = new Set<string>();
  const jobs = input.jobs.map((job, index) => {
    if (!job || typeof job !== "object") {
      throw Object.assign(new Error("invalid_workflow_job"), { status: 400 });
    }

    const id = String(job.id ?? "job-" + (index + 1))
      .trim()
      .slice(0, 80);
    const jobName = String(job.name ?? id).trim().slice(0, 120);

    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || ids.has(id)) {
      throw Object.assign(new Error("invalid_or_duplicate_job_id"), {
        status: 400
      });
    }
    ids.add(id);

    if (!Array.isArray(job.steps) || job.steps.length < 1 || job.steps.length > 100) {
      throw Object.assign(new Error("workflow_steps_required"), { status: 400 });
    }

    const steps = job.steps.map((step, stepIndex) => {
      if (!step || typeof step !== "object") {
        throw Object.assign(new Error("invalid_workflow_step"), { status: 400 });
      }

      const run = String(step.run ?? "").trim();
      if (!run || run.length > 20_000) {
        throw Object.assign(new Error("workflow_step_command_required"), {
          status: 400
        });
      }

      return {
        name: String(step.name ?? "Step " + (stepIndex + 1))
          .trim()
          .slice(0, 160),
        run,
        workingDirectory: step.workingDirectory
          ? String(step.workingDirectory).trim().slice(0, 1000)
          : undefined,
        env:
          step.env && typeof step.env === "object"
            ? Object.fromEntries(
                Object.entries(step.env)
                  .slice(0, 100)
                  .map(([key, val]) => [
                    String(key).slice(0, 100),
                    String(val).slice(0, 4000)
                  ])
              )
            : undefined,
        continueOnError: step.continueOnError === true
      };
    });

    const image = String(job.image ?? "node:22-bookworm-slim")
      .trim()
      .slice(0, 240);
    if (
      !image ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(image)
    ) {
      throw Object.assign(new Error("invalid_runner_image"), { status: 400 });
    }

    const network =
      job.network === "egress" ? "egress" as const : "none" as const;

    const secrets = Array.isArray(job.secrets)
      ? [...new Set(
          job.secrets
            .map((value) => String(value).trim())
            .filter((value) => /^[A-Z][A-Z0-9_]{0,99}$/.test(value))
        )].slice(0, 100)
      : undefined;

    const runsOn = Array.isArray(job.runsOn)
      ? [...new Set(
          job.runsOn
            .map((value) => String(value).trim())
            .filter((value) =>
              /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/.test(value)
            )
        )].slice(0, 32)
      : undefined;

    return {
      id,
      name: jobName || id,
      timeoutMinutes: Math.max(
        1,
        Math.min(180, Number(job.timeoutMinutes) || 30)
      ),
      image,
      network,
      cpu: Math.max(0.1, Math.min(8, Number(job.cpu) || 1)),
      memoryMb: Math.max(
        128,
        Math.min(16_384, Math.floor(Number(job.memoryMb) || 1024))
      ),
      pidsLimit: Math.max(
        32,
        Math.min(2048, Math.floor(Number(job.pidsLimit) || 256))
      ),
      secrets,
      runsOn,
      publishPackages: job.publishPackages === true,
      env:
        job.env && typeof job.env === "object"
          ? Object.fromEntries(
              Object.entries(job.env)
                .slice(0, 100)
                .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(String(key)))
                .map(([key, val]) => [
                  String(key).slice(0, 100),
                  String(val).slice(0, 4000)
                ])
            )
          : undefined,
      steps
    };
  });

  return {
    version: 1,
    name,
    triggers: {
      manual: triggers.manual === true,
      push:
        triggers.push && typeof triggers.push === "object"
          ? {
              branches: Array.isArray(triggers.push.branches)
                ? triggers.push.branches.map(String).slice(0, 100)
                : undefined
            }
          : undefined,
      changeRequest:
        triggers.changeRequest && typeof triggers.changeRequest === "object"
          ? {
              branches: Array.isArray(triggers.changeRequest.branches)
                ? triggers.changeRequest.branches.map(String).slice(0, 100)
                : undefined
            }
          : undefined
    },
    env:
      input.env && typeof input.env === "object"
        ? Object.fromEntries(
            Object.entries(input.env)
              .slice(0, 100)
              .map(([key, val]) => [
                String(key).slice(0, 100),
                String(val).slice(0, 4000)
              ])
          )
        : undefined,
    jobs
  };
}

function workflowMatches(
  definition: KoshWorkflowDefinition,
  triggerType: KoshTriggerType,
  branch: string
) {
  if (triggerType === "manual") return definition.triggers.manual === true;
  if (triggerType === "push") {
    return Boolean(
      definition.triggers.push &&
        branchMatches(branch, definition.triggers.push.branches)
    );
  }

  return Boolean(
    definition.triggers.changeRequest &&
      branchMatches(branch, definition.triggers.changeRequest.branches)
  );
}

export async function scheduleWorkflow(
  repository: StoredKoshRepository,
  workflowId: string,
  triggerType: KoshTriggerType,
  refName: string,
  commitSha: string,
  actor: KoshAutomationActor,
  changeRequestNumber: number | null = null
) {
  await store.ready();
  const workflow = await store.getWorkflow(repository.id, workflowId);
  if (!workflow || !workflow.enabled) {
    throw Object.assign(new Error("workflow_not_found"), { status: 404 });
  }

  if (
    triggerType !== "manual" &&
    !workflowMatches(workflow.definition, triggerType, refName)
  ) {
    return null;
  }

  const run = await store.createRun({
    repositoryId: repository.id,
    workflowId: workflow.id,
    workflowName: workflow.name,
    triggerType,
    refName,
    commitSha,
    actorUserId: actor.id,
    actorName: actor.name,
    changeRequestNumber
  });

  await store.createJobs(
    run.id,
    repository.id,
    workflow.id,
    workflow.definition.jobs
  );

  await store.upsertCheck({
    repositoryId: repository.id,
    commitSha,
    name: workflow.name,
    status: "queued",
    runId: run.id,
    required: triggerType === "change_request",
    details: "Queued"
  });

  return run;
}

export async function scheduleAutomationEvent(
  repository: StoredKoshRepository,
  triggerType: Exclude<KoshTriggerType, "manual">,
  refName: string,
  commitSha: string,
  actor: KoshAutomationActor,
  changeRequestNumber: number | null = null
) {
  await store.ready();
  const workflows = await store.listWorkflows(repository.id);
  const runs: StoredKoshWorkflowRun[] = [];

  for (const workflow of workflows) {
    if (
      workflow.enabled &&
      workflowMatches(workflow.definition, triggerType, refName)
    ) {
      const run = await scheduleWorkflow(
        repository,
        workflow.id,
        triggerType,
        refName,
        commitSha,
        actor,
        changeRequestNumber
      );
      if (run) runs.push(run);
    }
  }

  return runs;
}

export async function syncRunCheck(runId: string) {
  await store.ready();
  const jobs = await store.listJobs(runId);
  if (!jobs[0]) return null;

  const run = await store.getRun(jobs[0].repositoryId, runId);
  if (!run) return null;

  await store.upsertCheck({
    repositoryId: run.repositoryId,
    commitSha: run.commitSha,
    name: run.workflowName,
    status: run.status,
    runId: run.id,
    required: run.triggerType === "change_request",
    details:
      run.status === "success"
        ? "All jobs passed"
        : run.status === "failure"
          ? "One or more jobs failed"
          : run.status
  });

  return run;
}

export async function requiredChecksForCommit(
  repositoryId: string,
  commitSha: string
) {
  await store.ready();
  const checks = await store.listChecks(repositoryId, commitSha);
  const required = checks.filter((check) => check.required);

  return {
    checks,
    required,
    passing: required.every((check) => check.status === "success"),
    pending: required.filter(
      (check) => check.status === "queued" || check.status === "running"
    ).length,
    failing: required.filter(
      (check) =>
        check.status === "failure" ||
        check.status === "cancelled"
    ).length
  };
}

export function automationStore() {
  return store;
}
