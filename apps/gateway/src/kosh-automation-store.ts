import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";

export type KoshRunStatus =
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "cancelled";

export type KoshJobStatus = KoshRunStatus;
export type KoshTriggerType = "manual" | "change_request" | "push";
export type KoshDeploymentStatus = "queued" | "running" | "success" | "failure" | "cancelled";

export type KoshWorkflowStepDefinition = {
  name: string;
  run: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  continueOnError?: boolean;
};

export type KoshRunnerNetworkMode = "none" | "egress";

export type KoshWorkflowJobDefinition = {
  id: string;
  name: string;
  timeoutMinutes?: number;
  env?: Record<string, string>;
  image?: string;
  network?: KoshRunnerNetworkMode;
  cpu?: number;
  memoryMb?: number;
  pidsLimit?: number;
  secrets?: string[];
  steps: KoshWorkflowStepDefinition[];
};

export type KoshWorkflowDefinition = {
  version: 1;
  name: string;
  triggers: {
    manual?: boolean;
    push?: { branches?: string[] };
    changeRequest?: { branches?: string[] };
  };
  env?: Record<string, string>;
  jobs: KoshWorkflowJobDefinition[];
};

export type StoredKoshWorkflow = {
  id: string;
  repositoryId: string;
  name: string;
  path: string;
  enabled: boolean;
  definition: KoshWorkflowDefinition;
  createdByUserId: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshWorkflowRun = {
  id: string;
  repositoryId: string;
  workflowId: string;
  workflowName: string;
  triggerType: KoshTriggerType;
  refName: string;
  commitSha: string;
  status: KoshRunStatus;
  actorUserId: string | null;
  actorName: string | null;
  changeRequestNumber: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type StoredKoshJob = {
  id: string;
  runId: string;
  repositoryId: string;
  workflowId: string;
  jobKey: string;
  name: string;
  status: KoshJobStatus;
  runnerId: string | null;
  attempt: number;
  timeoutMinutes: number;
  definition: KoshWorkflowJobDefinition;
  leaseExpiresAt: string | null;
  lastHeartbeatAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshJobLog = {
  id: string;
  jobId: string;
  sequence: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
  createdAt: string;
};

export type StoredKoshArtifact = {
  id: string;
  runId: string;
  jobId: string;
  name: string;
  storagePath: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

export type StoredKoshEnvironment = {
  id: string;
  repositoryId: string;
  name: string;
  requiredApprovals: number;
  protectedBranches: string[];
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshDeployment = {
  id: string;
  repositoryId: string;
  environmentId: string;
  environmentName: string;
  runId: string | null;
  refName: string;
  commitSha: string;
  status: KoshDeploymentStatus;
  url: string | null;
  actorUserId: string | null;
  actorName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type StoredKoshCheck = {
  id: string;
  repositoryId: string;
  commitSha: string;
  name: string;
  status: KoshRunStatus;
  runId: string | null;
  required: boolean;
  details: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface KoshAutomationStore {
  readonly kind: "ephemeral-memory" | "postgres";
  ready(): Promise<void>;

  listWorkflows(repositoryId: string): Promise<StoredKoshWorkflow[]>;
  getWorkflow(repositoryId: string, workflowId: string): Promise<StoredKoshWorkflow | null>;
  createWorkflow(input: Omit<StoredKoshWorkflow, "id" | "createdAt" | "updatedAt">): Promise<StoredKoshWorkflow>;
  updateWorkflow(
    repositoryId: string,
    workflowId: string,
    input: Partial<Pick<StoredKoshWorkflow, "name" | "path" | "enabled" | "definition">>
  ): Promise<StoredKoshWorkflow | null>;

  createRun(input: Omit<StoredKoshWorkflowRun, "id" | "status" | "startedAt" | "completedAt" | "createdAt">): Promise<StoredKoshWorkflowRun>;
  listRuns(repositoryId: string, limit?: number): Promise<StoredKoshWorkflowRun[]>;
  getRun(repositoryId: string, runId: string): Promise<StoredKoshWorkflowRun | null>;
  updateRunStatus(runId: string, status: KoshRunStatus): Promise<StoredKoshWorkflowRun | null>;

  createJobs(
    runId: string,
    repositoryId: string,
    workflowId: string,
    jobs: KoshWorkflowJobDefinition[]
  ): Promise<StoredKoshJob[]>;
  listJobs(runId: string): Promise<StoredKoshJob[]>;
  claimNextJob(
    runnerId: string,
    leaseToken: string,
    leaseSeconds: number
  ): Promise<StoredKoshJob | null>;
  renewJobLease(
    jobId: string,
    runnerId: string,
    leaseToken: string,
    leaseSeconds: number
  ): Promise<StoredKoshJob | null>;
  verifyJobLease(
    jobId: string,
    runnerId: string,
    leaseToken: string
  ): Promise<boolean>;
  requeueExpiredJobs(): Promise<StoredKoshJob[]>;
  updateJobStatus(jobId: string, status: KoshJobStatus): Promise<StoredKoshJob | null>;

  appendLog(jobId: string, stream: StoredKoshJobLog["stream"], text: string): Promise<StoredKoshJobLog>;
  listLogs(jobId: string): Promise<StoredKoshJobLog[]>;

  createArtifact(input: Omit<StoredKoshArtifact, "id" | "createdAt">): Promise<StoredKoshArtifact>;
  listArtifacts(runId: string): Promise<StoredKoshArtifact[]>;

  listEnvironments(repositoryId: string): Promise<StoredKoshEnvironment[]>;
  createEnvironment(input: Omit<StoredKoshEnvironment, "id" | "createdAt" | "updatedAt">): Promise<StoredKoshEnvironment>;

  createDeployment(input: Omit<StoredKoshDeployment, "id" | "createdAt" | "updatedAt">): Promise<StoredKoshDeployment>;
  listDeployments(repositoryId: string, limit?: number): Promise<StoredKoshDeployment[]>;
  updateDeployment(id: string, status: KoshDeploymentStatus, url?: string | null): Promise<StoredKoshDeployment | null>;

  upsertCheck(input: Omit<StoredKoshCheck, "id" | "createdAt" | "updatedAt">): Promise<StoredKoshCheck>;
  listChecks(repositoryId: string, commitSha: string): Promise<StoredKoshCheck[]>;
}

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function leaseHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function aggregateRunStatus(jobs: StoredKoshJob[]): KoshRunStatus {
  if (!jobs.length) return "success";
  if (jobs.some((job) => job.status === "failure")) return "failure";
  if (jobs.some((job) => job.status === "cancelled")) return "cancelled";
  if (jobs.every((job) => job.status === "success")) return "success";
  if (jobs.some((job) => job.status === "running")) return "running";
  return "queued";
}

class MemoryKoshAutomationStore implements KoshAutomationStore {
  readonly kind = "ephemeral-memory" as const;
  private workflows = new Map<string, StoredKoshWorkflow>();
  private runs = new Map<string, StoredKoshWorkflowRun>();
  private jobs = new Map<string, StoredKoshJob>();
  private jobLeases = new Map<string, string>();
  private logs = new Map<string, StoredKoshJobLog>();
  private artifacts = new Map<string, StoredKoshArtifact>();
  private environments = new Map<string, StoredKoshEnvironment>();
  private deployments = new Map<string, StoredKoshDeployment>();
  private checks = new Map<string, StoredKoshCheck>();

  async ready() {}

  async listWorkflows(repositoryId: string) {
    return [...this.workflows.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(clone);
  }

  async getWorkflow(repositoryId: string, workflowId: string) {
    const item = this.workflows.get(workflowId);
    return item && item.repositoryId === repositoryId ? clone(item) : null;
  }

  async createWorkflow(input: Omit<StoredKoshWorkflow, "id" | "createdAt" | "updatedAt">) {
    const created = now();
    const item: StoredKoshWorkflow = {
      ...input,
      id: randomUUID(),
      createdAt: created,
      updatedAt: created
    };
    this.workflows.set(item.id, item);
    return clone(item);
  }

  async updateWorkflow(repositoryId: string, workflowId: string, input: Partial<Pick<StoredKoshWorkflow, "name" | "path" | "enabled" | "definition">>) {
    const item = this.workflows.get(workflowId);
    if (!item || item.repositoryId !== repositoryId) return null;
    Object.assign(item, input, { updatedAt: now() });
    return clone(item);
  }

  async createRun(input: Omit<StoredKoshWorkflowRun, "id" | "status" | "startedAt" | "completedAt" | "createdAt">) {
    const item: StoredKoshWorkflowRun = {
      ...input,
      id: randomUUID(),
      status: "queued",
      startedAt: null,
      completedAt: null,
      createdAt: now()
    };
    this.runs.set(item.id, item);
    return clone(item);
  }

  async listRuns(repositoryId: string, limit = 100) {
    return [...this.runs.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map(clone);
  }

  async getRun(repositoryId: string, runId: string) {
    const item = this.runs.get(runId);
    return item && item.repositoryId === repositoryId ? clone(item) : null;
  }

  async updateRunStatus(runId: string, status: KoshRunStatus) {
    const item = this.runs.get(runId);
    if (!item) return null;
    item.status = status;
    if (status === "running" && !item.startedAt) item.startedAt = now();
    if (["success", "failure", "cancelled"].includes(status)) item.completedAt = now();
    return clone(item);
  }

  async createJobs(runId: string, repositoryId: string, workflowId: string, definitions: KoshWorkflowJobDefinition[]) {
    const created: StoredKoshJob[] = [];
    for (const definition of definitions) {
      const timestamp = now();
      const job: StoredKoshJob = {
        id: randomUUID(),
        runId,
        repositoryId,
        workflowId,
        jobKey: definition.id,
        name: definition.name,
        status: "queued",
        runnerId: null,
        attempt: 1,
        timeoutMinutes: Math.max(1, Math.min(180, definition.timeoutMinutes ?? 30)),
        definition,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        startedAt: null,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      this.jobs.set(job.id, job);
      created.push(clone(job));
    }
    return created;
  }

  async listJobs(runId: string) {
    return [...this.jobs.values()]
      .filter((item) => item.runId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async claimNextJob(
    runnerId: string,
    leaseToken: string,
    leaseSeconds: number
  ) {
    await this.requeueExpiredJobs();
    const job = [...this.jobs.values()]
      .filter((item) => item.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return null;

    const timestamp = now();
    job.status = "running";
    job.runnerId = runnerId;
    job.startedAt = timestamp;
    job.lastHeartbeatAt = timestamp;
    job.leaseExpiresAt = new Date(
      Date.now() + Math.max(30, Math.min(600, leaseSeconds)) * 1000
    ).toISOString();
    job.updatedAt = timestamp;
    this.jobLeases.set(job.id, leaseHash(leaseToken));

    const run = this.runs.get(job.runId);
    if (run && run.status === "queued") {
      run.status = "running";
      run.startedAt = timestamp;
    }
    return clone(job);
  }

  async renewJobLease(
    jobId: string,
    runnerId: string,
    leaseToken: string,
    leaseSeconds: number
  ) {
    const job = this.jobs.get(jobId);
    if (
      !job ||
      job.status !== "running" ||
      job.runnerId !== runnerId ||
      this.jobLeases.get(jobId) !== leaseHash(leaseToken)
    ) {
      return null;
    }

    const timestamp = now();
    job.lastHeartbeatAt = timestamp;
    job.leaseExpiresAt = new Date(
      Date.now() + Math.max(30, Math.min(600, leaseSeconds)) * 1000
    ).toISOString();
    job.updatedAt = timestamp;
    return clone(job);
  }

  async verifyJobLease(
    jobId: string,
    runnerId: string,
    leaseToken: string
  ) {
    const job = this.jobs.get(jobId);
    if (
      !job ||
      job.status !== "running" ||
      job.runnerId !== runnerId ||
      !job.leaseExpiresAt ||
      new Date(job.leaseExpiresAt).getTime() <= Date.now()
    ) {
      return false;
    }
    return this.jobLeases.get(jobId) === leaseHash(leaseToken);
  }

  async requeueExpiredJobs() {
    const expired: StoredKoshJob[] = [];
    const timestamp = Date.now();

    for (const job of this.jobs.values()) {
      if (
        job.status === "running" &&
        job.leaseExpiresAt &&
        new Date(job.leaseExpiresAt).getTime() <= timestamp
      ) {
        job.status = "queued";
        job.runnerId = null;
        job.attempt += 1;
        job.leaseExpiresAt = null;
        job.lastHeartbeatAt = null;
        job.startedAt = null;
        job.updatedAt = now();
        this.jobLeases.delete(job.id);
        expired.push(clone(job));
      }
    }

    return expired;
  }

  async updateJobStatus(jobId: string, status: KoshJobStatus) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    job.status = status;
    job.updatedAt = now();
    if (["success", "failure", "cancelled"].includes(status)) {
      job.completedAt = job.updatedAt;
      job.leaseExpiresAt = null;
      job.lastHeartbeatAt = null;
      this.jobLeases.delete(job.id);
    }

    const siblingJobs = [...this.jobs.values()].filter((item) => item.runId === job.runId);
    const runStatus = aggregateRunStatus(siblingJobs);
    const run = this.runs.get(job.runId);
    if (run) {
      run.status = runStatus;
      if (runStatus === "running" && !run.startedAt) run.startedAt = now();
      if (["success", "failure", "cancelled"].includes(runStatus)) run.completedAt = now();
    }

    return clone(job);
  }

  async appendLog(jobId: string, stream: StoredKoshJobLog["stream"], text: string) {
    const sequence = [...this.logs.values()].filter((item) => item.jobId === jobId).length + 1;
    const item: StoredKoshJobLog = {
      id: randomUUID(),
      jobId,
      sequence,
      stream,
      text: text.slice(0, 64 * 1024),
      createdAt: now()
    };
    this.logs.set(item.id, item);
    return clone(item);
  }

  async listLogs(jobId: string) {
    return [...this.logs.values()]
      .filter((item) => item.jobId === jobId)
      .sort((a, b) => a.sequence - b.sequence)
      .map(clone);
  }

  async createArtifact(input: Omit<StoredKoshArtifact, "id" | "createdAt">) {
    const item: StoredKoshArtifact = { ...input, id: randomUUID(), createdAt: now() };
    this.artifacts.set(item.id, item);
    return clone(item);
  }

  async listArtifacts(runId: string) {
    return [...this.artifacts.values()]
      .filter((item) => item.runId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  async listEnvironments(repositoryId: string) {
    return [...this.environments.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(clone);
  }

  async createEnvironment(input: Omit<StoredKoshEnvironment, "id" | "createdAt" | "updatedAt">) {
    const timestamp = now();
    const item: StoredKoshEnvironment = {
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.environments.set(item.id, item);
    return clone(item);
  }

  async createDeployment(input: Omit<StoredKoshDeployment, "id" | "createdAt" | "updatedAt">) {
    const timestamp = now();
    const item: StoredKoshDeployment = {
      ...input,
      id: randomUUID(),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.deployments.set(item.id, item);
    return clone(item);
  }

  async listDeployments(repositoryId: string, limit = 100) {
    return [...this.deployments.values()]
      .filter((item) => item.repositoryId === repositoryId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(500, limit)))
      .map(clone);
  }

  async updateDeployment(id: string, status: KoshDeploymentStatus, url?: string | null) {
    const item = this.deployments.get(id);
    if (!item) return null;
    item.status = status;
    if (url !== undefined) item.url = url;
    item.updatedAt = now();
    return clone(item);
  }

  async upsertCheck(input: Omit<StoredKoshCheck, "id" | "createdAt" | "updatedAt">) {
    const key = input.repositoryId + ":" + input.commitSha + ":" + input.name;
    const existing = this.checks.get(key);
    const timestamp = now();
    const item: StoredKoshCheck = {
      ...input,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };
    this.checks.set(key, item);
    return clone(item);
  }

  async listChecks(repositoryId: string, commitSha: string) {
    return [...this.checks.values()]
      .filter((item) => item.repositoryId === repositoryId && item.commitSha === commitSha)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(clone);
  }
}

function iso(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseDefinition(value: unknown): KoshWorkflowDefinition {
  if (value && typeof value === "object") return value as KoshWorkflowDefinition;
  if (typeof value === "string") return JSON.parse(value) as KoshWorkflowDefinition;
  throw new Error("invalid_workflow_definition");
}

function workflowFromRow(row: Record<string, unknown>): StoredKoshWorkflow {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    name: String(row.name),
    path: String(row.path),
    enabled: Boolean(row.enabled),
    definition: parseDefinition(row.definition),
    createdByUserId: String(row.created_by_user_id),
    createdByName: String(row.created_by_name),
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

function runFromRow(row: Record<string, unknown>): StoredKoshWorkflowRun {
  return {
    id: String(row.id),
    repositoryId: String(row.repository_id),
    workflowId: String(row.workflow_id),
    workflowName: String(row.workflow_name),
    triggerType: String(row.trigger_type) as KoshTriggerType,
    refName: String(row.ref_name),
    commitSha: String(row.commit_sha),
    status: String(row.status) as KoshRunStatus,
    actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
    actorName: row.actor_name ? String(row.actor_name) : null,
    changeRequestNumber: row.change_request_number == null ? null : Number(row.change_request_number),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at) ?? now()
  };
}

function jobFromRow(row: Record<string, unknown>): StoredKoshJob {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    repositoryId: String(row.repository_id),
    workflowId: String(row.workflow_id),
    jobKey: String(row.job_key),
    name: String(row.name),
    status: String(row.status) as KoshJobStatus,
    runnerId: row.runner_id ? String(row.runner_id) : null,
    attempt: Number(row.attempt),
    timeoutMinutes: Number(row.timeout_minutes),
    definition: parseDefinition({ version: 1, name: "job", triggers: {}, jobs: [row.definition] }).jobs[0],
    leaseExpiresAt: iso(row.lease_expires_at),
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at) ?? now(),
    updatedAt: iso(row.updated_at) ?? now()
  };
}

class PostgresKoshAutomationStore implements KoshAutomationStore {
  readonly kind = "postgres" as const;
  private initialized = false;

  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async ready() {
    if (this.initialized) return;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_workflows (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      definition JSONB NOT NULL,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, path)
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_workflow_runs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      ref_name TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      actor_user_id TEXT,
      actor_name TEXT,
      change_request_number INTEGER,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (trigger_type IN ('manual','change_request','push')),
      CHECK (status IN ('queued','running','success','failure','cancelled'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_workflow_runs_repository_idx
      ON kosh_workflow_runs(repository_id, created_at DESC)`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_workflow_jobs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      job_key TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      runner_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      timeout_minutes INTEGER NOT NULL DEFAULT 30,
      definition JSONB NOT NULL,
      lease_hash TEXT,
      lease_expires_at TIMESTAMPTZ,
      last_heartbeat_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status IN ('queued','running','success','failure','cancelled'))
    )`;

    await this.sql`CREATE INDEX IF NOT EXISTS kosh_workflow_jobs_queue_idx
      ON kosh_workflow_jobs(status, created_at ASC)`;

    await this.sql`
      ALTER TABLE kosh_workflow_jobs
      ADD COLUMN IF NOT EXISTS lease_hash TEXT
    `;
    await this.sql`
      ALTER TABLE kosh_workflow_jobs
      ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ
    `;
    await this.sql`
      ALTER TABLE kosh_workflow_jobs
      ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ
    `;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_workflow_logs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      stream TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(job_id, sequence),
      CHECK (stream IN ('stdout','stderr','system'))
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_workflow_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      name TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_environments (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      name TEXT NOT NULL,
      required_approvals INTEGER NOT NULL DEFAULT 0,
      protected_branches JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, name)
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_deployments (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      environment_name TEXT NOT NULL,
      run_id TEXT,
      ref_name TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      url TEXT,
      actor_user_id TEXT,
      actor_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status IN ('queued','running','success','failure','cancelled'))
    )`;

    await this.sql`CREATE TABLE IF NOT EXISTS kosh_checks (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      required BOOLEAN NOT NULL DEFAULT TRUE,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(repository_id, commit_sha, name),
      CHECK (status IN ('queued','running','success','failure','cancelled'))
    )`;

    this.initialized = true;
  }

  async listWorkflows(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_workflows WHERE repository_id = ${repositoryId} ORDER BY name ASC`;
    return rows.map((row) => workflowFromRow(row as Record<string, unknown>));
  }

  async getWorkflow(repositoryId: string, workflowId: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_workflows WHERE repository_id = ${repositoryId} AND id = ${workflowId} LIMIT 1`;
    const row = rows[0] as Record<string, unknown> | undefined;
    return row ? workflowFromRow(row) : null;
  }

  async createWorkflow(input: Omit<StoredKoshWorkflow, "id" | "createdAt" | "updatedAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_workflows(id, repository_id, name, path, enabled, definition, created_by_user_id, created_by_name)
      VALUES (
        ${randomUUID()}, ${input.repositoryId}, ${input.name}, ${input.path}, ${input.enabled},
        ${JSON.stringify(input.definition)}::jsonb, ${input.createdByUserId}, ${input.createdByName}
      )
      RETURNING *
    `;
    return workflowFromRow(rows[0] as Record<string, unknown>);
  }

  async updateWorkflow(repositoryId: string, workflowId: string, input: Partial<Pick<StoredKoshWorkflow, "name" | "path" | "enabled" | "definition">>) {
    await this.ready();
    const current = await this.getWorkflow(repositoryId, workflowId);
    if (!current) return null;
    const rows = await this.sql`
      UPDATE kosh_workflows
      SET name = ${input.name ?? current.name},
          path = ${input.path ?? current.path},
          enabled = ${input.enabled ?? current.enabled},
          definition = ${JSON.stringify(input.definition ?? current.definition)}::jsonb,
          updated_at = NOW()
      WHERE repository_id = ${repositoryId} AND id = ${workflowId}
      RETURNING *
    `;
    return rows[0] ? workflowFromRow(rows[0] as Record<string, unknown>) : null;
  }

  async createRun(input: Omit<StoredKoshWorkflowRun, "id" | "status" | "startedAt" | "completedAt" | "createdAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_workflow_runs(
        id, repository_id, workflow_id, workflow_name, trigger_type, ref_name,
        commit_sha, actor_user_id, actor_name, change_request_number
      )
      VALUES (
        ${randomUUID()}, ${input.repositoryId}, ${input.workflowId}, ${input.workflowName},
        ${input.triggerType}, ${input.refName}, ${input.commitSha},
        ${input.actorUserId}, ${input.actorName}, ${input.changeRequestNumber}
      )
      RETURNING *
    `;
    return runFromRow(rows[0] as Record<string, unknown>);
  }

  async listRuns(repositoryId: string, limit = 100) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_workflow_runs
      WHERE repository_id = ${repositoryId}
      ORDER BY created_at DESC
      LIMIT ${Math.max(1, Math.min(500, limit))}
    `;
    return rows.map((row) => runFromRow(row as Record<string, unknown>));
  }

  async getRun(repositoryId: string, runId: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_workflow_runs WHERE repository_id = ${repositoryId} AND id = ${runId} LIMIT 1`;
    return rows[0] ? runFromRow(rows[0] as Record<string, unknown>) : null;
  }

  async updateRunStatus(runId: string, status: KoshRunStatus) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_workflow_runs
      SET status = ${status},
          started_at = CASE WHEN ${status} = 'running' THEN COALESCE(started_at, NOW()) ELSE started_at END,
          completed_at = CASE WHEN ${status} IN ('success','failure','cancelled') THEN NOW() ELSE completed_at END
      WHERE id = ${runId}
      RETURNING *
    `;
    return rows[0] ? runFromRow(rows[0] as Record<string, unknown>) : null;
  }

  async createJobs(runId: string, repositoryId: string, workflowId: string, definitions: KoshWorkflowJobDefinition[]) {
    await this.ready();
    const result: StoredKoshJob[] = [];
    for (const definition of definitions) {
      const rows = await this.sql`
        INSERT INTO kosh_workflow_jobs(
          id, run_id, repository_id, workflow_id, job_key, name, timeout_minutes, definition
        )
        VALUES (
          ${randomUUID()}, ${runId}, ${repositoryId}, ${workflowId},
          ${definition.id}, ${definition.name},
          ${Math.max(1, Math.min(180, definition.timeoutMinutes ?? 30))},
          ${JSON.stringify(definition)}::jsonb
        )
        RETURNING *
      `;
      result.push(jobFromRow(rows[0] as Record<string, unknown>));
    }
    return result;
  }

  async listJobs(runId: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_workflow_jobs WHERE run_id = ${runId} ORDER BY created_at ASC`;
    return rows.map((row) => jobFromRow(row as Record<string, unknown>));
  }

  async claimNextJob(
    runnerId: string,
    leaseToken: string,
    leaseSeconds: number
  ) {
    await this.ready();
    await this.requeueExpiredJobs();

    const ttl = Math.max(30, Math.min(600, leaseSeconds));
    const hashedLease = leaseHash(leaseToken);
    const rows = await this.sql.begin(async (tx) => tx`
      WITH candidate AS (
        SELECT id
        FROM kosh_workflow_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE kosh_workflow_jobs j
      SET status = 'running',
          runner_id = ${runnerId},
          lease_hash = ${hashedLease},
          lease_expires_at = NOW() + (${ttl} * INTERVAL '1 second'),
          last_heartbeat_at = NOW(),
          started_at = NOW(),
          updated_at = NOW()
      FROM candidate
      WHERE j.id = candidate.id
      RETURNING j.*
    `);
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const job = jobFromRow(row);
    await this.updateRunStatus(job.runId, "running");
    return job;
  }

  async renewJobLease(
    jobId: string,
    runnerId: string,
    leaseToken: string,
    leaseSeconds: number
  ) {
    await this.ready();
    const ttl = Math.max(30, Math.min(600, leaseSeconds));
    const rows = await this.sql`
      UPDATE kosh_workflow_jobs
      SET lease_expires_at = NOW() + (${ttl} * INTERVAL '1 second'),
          last_heartbeat_at = NOW(),
          updated_at = NOW()
      WHERE id = ${jobId}
        AND status = 'running'
        AND runner_id = ${runnerId}
        AND lease_hash = ${leaseHash(leaseToken)}
        AND lease_expires_at > NOW()
      RETURNING *
    `;
    return rows[0]
      ? jobFromRow(rows[0] as Record<string, unknown>)
      : null;
  }

  async verifyJobLease(
    jobId: string,
    runnerId: string,
    leaseToken: string
  ) {
    await this.ready();
    const rows = await this.sql`
      SELECT id
      FROM kosh_workflow_jobs
      WHERE id = ${jobId}
        AND status = 'running'
        AND runner_id = ${runnerId}
        AND lease_hash = ${leaseHash(leaseToken)}
        AND lease_expires_at > NOW()
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async requeueExpiredJobs() {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_workflow_jobs
      SET status = 'queued',
          runner_id = NULL,
          attempt = attempt + 1,
          lease_hash = NULL,
          lease_expires_at = NULL,
          last_heartbeat_at = NULL,
          started_at = NULL,
          updated_at = NOW()
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
      RETURNING *
    `;
    return rows.map((row) =>
      jobFromRow(row as Record<string, unknown>)
    );
  }

  async updateJobStatus(jobId: string, status: KoshJobStatus) {
    await this.ready();
    const rows = await this.sql`
      UPDATE kosh_workflow_jobs
      SET status = ${status},
          completed_at = CASE WHEN ${status} IN ('success','failure','cancelled') THEN NOW() ELSE completed_at END,
          lease_hash = CASE WHEN ${status} IN ('success','failure','cancelled') THEN NULL ELSE lease_hash END,
          lease_expires_at = CASE WHEN ${status} IN ('success','failure','cancelled') THEN NULL ELSE lease_expires_at END,
          last_heartbeat_at = CASE WHEN ${status} IN ('success','failure','cancelled') THEN NULL ELSE last_heartbeat_at END,
          updated_at = NOW()
      WHERE id = ${jobId}
      RETURNING *
    `;
    if (!rows[0]) return null;
    const job = jobFromRow(rows[0] as Record<string, unknown>);
    const siblings = await this.listJobs(job.runId);
    const runStatus = aggregateRunStatus(siblings);
    await this.updateRunStatus(job.runId, runStatus);
    return job;
  }

  async appendLog(jobId: string, stream: StoredKoshJobLog["stream"], text: string) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_workflow_logs(id, job_id, sequence, stream, text)
      VALUES (
        ${randomUUID()}, ${jobId},
        COALESCE((SELECT MAX(sequence) + 1 FROM kosh_workflow_logs WHERE job_id = ${jobId}), 1),
        ${stream}, ${text.slice(0, 64 * 1024)}
      )
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      jobId: String(row.job_id),
      sequence: Number(row.sequence),
      stream: String(row.stream) as StoredKoshJobLog["stream"],
      text: String(row.text),
      createdAt: iso(row.created_at) ?? now()
    };
  }

  async listLogs(jobId: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_workflow_logs WHERE job_id = ${jobId} ORDER BY sequence ASC`;
    return rows.map((row) => ({
      id: String(row.id),
      jobId: String(row.job_id),
      sequence: Number(row.sequence),
      stream: String(row.stream) as StoredKoshJobLog["stream"],
      text: String(row.text),
      createdAt: iso(row.created_at) ?? now()
    }));
  }

  async createArtifact(input: Omit<StoredKoshArtifact, "id" | "createdAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_workflow_artifacts(id, run_id, job_id, name, storage_path, size_bytes, sha256)
      VALUES (${randomUUID()}, ${input.runId}, ${input.jobId}, ${input.name}, ${input.storagePath}, ${input.sizeBytes}, ${input.sha256})
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      runId: String(row.run_id),
      jobId: String(row.job_id),
      name: String(row.name),
      storagePath: String(row.storage_path),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      createdAt: iso(row.created_at) ?? now()
    };
  }

  async listArtifacts(runId: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_workflow_artifacts WHERE run_id = ${runId} ORDER BY created_at ASC`;
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      jobId: String(row.job_id),
      name: String(row.name),
      storagePath: String(row.storage_path),
      sizeBytes: Number(row.size_bytes),
      sha256: String(row.sha256),
      createdAt: iso(row.created_at) ?? now()
    }));
  }

  async listEnvironments(repositoryId: string) {
    await this.ready();
    const rows = await this.sql`SELECT * FROM kosh_environments WHERE repository_id = ${repositoryId} ORDER BY name ASC`;
    return rows.map((row) => ({
      id: String(row.id),
      repositoryId: String(row.repository_id),
      name: String(row.name),
      requiredApprovals: Number(row.required_approvals),
      protectedBranches: Array.isArray(row.protected_branches) ? row.protected_branches.map(String) : [],
      createdAt: iso(row.created_at) ?? now(),
      updatedAt: iso(row.updated_at) ?? now()
    }));
  }

  async createEnvironment(input: Omit<StoredKoshEnvironment, "id" | "createdAt" | "updatedAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_environments(id, repository_id, name, required_approvals, protected_branches)
      VALUES (
        ${randomUUID()}, ${input.repositoryId}, ${input.name}, ${input.requiredApprovals},
        ${JSON.stringify(input.protectedBranches)}::jsonb
      )
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id),
      repositoryId: String(row.repository_id),
      name: String(row.name),
      requiredApprovals: Number(row.required_approvals),
      protectedBranches: Array.isArray(row.protected_branches) ? row.protected_branches.map(String) : [],
      createdAt: iso(row.created_at) ?? now(),
      updatedAt: iso(row.updated_at) ?? now()
    };
  }

  async createDeployment(input: Omit<StoredKoshDeployment, "id" | "createdAt" | "updatedAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_deployments(
        id, repository_id, environment_id, environment_name, run_id, ref_name,
        commit_sha, status, url, actor_user_id, actor_name
      )
      VALUES (
        ${randomUUID()}, ${input.repositoryId}, ${input.environmentId}, ${input.environmentName},
        ${input.runId}, ${input.refName}, ${input.commitSha}, ${input.status},
        ${input.url}, ${input.actorUserId}, ${input.actorName}
      )
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id), repositoryId: String(row.repository_id),
      environmentId: String(row.environment_id), environmentName: String(row.environment_name),
      runId: row.run_id ? String(row.run_id) : null, refName: String(row.ref_name),
      commitSha: String(row.commit_sha), status: String(row.status) as KoshDeploymentStatus,
      url: row.url ? String(row.url) : null, actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      actorName: row.actor_name ? String(row.actor_name) : null,
      createdAt: iso(row.created_at) ?? now(), updatedAt: iso(row.updated_at) ?? now()
    };
  }

  async listDeployments(repositoryId: string, limit = 100) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_deployments WHERE repository_id = ${repositoryId}
      ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(500, limit))}
    `;
    return rows.map((row) => ({
      id: String(row.id), repositoryId: String(row.repository_id),
      environmentId: String(row.environment_id), environmentName: String(row.environment_name),
      runId: row.run_id ? String(row.run_id) : null, refName: String(row.ref_name),
      commitSha: String(row.commit_sha), status: String(row.status) as KoshDeploymentStatus,
      url: row.url ? String(row.url) : null, actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      actorName: row.actor_name ? String(row.actor_name) : null,
      createdAt: iso(row.created_at) ?? now(), updatedAt: iso(row.updated_at) ?? now()
    }));
  }

  async updateDeployment(id: string, status: KoshDeploymentStatus, url?: string | null) {
    await this.ready();
    const currentRows = await this.sql`SELECT * FROM kosh_deployments WHERE id = ${id} LIMIT 1`;
    if (!currentRows[0]) return null;
    const current = currentRows[0] as Record<string, unknown>;
    const rows = await this.sql`
      UPDATE kosh_deployments
      SET status = ${status}, url = ${url === undefined ? (current.url ? String(current.url) : null) : url}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id), repositoryId: String(row.repository_id),
      environmentId: String(row.environment_id), environmentName: String(row.environment_name),
      runId: row.run_id ? String(row.run_id) : null, refName: String(row.ref_name),
      commitSha: String(row.commit_sha), status: String(row.status) as KoshDeploymentStatus,
      url: row.url ? String(row.url) : null, actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      actorName: row.actor_name ? String(row.actor_name) : null,
      createdAt: iso(row.created_at) ?? now(), updatedAt: iso(row.updated_at) ?? now()
    };
  }

  async upsertCheck(input: Omit<StoredKoshCheck, "id" | "createdAt" | "updatedAt">) {
    await this.ready();
    const rows = await this.sql`
      INSERT INTO kosh_checks(
        id, repository_id, commit_sha, name, status, run_id, required, details
      )
      VALUES (
        ${randomUUID()}, ${input.repositoryId}, ${input.commitSha}, ${input.name},
        ${input.status}, ${input.runId}, ${input.required}, ${input.details}
      )
      ON CONFLICT(repository_id, commit_sha, name)
      DO UPDATE SET status = EXCLUDED.status, run_id = EXCLUDED.run_id,
                    required = EXCLUDED.required, details = EXCLUDED.details, updated_at = NOW()
      RETURNING *
    `;
    const row = rows[0] as Record<string, unknown>;
    return {
      id: String(row.id), repositoryId: String(row.repository_id),
      commitSha: String(row.commit_sha), name: String(row.name),
      status: String(row.status) as KoshRunStatus,
      runId: row.run_id ? String(row.run_id) : null,
      required: Boolean(row.required), details: row.details ? String(row.details) : null,
      createdAt: iso(row.created_at) ?? now(), updatedAt: iso(row.updated_at) ?? now()
    };
  }

  async listChecks(repositoryId: string, commitSha: string) {
    await this.ready();
    const rows = await this.sql`
      SELECT * FROM kosh_checks
      WHERE repository_id = ${repositoryId} AND commit_sha = ${commitSha}
      ORDER BY name ASC
    `;
    return rows.map((row) => ({
      id: String(row.id), repositoryId: String(row.repository_id),
      commitSha: String(row.commit_sha), name: String(row.name),
      status: String(row.status) as KoshRunStatus,
      runId: row.run_id ? String(row.run_id) : null,
      required: Boolean(row.required), details: row.details ? String(row.details) : null,
      createdAt: iso(row.created_at) ?? now(), updatedAt: iso(row.updated_at) ?? now()
    }));
  }
}

let singleton: KoshAutomationStore | null = null;

export function getKoshAutomationStore(): KoshAutomationStore {
  if (singleton) return singleton;
  const databaseUrl = process.env.WORKSPACE_DATABASE_URL?.trim();
  singleton = databaseUrl
    ? new PostgresKoshAutomationStore(postgres(databaseUrl, { max: 5, prepare: false }))
    : new MemoryKoshAutomationStore();
  return singleton;
}
