import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  evaluateKoshRepositoryAccess,
  koshNamespaceAuthority
} from "./kosh-access.js";
import { getKoshStore } from "./kosh-store.js";
import { getKoshPlatformStore } from "./kosh-platform-store.js";
import { buildKoshFlowGraph } from "./kosh-flow.js";
import {
  getKoshMeshStore,
  type KoshMeshNodeType,
  type KoshMeshRelation
} from "./kosh-mesh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const meshStore = getKoshMeshStore();

type JsonBody = Record<string, unknown>;

type KoshMeshIdentity = NonNullable<
  Awaited<ReturnType<typeof resolveKoshIdentity>>
>;

type MeshHealth = "good" | "attention" | "blocked" | "failed" | "neutral";

type MeshNode = {
  ref: string;
  kind: "repository" | "component";
  type: string;
  namespace: string;
  key: string;
  name: string;
  description: string;
  state: string;
  health: MeshHealth;
  href: string;
  url: string | null;
  updatedAt: string;
  metadata: Record<string, unknown>;
};

type MeshLink = {
  id: string;
  sourceRef: string;
  targetRef: string;
  relation: KoshMeshRelation;
  note: string;
  origin: "manual" | "derived";
};

const nodeTypes = new Set<KoshMeshNodeType>([
  "service",
  "app",
  "api",
  "package",
  "data",
  "cad",
  "bim",
  "document",
  "environment",
  "deployment",
  "workspace",
  "component"
]);

const relations = new Set<KoshMeshRelation>([
  "depends_on",
  "provides",
  "consumes",
  "publishes",
  "deploys_to",
  "uses",
  "syncs_with",
  "contains",
  "relates_to",
  "replaces",
  "extends"
]);

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
  limit = 512 * 1024
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

function repositoryRef(namespace: string, slug: string) {
  return "repo:" + namespace + "/" + slug;
}

function componentRef(id: string) {
  return "node:" + id;
}

function healthFromFlow(state: string): MeshHealth {
  if (state === "stable") return "good";
  if (state === "moving") return "attention";
  if (state === "blocked") return "blocked";
  if (state === "failed") return "failed";
  return "neutral";
}

function healthFromState(state: string): MeshHealth {
  const value = state.toLowerCase();
  if (["ready", "active", "healthy", "online", "published"].includes(value)) return "good";
  if (["failed", "error", "offline"].includes(value)) return "failed";
  if (["blocked", "waiting"].includes(value)) return "blocked";
  if (["building", "moving", "queued", "warning"].includes(value)) return "attention";
  return "neutral";
}

