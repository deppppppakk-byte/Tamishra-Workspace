"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./automation.module.css";

type Workflow = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  definition: {
    version: 1;
    name: string;
    triggers: {
      manual?: boolean;
      push?: { branches?: string[] };
      changeRequest?: { branches?: string[] };
    };
    jobs: Array<{
      id: string;
      name: string;
      timeoutMinutes?: number;
      steps: Array<{
        name: string;
        run: string;
      }>;
    }>;
  };
};

type Run = {
  id: string;
  workflowId: string;
  workflowName: string;
  triggerType: "manual" | "change_request" | "push";
  refName: string;
  commitSha: string;
  status: "queued" | "running" | "success" | "failure" | "cancelled";
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

type Job = {
  id: string;
  name: string;
  status: Run["status"];
  logs: Array<{
    id: string;
    stream: "stdout" | "stderr" | "system";
    text: string;
  }>;
};

type Artifact = {
  id: string;
  name: string;
  sizeBytes: number;
  sha256: string;
};

type Environment = {
  id: string;
  name: string;
  requiredApprovals: number;
  protectedBranches: string[];
};

type Deployment = {
  id: string;
  environmentName: string;
  refName: string;
  commitSha: string;
  status: Run["status"];
  url: string | null;
  createdAt: string;
};

type Summary = {
  workflows: Workflow[];
  runs: Run[];
  environments: Environment[];
  deployments: Deployment[];
  runnerConfigured: boolean;
};

type Runner = {
  id: string;
  executor: "container" | "host";
  labels: string[];
  capacity: number;
  activeJobs: number;
  version: string;
  os: string;
  arch: string;
  status: "online" | "draining" | "offline";
  lastSeenAt: string;
};

type RunnerPayload = {
  runners: Runner[];
  persistence: string;
};

type RunDetail = {
  run: Run;
  jobs: Job[];
  artifacts: Artifact[];
};

type RepoSummary = {
  repository: {
    defaultBranch: string;
  };
  headSha: string | null;
  empty: boolean;
};

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100";
  return configured.replace(/\/$/, "");
}

function age(value: string) {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";
  return Math.floor(hours / 24) + "d";
}

function sizeLabel(size: number) {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / 1024 / 1024).toFixed(1) + " MB";
}

const starterWorkflow = JSON.stringify(
  {
    version: 1,
    name: "Build and test",
    triggers: {
      manual: true,
      push: { branches: ["main"] },
      changeRequest: { branches: ["main"] }
    },
    jobs: [
      {
        id: "quality",
        name: "Quality checks",
        timeoutMinutes: 30,
        image: "node:22-bookworm-slim",
        network: "egress",
        cpu: 1,
        memoryMb: 1024,
        pidsLimit: 256,
        steps: [
          { name: "Install", run: "npm install" },
          { name: "Check", run: "npm run check" }
        ]
      }
    ]
  },
  null,
  2
);

