import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshStore } from "./kosh-store.js";
import { getKoshWorkStore } from "./kosh-work-store.js";
import { getKoshReviewStore } from "./kosh-review-store.js";
import { getKoshAutomationStore } from "./kosh-automation-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import {
  getKoshFlowStore,
  type KoshFlowEntityType,
  type KoshFlowRelation
} from "./kosh-flow-store.js";

const repositoryStore = getKoshStore();
const workStore = getKoshWorkStore();
const reviewStore = getKoshReviewStore();
const automationStore = getKoshAutomationStore();
const platformStore = getKoshPlatformStore();
const flowStore = getKoshFlowStore();

type JsonBody = Record<string, unknown>;

type FlowStage = "plan" | "change" | "validate" | "deliver" | "operate";
type FlowHealth = "neutral" | "good" | "attention" | "blocked" | "failed";

type FlowNode = {
  id: string;
  type: KoshFlowEntityType;
  ref: string;
  title: string;
  subtitle: string;
  stage: FlowStage;
  state: string;
  health: FlowHealth;
  href: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

type FlowEdge = {
  id: string;
  source: string;
  target: string;
  relation: KoshFlowRelation;
  origin: "derived" | "manual";
  note: string;
};

type FlowTimelineEvent = {
  id: string;
  at: string;
  kind: string;
  title: string;
  detail: string;
  href: string;
  actor: string | null;
};

const entityTypes = new Set<KoshFlowEntityType>([
  "issue",
  "change_review",
  "commit",
  "workflow_run",
  "package",
  "release",
  "deployment",
  "milestone",
  "discussion",
  "backup",
  "page_site"
]);

const relations = new Set<KoshFlowRelation>([
  "depends_on",
  "implements",
  "references",
  "validated_by",
  "produces",
  "promotes_to",
  "delivers_to",
  "blocks",
  "relates_to",
  "supersedes",
  "contains"
] as KoshFlowRelation[]);

function nodeId(type: KoshFlowEntityType, ref: string | number) {
  return type + ":" + String(ref);
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
  limit = 256 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.length;
    if (total > limit) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(value);
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

function healthForRun(status: string): FlowHealth {
  if (status === "success") return "good";
  if (status === "failure" || status === "cancelled") return "failed";
  if (status === "running" || status === "queued") return "attention";
  return "neutral";
}

function healthForResource(state: string): FlowHealth {
  const value = state.toLowerCase();
  if (["ready", "published", "released", "active", "verified"].includes(value)) {
    return "good";
  }
  if (["failed", "error", "rejected"].includes(value)) return "failed";
  if (["blocked", "waiting", "queued", "draft"].includes(value)) return "attention";
  return "neutral";
}

function uniqueEdge(
  edges: FlowEdge[],
  source: string,
  target: string,
  relation: KoshFlowRelation,
  origin: "derived" | "manual",
  note = "",
  id?: string
) {
  if (source === target) return;
  if (
    edges.some(
      (edge) =>
        edge.source === source &&
        edge.target === target &&
        edge.relation === relation
    )
  ) {
    return;
  }
  edges.push({
    id: id ?? "derived:" + relation + ":" + source + ":" + target,
    source,
    target,
    relation,
    origin,
    note
  });
}

function makeHref(
  namespace: string,
  slug: string,
  kind: KoshFlowEntityType,
  ref: string
) {
  const base =
    "namespace=" +
    encodeURIComponent(namespace) +
    "&slug=" +
    encodeURIComponent(slug);

  if (kind === "issue") {
    return "/apps/kosh/work?" + base + "&issue=" + encodeURIComponent(ref);
  }
  if (kind === "change_review") {
    return "/apps/kosh/review?" + base + "&number=" + encodeURIComponent(ref);
  }
  if (kind === "workflow_run" || kind === "deployment") {
    return "/apps/kosh/automation?" + base;
  }
  if (
    kind === "package" ||
    kind === "release" ||
    kind === "backup" ||
    kind === "page_site"
  ) {
    return "/apps/kosh/platform?" + base;
  }
  if (kind === "milestone" || kind === "discussion") {
    return "/apps/kosh/work?" + base;
  }
  return "/apps/kosh/repository?" + base;
}

async function buildFlowGraph(
  repository: Awaited<ReturnType<typeof repositoryStore.get>>
) {
  if (!repository) {
    throw Object.assign(new Error("repository_not_found"), { status: 404 });
  }

  await Promise.all([
    workStore.ready(),
    reviewStore.ready(),
    automationStore.ready(),
    platformStore.ready(),
    flowStore.ready()
  ]);

  const [
    issues,
    milestones,
    discussions,
    workActivity,
    changeRequests,
    runs,
    deployments,
    packages,
    releases,
    backups,
    pageSites,
    manualLinks,
    auditEvents
  ] = await Promise.all([
    workStore.listIssues(repository.id),
    workStore.listMilestones(repository.id),
    workStore.listDiscussions(repository.id),
    workStore.listActivity(repository.id, 200),
    reviewStore.listChangeRequests(repository.id),
    automationStore.listRuns(repository.id, 300),
    automationStore.listDeployments(repository.id, 300),
    platformStore.listResources("package", repository.id),
    platformStore.listResources("release", repository.id),
    platformStore.listResources("backup", repository.id),
    platformStore.listResources("page_site", repository.id),
    flowStore.listLinks(repository.id),
    platformStore.listAudit(repository.id, 200)
  ]);

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const nodeMap = new Map<string, FlowNode>();

  function addNode(node: FlowNode) {
    if (nodeMap.has(node.id)) return nodeMap.get(node.id)!;
    nodes.push(node);
    nodeMap.set(node.id, node);
    return node;
  }

  function addCommitNode(sha: string, title = "Commit") {
    if (!/^[0-9a-f]{40}$/i.test(sha)) return null;
    return addNode({
      id: nodeId("commit", sha),
      type: "commit",
      ref: sha,
      title: title + " " + sha.slice(0, 8),
      subtitle: "Git commit",
      stage: "change",
      state: "committed",
      health: "neutral",
      href: makeHref(repository.namespace, repository.slug, "commit", sha),
      updatedAt: repository.updatedAt,
      metadata: { sha }
    });
  }

  for (const milestone of milestones) {
    const overdue =
      milestone.state === "open" &&
      milestone.dueAt &&
      new Date(milestone.dueAt).getTime() < Date.now();

    addNode({
      id: nodeId("milestone", milestone.id),
      type: "milestone",
      ref: milestone.id,
      title: milestone.title,
      subtitle: milestone.dueAt
        ? "Due " + new Date(milestone.dueAt).toLocaleDateString()
        : "Milestone",
      stage: "plan",
      state: milestone.state,
      health:
        milestone.state === "closed"
          ? "good"
          : overdue
            ? "attention"
            : "neutral",
      href: makeHref(repository.namespace, repository.slug, "milestone", milestone.id),
      updatedAt: milestone.updatedAt,
      metadata: {
        dueAt: milestone.dueAt,
        description: milestone.description
      }
    });
  }

  for (const issue of issues) {
    const dependencies = await workStore.listDependencies(issue.id);
    const blocking = dependencies.filter(
      (dependency) => dependency.dependsOnState !== "closed"
    );

    addNode({
      id: nodeId("issue", issue.number),
      type: "issue",
      ref: String(issue.number),
      title: "#" + issue.number + " " + issue.title,
      subtitle:
        issue.assigneeName
          ? "Assigned to " + issue.assigneeName
          : issue.milestoneTitle || "Work item",
      stage: "plan",
      state: issue.state,
      health:
        issue.state === "closed"
          ? "good"
          : blocking.length
            ? "blocked"
            : "attention",
      href: makeHref(repository.namespace, repository.slug, "issue", String(issue.number)),
      updatedAt: issue.updatedAt,
      metadata: {
        milestoneId: issue.milestoneId,
        milestoneTitle: issue.milestoneTitle,
        assigneeName: issue.assigneeName,
        blockedBy: blocking.map((item) => item.dependsOnNumber)
      }
    });

    if (issue.milestoneId) {
      uniqueEdge(
        edges,
        nodeId("milestone", issue.milestoneId),
        nodeId("issue", issue.number),
        "contains",
        "derived"
      );
    }

    for (const dependency of dependencies) {
      uniqueEdge(
        edges,
        nodeId("issue", issue.number),
        nodeId("issue", dependency.dependsOnNumber),
        "depends_on",
        "derived"
      );
    }

    const links = await workStore.listIssueLinks(issue.id);
    for (const link of links) {
      if (link.linkType === "change_request") {
        uniqueEdge(
          edges,
          nodeId("issue", issue.number),
          nodeId("change_review", link.refValue),
          "implements",
          "derived",
          link.title ?? ""
        );
      } else if (link.linkType === "commit") {
        addCommitNode(link.refValue);
        uniqueEdge(
          edges,
          nodeId("issue", issue.number),
          nodeId("commit", link.refValue),
          "references",
          "derived",
          link.title ?? ""
        );
      }
    }
  }

  for (const discussion of discussions.slice(0, 100)) {
    addNode({
      id: nodeId("discussion", discussion.number),
      type: "discussion",
      ref: String(discussion.number),
      title: discussion.title,
      subtitle: discussion.category,
      stage: "plan",
      state: discussion.state,
      health: discussion.state === "locked" ? "neutral" : "attention",
      href: makeHref(
        repository.namespace,
        repository.slug,
        "discussion",
        String(discussion.number)
      ),
      updatedAt: discussion.updatedAt,
      metadata: {
        category: discussion.category,
        authorName: discussion.authorName
      }
    });
  }

  const checkSummaries = new Map<
    number,
    { required: number; pending: number; failing: number }
  >();

  await Promise.all(
    changeRequests.map(async (changeRequest) => {
      const checks = await automationStore.listChecks(
        repository.id,
        changeRequest.headSha
      );
      const required = checks.filter((check) => check.required);
      checkSummaries.set(changeRequest.number, {
        required: required.length,
        pending: required.filter(
          (check) => check.status === "queued" || check.status === "running"
        ).length,
        failing: required.filter(
          (check) => check.status === "failure" || check.status === "cancelled"
        ).length
      });
    })
  );

  for (const changeRequest of changeRequests) {
    const checkSummary = checkSummaries.get(changeRequest.number) ?? {
      required: 0,
      pending: 0,
      failing: 0
    };

    addNode({
      id: nodeId("change_review", changeRequest.number),
      type: "change_review",
      ref: String(changeRequest.number),
      title: "CR #" + changeRequest.number + " " + changeRequest.title,
      subtitle:
        changeRequest.headBranch + " → " + changeRequest.baseBranch,
      stage: "change",
      state: changeRequest.status,
      health:
        changeRequest.status === "merged"
          ? "good"
          : changeRequest.status === "closed"
            ? "neutral"
            : checkSummary.failing
              ? "failed"
              : checkSummary.pending
                ? "attention"
                : "attention",
      href: makeHref(
        repository.namespace,
        repository.slug,
        "change_review",
        String(changeRequest.number)
      ),
      updatedAt: changeRequest.updatedAt,
      metadata: {
        headSha: changeRequest.headSha,
        baseSha: changeRequest.baseSha,
        checks: checkSummary,
        mergeCommitSha: changeRequest.mergeCommitSha
      }
    });

    addCommitNode(changeRequest.headSha, "Head");
    uniqueEdge(
      edges,
      nodeId("change_review", changeRequest.number),
      nodeId("commit", changeRequest.headSha),
      "references",
      "derived"
    );

    if (changeRequest.mergeCommitSha) {
      addCommitNode(changeRequest.mergeCommitSha, "Merge");
      uniqueEdge(
        edges,
        nodeId("change_review", changeRequest.number),
        nodeId("commit", changeRequest.mergeCommitSha),
        "produces",
        "derived"
      );
    }
  }

  for (const run of runs) {
    addNode({
      id: nodeId("workflow_run", run.id),
      type: "workflow_run",
      ref: run.id,
      title: run.workflowName,
      subtitle:
        run.triggerType + " · " + run.refName + " · " + run.commitSha.slice(0, 8),
      stage: "validate",
      state: run.status,
      health: healthForRun(run.status),
      href: makeHref(repository.namespace, repository.slug, "workflow_run", run.id),
      updatedAt: run.completedAt ?? run.startedAt ?? run.createdAt,
      metadata: {
        triggerType: run.triggerType,
        commitSha: run.commitSha,
        changeRequestNumber: run.changeRequestNumber,
        refName: run.refName
      }
    });

    addCommitNode(run.commitSha);

    if (run.changeRequestNumber) {
      uniqueEdge(
        edges,
        nodeId("change_review", run.changeRequestNumber),
        nodeId("workflow_run", run.id),
        "validated_by",
        "derived"
      );
    } else {
      uniqueEdge(
        edges,
        nodeId("commit", run.commitSha),
        nodeId("workflow_run", run.id),
        "validated_by",
        "derived"
      );
    }
  }

  for (const resource of packages) {
    const packageKey = String(resource.payload.packageKey ?? resource.name);
    const version = String(resource.payload.version ?? "");
    addNode({
      id: nodeId("package", resource.id),
      type: "package",
      ref: resource.id,
      title: packageKey + (version ? "@" + version : ""),
      subtitle: String(resource.payload.format ?? "package"),
      stage: "deliver",
      state: resource.state,
      health: healthForResource(resource.state),
      href: makeHref(repository.namespace, repository.slug, "package", resource.id),
      updatedAt: resource.updatedAt,
      metadata: resource.payload
    });

    const runId = String(resource.payload.runId ?? "");
    const commitSha = String(resource.payload.commitSha ?? "");
    if (runId) {
      uniqueEdge(
        edges,
        nodeId("workflow_run", runId),
        nodeId("package", resource.id),
        "produces",
        "derived"
      );
    } else if (/^[0-9a-f]{40}$/i.test(commitSha)) {
      addCommitNode(commitSha);
      uniqueEdge(
        edges,
        nodeId("commit", commitSha),
        nodeId("package", resource.id),
        "produces",
        "derived"
      );
    }
  }

  for (const resource of releases) {
    const tag = String(resource.payload.tag ?? resource.key);
    addNode({
      id: nodeId("release", resource.id),
      type: "release",
      ref: resource.id,
      title: resource.name,
      subtitle: tag || "Release",
      stage: "deliver",
      state: resource.state,
      health: healthForResource(resource.state),
      href: makeHref(repository.namespace, repository.slug, "release", resource.id),
      updatedAt: resource.updatedAt,
      metadata: resource.payload
    });

    const runId = String(resource.payload.runId ?? "");
    const commitSha = String(resource.payload.commitSha ?? "");
    const packageId = String(resource.payload.packageId ?? "");
    if (runId) {
      uniqueEdge(
        edges,
        nodeId("workflow_run", runId),
        nodeId("release", resource.id),
        "produces",
        "derived"
      );
    }
    if (packageId) {
      uniqueEdge(
        edges,
        nodeId("package", packageId),
        nodeId("release", resource.id),
        "promotes_to",
        "derived"
      );
    }
    if (/^[0-9a-f]{40}$/i.test(commitSha)) {
      addCommitNode(commitSha);
      uniqueEdge(
        edges,
        nodeId("commit", commitSha),
        nodeId("release", resource.id),
        "promotes_to",
        "derived"
      );
    }
  }

  for (const deployment of deployments) {
    addNode({
      id: nodeId("deployment", deployment.id),
      type: "deployment",
      ref: deployment.id,
      title: deployment.environmentName,
      subtitle:
        deployment.refName + " · " + deployment.commitSha.slice(0, 8),
      stage: "operate",
      state: deployment.status,
      health: healthForRun(deployment.status),
      href: makeHref(repository.namespace, repository.slug, "deployment", deployment.id),
      updatedAt: deployment.updatedAt,
      metadata: {
        environmentName: deployment.environmentName,
        runId: deployment.runId,
        commitSha: deployment.commitSha,
        url: deployment.url
      }
    });

    if (deployment.runId) {
      uniqueEdge(
        edges,
        nodeId("workflow_run", deployment.runId),
        nodeId("deployment", deployment.id),
        "delivers_to",
        "derived"
      );
    } else {
      addCommitNode(deployment.commitSha);
      uniqueEdge(
        edges,
        nodeId("commit", deployment.commitSha),
        nodeId("deployment", deployment.id),
        "delivers_to",
        "derived"
      );
    }

    for (const release of releases) {
      if (
        String(release.payload.commitSha ?? "") === deployment.commitSha
      ) {
        uniqueEdge(
          edges,
          nodeId("release", release.id),
          nodeId("deployment", deployment.id),
          "delivers_to",
          "derived"
        );
      }
    }
  }

  for (const resource of backups.slice(0, 100)) {
    addNode({
      id: nodeId("backup", resource.id),
      type: "backup",
      ref: resource.id,
      title: resource.name,
      subtitle: String(resource.payload.kind ?? "Backup"),
      stage: "operate",
      state: resource.state,
      health: healthForResource(resource.state),
      href: makeHref(repository.namespace, repository.slug, "backup", resource.id),
      updatedAt: resource.updatedAt,
      metadata: resource.payload
    });
  }

  for (const resource of pageSites.slice(0, 50)) {
    addNode({
      id: nodeId("page_site", resource.id),
      type: "page_site",
      ref: resource.id,
      title: resource.name,
      subtitle: String(resource.payload.sourceBranch ?? repository.defaultBranch),
      stage: "operate",
      state: resource.state,
      health: healthForResource(resource.state),
      href: makeHref(repository.namespace, repository.slug, "page_site", resource.id),
      updatedAt: resource.updatedAt,
      metadata: resource.payload
    });
  }

  for (const link of manualLinks) {
    const source = nodeId(link.sourceType, link.sourceRef);
    const target = nodeId(link.targetType, link.targetRef);
    uniqueEdge(
      edges,
      source,
      target,
      link.relation,
      "manual",
      link.note,
      link.id
    );
  }

  const timeline: FlowTimelineEvent[] = [];

  for (const activity of workActivity) {
    timeline.push({
      id: "work:" + activity.id,
      at: activity.createdAt,
      kind: activity.eventType,
      title:
        activity.entityNumber
          ? activity.entityType + " #" + activity.entityNumber
          : activity.entityType,
      detail: activity.eventType.replace(/_/g, " "),
      href:
        activity.entityType === "issue" && activity.entityNumber
          ? makeHref(
              repository.namespace,
              repository.slug,
              "issue",
              String(activity.entityNumber)
            )
          : makeHref(repository.namespace, repository.slug, "discussion", ""),
      actor: activity.actorName
    });
  }

  for (const changeRequest of changeRequests) {
    timeline.push({
      id: "cr:" + changeRequest.id,
      at: changeRequest.updatedAt,
      kind:
        changeRequest.status === "merged"
          ? "change_review_merged"
          : changeRequest.status === "closed"
            ? "change_review_closed"
            : "change_review_updated",
      title: "CR #" + changeRequest.number + " " + changeRequest.title,
      detail: changeRequest.status,
      href: makeHref(
        repository.namespace,
        repository.slug,
        "change_review",
        String(changeRequest.number)
      ),
      actor:
        changeRequest.status === "merged"
          ? changeRequest.mergedByName
          : changeRequest.authorName
    });
  }

  for (const run of runs) {
    timeline.push({
      id: "run:" + run.id,
      at: run.completedAt ?? run.startedAt ?? run.createdAt,
      kind: "automation_" + run.status,
      title: run.workflowName,
      detail: run.status + " · " + run.refName,
      href: makeHref(repository.namespace, repository.slug, "workflow_run", run.id),
      actor: run.actorName
    });
  }

  for (const deployment of deployments) {
    timeline.push({
      id: "deployment:" + deployment.id,
      at: deployment.updatedAt,
      kind: "deployment_" + deployment.status,
      title: deployment.environmentName,
      detail: deployment.status + " · " + deployment.refName,
      href: makeHref(repository.namespace, repository.slug, "deployment", deployment.id),
      actor: deployment.actorName
    });
  }

  for (const resource of [...packages, ...releases, ...backups, ...pageSites]) {
    timeline.push({
      id: "resource:" + resource.id,
      at: resource.updatedAt,
      kind: resource.type + "_" + resource.state,
      title: resource.name,
      detail: resource.state,
      href: makeHref(
        repository.namespace,
        repository.slug,
        resource.type as KoshFlowEntityType,
        resource.id
      ),
      actor: resource.createdByName
    });
  }

  for (const event of auditEvents) {
    if (
      timeline.some(
        (item) =>
          item.at === event.createdAt &&
          item.kind === event.eventType
      )
    ) {
      continue;
    }
    timeline.push({
      id: "audit:" + event.id,
      at: event.createdAt,
      kind: event.eventType,
      title: event.resourceType,
      detail: event.eventType.replace(/_/g, " "),
      href: makeHref(repository.namespace, repository.slug, "backup", ""),
      actor: event.actorName
    });
  }

  timeline.sort((a, b) => b.at.localeCompare(a.at));

  const visibleEdges = edges.filter(
    (edge) => nodeMap.has(edge.source) && nodeMap.has(edge.target)
  );

  const healthCounts = {
    good: nodes.filter((node) => node.health === "good").length,
    attention: nodes.filter((node) => node.health === "attention").length,
    blocked: nodes.filter((node) => node.health === "blocked").length,
    failed: nodes.filter((node) => node.health === "failed").length,
    neutral: nodes.filter((node) => node.health === "neutral").length
  };

  const stageCounts: Record<FlowStage, number> = {
    plan: nodes.filter((node) => node.stage === "plan").length,
    change: nodes.filter((node) => node.stage === "change").length,
    validate: nodes.filter((node) => node.stage === "validate").length,
    deliver: nodes.filter((node) => node.stage === "deliver").length,
    operate: nodes.filter((node) => node.stage === "operate").length
  };

  const nextActions = nodes
    .filter(
      (node) =>
        node.health === "failed" ||
        node.health === "blocked" ||
        node.health === "attention"
    )
    .sort((a, b) => {
      const rank: Record<FlowHealth, number> = {
        failed: 0,
        blocked: 1,
        attention: 2,
        neutral: 3,
        good: 4
      };
      const healthOrder = rank[a.health] - rank[b.health];
      return healthOrder || b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, 20)
    .map((node) => ({
      id: node.id,
      title: node.title,
      stage: node.stage,
      health: node.health,
      href: node.href,
      reason:
        node.health === "failed"
          ? "A connected execution or delivery failed."
          : node.health === "blocked"
            ? "A dependency is still unresolved."
            : "This item is active or waiting for progress."
    }));

  return {
    repository: {
      id: repository.id,
      namespace: repository.namespace,
      slug: repository.slug,
      name: repository.name
    },
    state:
      healthCounts.failed > 0
        ? "failed"
        : healthCounts.blocked > 0
          ? "blocked"
          : healthCounts.attention > 0
            ? "moving"
            : "stable",
    summary: {
      nodes: nodes.length,
      edges: visibleEdges.length,
      manualLinks: manualLinks.length,
      stageCounts,
      healthCounts
    },
    nodes,
    edges: visibleEdges,
    nextActions,
    timeline: timeline.slice(0, 200)
  };
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
    { error: error instanceof Error ? error.message : "kosh_flow_error" },
    origin,
    allowedOrigins
  );
}

export async function handleKoshFlowRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/flow(.*)$/
  );
  if (!match) return false;

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
    const namespace = match[1];
    const slug = match[2];
    const tail = match[3] || "";
    const repository = await repositoryStore.get(namespace, slug);
    if (!repository) {
      throw Object.assign(new Error("repository_not_found"), { status: 404 });
    }

    if (
      request.method === "GET" &&
      (tail === "" || tail === "/graph" || tail === "/summary")
    ) {
      sendJson(
        response,
        200,
        await buildFlowGraph(repository),
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/links" && request.method === "GET") {
      await flowStore.ready();
      sendJson(
        response,
        200,
        { links: await flowStore.listLinks(repository.id) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/links" && request.method === "POST") {
      const body = await readJson(request);
      const sourceType = clean(body.sourceType, 40) as KoshFlowEntityType;
      const targetType = clean(body.targetType, 40) as KoshFlowEntityType;
      const relation = clean(body.relation, 40) as KoshFlowRelation;
      const sourceRef = clean(body.sourceRef, 240);
      const targetRef = clean(body.targetRef, 240);

      if (
        !entityTypes.has(sourceType) ||
        !entityTypes.has(targetType) ||
        !relations.has(relation) ||
        !sourceRef ||
        !targetRef
      ) {
        throw Object.assign(new Error("invalid_flow_link"), { status: 400 });
      }

      const graph = await buildFlowGraph(repository);
      const validNodes = new Set(
        graph.nodes.map((node: FlowNode) => node.id)
      );
      if (
        !validNodes.has(nodeId(sourceType, sourceRef)) ||
        !validNodes.has(nodeId(targetType, targetRef))
      ) {
        throw Object.assign(new Error("flow_link_entity_not_found"), {
          status: 404
        });
      }

      const link = await flowStore.createLink({
        repositoryId: repository.id,
        sourceType,
        sourceRef,
        targetType,
        targetRef,
        relation,
        note: clean(body.note, 500),
        createdByUserId: identity.user.id,
        createdByName: identity.user.displayName
      });

      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "flow_link_created",
        resourceType: "flow_link",
        resourceId: link.id,
        metadata: {
          sourceType,
          sourceRef,
          targetType,
          targetRef,
          relation
        }
      });

      sendJson(response, 201, link, origin, allowedOrigins);
      return true;
    }

    const linkMatch = tail.match(/^\/links\/([^/]+)$/);
    if (linkMatch && request.method === "DELETE") {
      const id = decodeURIComponent(linkMatch[1]);
      const deleted = await flowStore.deleteLink(repository.id, id);
      if (!deleted) {
        throw Object.assign(new Error("flow_link_not_found"), { status: 404 });
      }

      await platformStore.appendAudit({
        repositoryId: repository.id,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "flow_link_deleted",
        resourceType: "flow_link",
        resourceId: id,
        metadata: {}
      });

      sendJson(response, 200, { deleted: true }, origin, allowedOrigins);
      return true;
    }

    sendJson(
      response,
      404,
      { error: "kosh_flow_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