export async function buildKoshMeshGraph(identity: KoshMeshIdentity) {
  await Promise.all([
    repositoryStore.ready(),
    meshStore.ready(),
    platformStore.ready()
  ]);

  const [allRepositories, allComponents, links] = await Promise.all([
    repositoryStore.list(),
    meshStore.listNodes(),
    meshStore.listLinks()
  ]);

  const repositories = [];
  for (const repository of allRepositories) {
    const access = await evaluateKoshRepositoryAccess(
      identity,
      repository,
      "repository.read"
    );
    if (access.allowed) repositories.push(repository);
  }

  const visibleNamespaces = new Set(
    repositories.map((repository) => repository.namespace)
  );
  const components = allComponents.filter((component) =>
    visibleNamespaces.has(component.namespace)
  );

  const nodes: MeshNode[] = [];
  const graphLinks: MeshLink[] = links.map((link) => ({
    id: link.id,
    sourceRef: link.sourceRef,
    targetRef: link.targetRef,
    relation: link.relation,
    note: link.note,
    origin: "manual"
  }));

  for (const repository of repositories) {
    let flowState = "neutral";
    let flowSummary: Record<string, unknown> = {};
    try {
      const flow = await buildKoshFlowGraph(repository);
      flowState = flow.state;
      flowSummary = flow.summary;
    } catch {
      flowState = repository.state === "error" ? "failed" : "neutral";
    }

    nodes.push({
      ref: repositoryRef(repository.namespace, repository.slug),
      kind: "repository",
      type: "repository",
      namespace: repository.namespace,
      key: repository.slug,
      name: repository.name,
      description: repository.description,
      state: flowState,
      health: healthFromFlow(flowState),
      href:
        "/apps/kosh/flow?namespace=" +
        encodeURIComponent(repository.namespace) +
        "&slug=" +
        encodeURIComponent(repository.slug),
      url: null,
      updatedAt: repository.updatedAt,
      metadata: {
        repositoryId: repository.id,
        visibility: repository.visibility,
        defaultBranch: repository.defaultBranch,
        repositoryState: repository.state,
        flow: flowSummary
      }
    });
  }

  for (const component of components) {
    const ref = componentRef(component.id);
    nodes.push({
      ref,
      kind: "component",
      type: component.type,
      namespace: component.namespace,
      key: component.key,
      name: component.name,
      description: component.description,
      state: component.state,
      health: healthFromState(component.state),
      href: "/apps/kosh/mesh?focus=" + encodeURIComponent(ref),
      url: component.url,
      updatedAt: component.updatedAt,
      metadata: component.metadata
    });

    const repository = clean(component.metadata.repository, 240);
    if (repository) {
      const target = "repo:" + repository;
      if (
        nodes.some((node) => node.ref === target) &&
        !graphLinks.some(
          (link) =>
            link.sourceRef === ref &&
            link.targetRef === target &&
            link.relation === "uses"
        )
      ) {
        graphLinks.push({
          id: "derived:repository:" + component.id,
          sourceRef: ref,
          targetRef: target,
          relation: "uses",
          note: "Derived from component repository metadata.",
          origin: "derived"
        });
      }
    }
  }

  const validRefs = new Set(nodes.map((node) => node.ref));
  const visibleLinks = graphLinks.filter(
    (link) => validRefs.has(link.sourceRef) && validRefs.has(link.targetRef)
  );

  const counts = {
    repositories: nodes.filter((node) => node.kind === "repository").length,
    components: nodes.filter((node) => node.kind === "component").length,
    links: visibleLinks.length,
    good: nodes.filter((node) => node.health === "good").length,
    attention: nodes.filter((node) => node.health === "attention").length,
    blocked: nodes.filter((node) => node.health === "blocked").length,
    failed: nodes.filter((node) => node.health === "failed").length
  };

  return {
    state:
      counts.failed > 0
        ? "failed"
        : counts.blocked > 0
          ? "blocked"
          : counts.attention > 0
            ? "moving"
            : "stable",
    counts,
    nodes,
    links: visibleLinks
  };
}

export function calculateKoshMeshImpact(
  graph: Awaited<ReturnType<typeof buildKoshMeshGraph>>,
  ref: string
) {
  const nodeMap = new Map(graph.nodes.map((node) => [node.ref, node]));
  if (!nodeMap.has(ref)) {
    throw Object.assign(new Error("mesh_node_not_found"), { status: 404 });
  }

  function walk(direction: "upstream" | "downstream") {
    const seen = new Set<string>([ref]);
    const queue: Array<{ ref: string; depth: number }> = [{ ref, depth: 0 }];
    const results: Array<{
      ref: string;
      depth: number;
      relation: string;
      via: string;
      node: MeshNode;
    }> = [];

    while (queue.length) {
      const current = queue.shift()!;
      if (current.depth >= 8) continue;

      const nextLinks = graph.links.filter((link) =>
        direction === "downstream"
          ? link.sourceRef === current.ref
          : link.targetRef === current.ref
      );

      for (const link of nextLinks) {
        const nextRef =
          direction === "downstream" ? link.targetRef : link.sourceRef;
        if (seen.has(nextRef)) continue;
        const node = nodeMap.get(nextRef);
        if (!node) continue;
        seen.add(nextRef);
        results.push({
          ref: nextRef,
          depth: current.depth + 1,
          relation: link.relation,
          via: link.id,
          node
        });
        queue.push({ ref: nextRef, depth: current.depth + 1 });
      }
    }

    return results;
  }

  return {
    focus: nodeMap.get(ref)!,
    upstream: walk("upstream"),
    downstream: walk("downstream")
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
    { error: error instanceof Error ? error.message : "kosh_mesh_error" },
    origin,
    allowedOrigins
  );
}