export function KoshAutomationWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [repoSummary, setRepoSummary] = useState<RepoSummary | null>(null);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [workflowJson, setWorkflowJson] = useState(starterWorkflow);
  const [workflowPath, setWorkflowPath] = useState("");
  const [environmentName, setEnvironmentName] = useState("");
  const [environmentBranches, setEnvironmentBranches] = useState("main");
  const [deploymentEnvironment, setDeploymentEnvironment] = useState("");
  const [deploymentRef, setDeploymentRef] = useState("main");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() ?? "");
    setSlug(params.get("slug")?.trim() ?? "");
  }, []);

  const resourceBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug)
    );
  }, [base, namespace, slug]);

  const automationBase = resourceBase ? resourceBase + "/automation" : "";

  const repositoryHref = useMemo(() => {
    if (!namespace || !slug) return "/apps/kosh";
    return (
      "/apps/kosh/repository?namespace=" +
      encodeURIComponent(namespace) +
      "&slug=" +
      encodeURIComponent(slug)
    );
  }, [namespace, slug]);

  const fetchJson = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store"
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || "Kosh request failed.");
    }
    return payload;
  }, []);

  const mutateJson = useCallback(
    async <T,>(
      url: string,
      method: "POST" | "PATCH",
      body?: unknown
    ): Promise<T> => {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers:
          body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = (await response.json()) as T & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || "Kosh request failed.");
      }
      return payload;
    },
    []
  );

  const load = useCallback(async () => {
    if (!automationBase || !resourceBase) return;
    setLoading(true);
    setError("");
    try {
      const [automation, repository, runnerPayload] = await Promise.all([
        fetchJson<Summary>(automationBase + "/summary"),
        fetchJson<RepoSummary>(resourceBase),
        fetchJson<RunnerPayload>(base + "/v1/kosh/automation/runners").catch(
          () => ({ runners: [], persistence: "restricted" })
        )
      ]);
      setSummary(automation);
      setRepoSummary(repository);
      setRunners(runnerPayload.runners);
      if (!deploymentEnvironment && automation.environments[0]) {
        setDeploymentEnvironment(automation.environments[0].id);
      }
      if (repository.repository.defaultBranch) {
        setDeploymentRef(repository.repository.defaultBranch);
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not load Kosh Automation."
      );
    } finally {
      setLoading(false);
    }
  }, [
    automationBase,
    base,
    deploymentEnvironment,
    fetchJson,
    resourceBase
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!automationBase || !selectedRunId) {
      setRunDetail(null);
      return;
    }

    void fetchJson<RunDetail>(
      automationBase + "/runs/" + encodeURIComponent(selectedRunId)
    )
      .then(setRunDetail)
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : "Could not load run.")
      );
  }, [automationBase, fetchJson, selectedRunId]);

  async function createWorkflow(event: FormEvent) {
    event.preventDefault();
    if (!automationBase) return;
    setMutating(true);
    setError("");
    try {
      const definition = JSON.parse(workflowJson) as unknown;
      await mutateJson(
        automationBase + "/workflows",
        "POST",
        {
          definition,
          path: workflowPath.trim() || undefined
        }
      );
      setWorkflowPath("");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Workflow creation failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function runWorkflow(workflow: Workflow) {
    if (!automationBase || !repoSummary?.headSha) return;
    setMutating(true);
    setError("");
    try {
      const run = await mutateJson<Run>(
        automationBase +
          "/workflows/" +
          encodeURIComponent(workflow.id) +
          "/runs",
        "POST",
        {
          refName: repoSummary.repository.defaultBranch,
          commitSha: repoSummary.headSha
        }
      );
      setSelectedRunId(run.id);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not queue workflow."
      );
    } finally {
      setMutating(false);
    }
  }

  async function createEnvironment() {
    if (!automationBase || !environmentName.trim()) return;
    setMutating(true);
    setError("");
    try {
      const environment = await mutateJson<Environment>(
        automationBase + "/environments",
        "POST",
        {
          name: environmentName.trim(),
          requiredApprovals: 0,
          protectedBranches: environmentBranches
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        }
      );
      setEnvironmentName("");
      setDeploymentEnvironment(environment.id);
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Environment creation failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function createDeployment() {
    if (
      !automationBase ||
      !deploymentEnvironment ||
      !repoSummary?.headSha
    ) {
      return;
    }

    setMutating(true);
    setError("");
    try {
      await mutateJson(
        automationBase + "/deployments",
        "POST",
        {
          environmentId: deploymentEnvironment,
          refName: deploymentRef,
          commitSha: repoSummary.headSha
        }
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Deployment creation failed."
      );
    } finally {
      setMutating(false);
    }
  }

  if (loading && !summary) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Automation</strong>
        <span>Loading workflows and runs…</span>
      </main>
    );
  }

  if (!summary) {
    return (
      <main className={styles.loading}>
        <strong>Automation unavailable</strong>
        <span>{error || "Kosh could not open Automation."}</span>
        <Link href={repositoryHref}>Back to repository</Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH AUTOMATION</p>
          <h1>Workflows & Runners</h1>
          <span>
            Build, test, scan and deploy repository changes with Kosh-owned CI.
          </span>
        </div>

        <div className={styles.statusBox}>
          <span>Runner</span>
          <strong>
            {runners.length
              ? runners.filter((runner) => runner.status === "online").length +
                " online"
              : summary.runnerConfigured
                ? "Configured"
                : "Development mode"}
          </strong>
          <em>
            {runners.length
              ? runners.reduce((total, runner) => total + runner.activeJobs, 0) +
                " / " +
                runners.reduce((total, runner) => total + runner.capacity, 0) +
                " slots active"
              : summary.runs.filter((run) => run.status === "running").length +
                " running"}
          </em>
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        {runners.length > 0 && (
          <section className={styles.panel + " " + styles.runnerPanel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Runner fleet</strong>
                <span>
                  Disposable execution capacity and heartbeat state
                </span>
              </div>
            </div>
            <div className={styles.runnerGrid}>
              {runners.map((runner) => (
                <article className={styles.runnerCard} key={runner.id}>
                  <div>
                    <span className={styles[runner.status]}>
                      {runner.status}
                    </span>
                    <strong>{runner.id}</strong>
                    <small>
                      {runner.executor} · {runner.os}/{runner.arch} · v
                      {runner.version}
                    </small>
                  </div>
                  <div className={styles.runnerCapacity}>
                    <strong>
                      {runner.activeJobs}/{runner.capacity}
                    </strong>
                    <span>active slots</span>
                  </div>
                  <div className={styles.runnerLabels}>
                    {runner.labels.map((label) => (
                      <em key={label}>{label}</em>
                    ))}
                  </div>
                  <small>heartbeat {age(runner.lastSeenAt)}</small>
                </article>
              ))}
            </div>
          </section>
        )}

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Workflows</strong>
                <span>{summary.workflows.length} configured</span>
              </div>
            </div>

            {summary.workflows.map((workflow) => (
              <article className={styles.workflowRow} key={workflow.id}>
                <div>
                  <strong>{workflow.name}</strong>
                  <span>{workflow.path}</span>
                </div>
                <div className={styles.rowActions}>
                  <em>{workflow.enabled ? "enabled" : "disabled"}</em>
                  <button
                    disabled={mutating || !repoSummary?.headSha}
                    onClick={() => void runWorkflow(workflow)}
                  >
                    Run
                  </button>
                </div>
              </article>
            ))}

            {!summary.workflows.length && (
              <div className={styles.empty}>No workflows yet.</div>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Create workflow</strong>
                <span>Kosh Workflow Definition v1</span>
              </div>
            </div>
            <form className={styles.workflowForm} onSubmit={createWorkflow}>
              <label>
                <span>Repository path</span>
                <input
                  value={workflowPath}
                  onChange={(event) => setWorkflowPath(event.target.value)}
                  placeholder=".kosh/workflows/build.kosh.json"
                />
              </label>
              <label>
                <span>Definition</span>
                <textarea
                  value={workflowJson}
                  onChange={(event) => setWorkflowJson(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <button
                className={styles.primary}
                disabled={mutating}
              >
                Save workflow
              </button>
            </form>
          </section>
        </div>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Runs</strong>
                <span>Manual, push and Change Review triggers</span>
              </div>
            </div>

            <div className={styles.runList}>
              {summary.runs.map((run) => (
                <button
                  key={run.id}
                  className={
                    selectedRunId === run.id
                      ? styles.selectedRun
                      : styles.runRow
                  }
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <span className={styles[run.status]}>{run.status}</span>
                  <div>
                    <strong>{run.workflowName}</strong>
                    <em>
                      {run.triggerType} · {run.refName} ·{" "}
                      {run.commitSha.slice(0, 8)} · {age(run.createdAt)}
                    </em>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Run details</strong>
                <span>Jobs, logs and artifacts</span>
              </div>
            </div>

            {runDetail ? (
              <div className={styles.runDetail}>
                <div className={styles.runSummary}>
                  <strong>{runDetail.run.workflowName}</strong>
                  <span className={styles[runDetail.run.status]}>
                    {runDetail.run.status}
                  </span>
                </div>

                {runDetail.jobs.map((job) => (
                  <article className={styles.job} key={job.id}>
                    <div>
                      <strong>{job.name}</strong>
                      <span className={styles[job.status]}>{job.status}</span>
                    </div>
                    <pre>
                      {job.logs.length
                        ? job.logs
                            .map((log) =>
                              (log.stream === "stderr"
                                ? "[stderr] "
                                : log.stream === "system"
                                  ? "[kosh] "
                                  : "") + log.text
                            )
                            .join("")
                        : "No logs yet."}
                    </pre>
                  </article>
                ))}

                {runDetail.artifacts.length > 0 && (
                  <div className={styles.artifacts}>
                    <strong>Artifacts</strong>
                    {runDetail.artifacts.map((artifact) => (
                      <div key={artifact.id}>
                        <span>{artifact.name}</span>
                        <em>{sizeLabel(artifact.sizeBytes)}</em>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className={styles.empty}>Select a workflow run.</div>
            )}
          </section>
        </div>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Environments</strong>
                <span>Production and staging protection</span>
              </div>
            </div>

            <div className={styles.inlineForm}>
              <input
                value={environmentName}
                onChange={(event) => setEnvironmentName(event.target.value)}
                placeholder="production"
              />
              <input
                value={environmentBranches}
                onChange={(event) => setEnvironmentBranches(event.target.value)}
                placeholder="main, release/*"
              />
              <button
                className={styles.primary}
                disabled={mutating || !environmentName.trim()}
                onClick={() => void createEnvironment()}
              >
                Add
              </button>
            </div>

            {summary.environments.map((environment) => (
              <article className={styles.environmentRow} key={environment.id}>
                <div>
                  <strong>{environment.name}</strong>
                  <span>
                    {environment.protectedBranches.length
                      ? environment.protectedBranches.join(", ")
                      : "Any branch"}
                  </span>
                </div>
                <em>{environment.requiredApprovals} approvals</em>
              </article>
            ))}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Deployments</strong>
                <span>Record environment delivery state</span>
              </div>
            </div>

            <div className={styles.deploymentForm}>
              <select
                value={deploymentEnvironment}
                onChange={(event) =>
                  setDeploymentEnvironment(event.target.value)
                }
              >
                <option value="">Select environment</option>
                {summary.environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name}
                  </option>
                ))}
              </select>
              <input
                value={deploymentRef}
                onChange={(event) => setDeploymentRef(event.target.value)}
                placeholder="main"
              />
              <button
                className={styles.primary}
                disabled={
                  mutating ||
                  !deploymentEnvironment ||
                  !repoSummary?.headSha
                }
                onClick={() => void createDeployment()}
              >
                Create deployment
              </button>
            </div>

            {summary.deployments.map((deployment) => (
              <article className={styles.deploymentRow} key={deployment.id}>
                <span className={styles[deployment.status]}>
                  {deployment.status}
                </span>
                <div>
                  <strong>{deployment.environmentName}</strong>
                  <em>
                    {deployment.refName} · {deployment.commitSha.slice(0, 8)} ·{" "}
                    {age(deployment.createdAt)}
                  </em>
                </div>
              </article>
            ))}
          </section>
        </div>
      </section>
    </main>
  );
}