export async function handleKoshMeshRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/kosh/mesh")) return false;

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
    await meshStore.ready();

    if (
      request.method === "GET" &&
      (url.pathname === "/v1/kosh/mesh" ||
        url.pathname === "/v1/kosh/mesh/graph")
    ) {
      sendJson(
        response,
        200,
        await buildKoshMeshGraph(),
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      request.method === "GET" &&
      url.pathname === "/v1/kosh/mesh/impact"
    ) {
      const ref = clean(url.searchParams.get("ref"), 300);
      if (!ref) {
        throw Object.assign(new Error("mesh_ref_required"), { status: 400 });
      }
      const graph = await buildKoshMeshGraph();
      sendJson(
        response,
        200,
        calculateKoshMeshImpact(graph, ref),
        origin,
        allowedOrigins
      );
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/kosh/mesh/nodes"
    ) {
      const body = await readJson(request);
      const type = clean(body.type, 40) as KoshMeshNodeType;
      const namespace = clean(body.namespace, 64);
      const key = clean(body.key, 160);
      const name = clean(body.name, 240);

      if (!nodeTypes.has(type) || !namespace || !key || !name) {
        throw Object.assign(new Error("invalid_mesh_node"), { status: 400 });
      }

      const node = await meshStore.createNode({
        namespace,
        key,
        type,
        name,
        description: clean(body.description, 1000),
        state: clean(body.state, 80) || "active",
        url: clean(body.url, 1000) || null,
        metadata:
          body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
            ? body.metadata as Record<string, unknown>
            : {},
        createdByUserId: identity.user.id,
        createdByName: identity.user.displayName
      });

      await platformStore.appendAudit({
        repositoryId: null,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "mesh_node_created",
        resourceType: "mesh_node",
        resourceId: node.id,
        metadata: { namespace, key, type }
      });

      sendJson(response, 201, node, origin, allowedOrigins);
      return true;
    }

    const nodeMatch = url.pathname.match(/^\/v1\/kosh\/mesh\/nodes\/([^/]+)$/);
    if (nodeMatch && request.method === "DELETE") {
      const id = decodeURIComponent(nodeMatch[1]);
      const deleted = await meshStore.deleteNode(id);
      if (!deleted) {
        throw Object.assign(new Error("mesh_node_not_found"), { status: 404 });
      }
      sendJson(response, 200, { deleted: true }, origin, allowedOrigins);
      return true;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/v1/kosh/mesh/links"
    ) {
      const body = await readJson(request);
      const relation = clean(body.relation, 40) as KoshMeshRelation;
      const sourceRef = clean(body.sourceRef, 300);
      const targetRef = clean(body.targetRef, 300);

      if (
        !relations.has(relation) ||
        !sourceRef ||
        !targetRef ||
        sourceRef === targetRef
      ) {
        throw Object.assign(new Error("invalid_mesh_link"), { status: 400 });
      }

      const graph = await buildKoshMeshGraph();
      const refs = new Set(graph.nodes.map((node) => node.ref));
      if (!refs.has(sourceRef) || !refs.has(targetRef)) {
        throw Object.assign(new Error("mesh_link_node_not_found"), { status: 404 });
      }

      const link = await meshStore.createLink({
        sourceRef,
        targetRef,
        relation,
        note: clean(body.note, 500),
        createdByUserId: identity.user.id,
        createdByName: identity.user.displayName
      });

      await platformStore.appendAudit({
        repositoryId: null,
        actorUserId: identity.user.id,
        actorName: identity.user.displayName,
        eventType: "mesh_link_created",
        resourceType: "mesh_link",
        resourceId: link.id,
        metadata: { sourceRef, targetRef, relation }
      });

      sendJson(response, 201, link, origin, allowedOrigins);
      return true;
    }

    const linkMatch = url.pathname.match(/^\/v1\/kosh\/mesh\/links\/([^/]+)$/);
    if (linkMatch && request.method === "DELETE") {
      const id = decodeURIComponent(linkMatch[1]);
      const deleted = await meshStore.deleteLink(id);
      if (!deleted) {
        throw Object.assign(new Error("mesh_link_not_found"), { status: 404 });
      }
      sendJson(response, 200, { deleted: true }, origin, allowedOrigins);
      return true;
    }

    sendJson(
      response,
      404,
      { error: "kosh_mesh_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
