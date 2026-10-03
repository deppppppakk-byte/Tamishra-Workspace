import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import {
  getKoshPlatformStore,
  type StoredKoshPlatformResource
} from "./kosh-platform-store.js";
import { getKoshStore } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_HISTORY_RESULTS = 100;

type JsonBody = Record<string, unknown>;

class WikiError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
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
  limit = 384 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > limit) throw new WikiError("wiki_payload_too_large", 413);
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonBody)
      : {};
  } catch {
    throw new WikiError("invalid_json", 400);
  }
}

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function slugSegment(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeWikiPath(value: unknown, fallbackTitle = "") {
  const raw = clean(value, 700) || fallbackTitle;
  const parts = raw
    .replace(/\\/g, "/")
    .split("/")
    .map(slugSegment)
    .filter(Boolean);
  if (!parts.length || parts.length > 8) {
    throw new WikiError("invalid_wiki_path");
  }
  const path = parts.join("/");
  if (path.length > 320) throw new WikiError("invalid_wiki_path");
  return path;
}

function wikiContent(value: unknown) {
  const content = String(value ?? "").replace(/\r\n/g, "\n");
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw new WikiError("wiki_content_too_large", 413);
  }
  return content;
}

function tags(value: unknown) {
  if (!Array.isArray(value)) return [] as string[];
  return [...new Set(value.map((item) => clean(item, 40).toLowerCase()).filter(Boolean))].slice(0, 20);
}

function extractLinks(content: string) {
  const found = new Set<string>();
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    try {
      found.add(normalizeWikiPath(match[1]));
    } catch {
      // Invalid wiki links stay as plain text and are not indexed.
    }
    if (found.size >= 200) break;
  }
  return [...found];
}

function excerpt(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function isRevision(resource: StoredKoshPlatformResource) {
  return resource.state === "revision" && Boolean(resource.payload.pageId);
}

function isPage(resource: StoredKoshPlatformResource) {
  return resource.type === "wiki_page" && !isRevision(resource);
}

function pageSummary(resource: StoredKoshPlatformResource) {
  return {
    id: resource.id,
    path: String(resource.payload.path ?? resource.key.replace(/^page:/, "")),
    title: resource.name,
    state: resource.state,
    revision: Number(resource.payload.revision ?? 1),
    excerpt: String(resource.payload.excerpt ?? ""),
    tags: Array.isArray(resource.payload.tags) ? resource.payload.tags : [],
    links: Array.isArray(resource.payload.links) ? resource.payload.links : [],
    createdByName: resource.createdByName,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    updatedByName: String(resource.payload.updatedByName ?? resource.createdByName)
  };
}

function pageDetail(resource: StoredKoshPlatformResource) {
  return {
    ...pageSummary(resource),
    content: String(resource.payload.content ?? ""),
    format: "markdown" as const
  };
}

async function audit(
  repositoryId: string,
  actorUserId: string | null,
  actorName: string,
  eventType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {}
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId,
    actorName,
    eventType,
    resourceType: "wiki_page",
    resourceId,
    metadata
  });
}

async function allWikiResources(repositoryId: string) {
  return platformStore.listResources("wiki_page", repositoryId);
}

async function currentPages(repositoryId: string, includeArchived = false) {
  const resources = await allWikiResources(repositoryId);
  return resources
    .filter((item) => isPage(item) && (includeArchived || item.state !== "archived"))
    .sort((a, b) =>
      String(a.payload.path ?? a.key).localeCompare(String(b.payload.path ?? b.key))
    );
}

async function pageById(repositoryId: string, id: string) {
  const resource = await platformStore.getResource(id);
  return resource && resource.repositoryId === repositoryId && isPage(resource)
    ? resource
    : null;
}

async function createRevision(
  page: StoredKoshPlatformResource,
  revision: number,
  actor: { id: string; displayName: string },
  note: string
) {
  const path = String(page.payload.path ?? page.key.replace(/^page:/, ""));
  return platformStore.createResource({
    repositoryId: page.repositoryId,
    namespace: page.namespace,
    type: "wiki_page",
    key: "revision:" + page.id + ":" + revision,
    name: page.name + " · r" + revision,
    state: "revision",
    payload: {
      pageId: page.id,
      path,
      title: page.name,
      content: String(page.payload.content ?? ""),
      revision,
      tags: Array.isArray(page.payload.tags) ? page.payload.tags : [],
      links: Array.isArray(page.payload.links) ? page.payload.links : [],
      note,
      editorUserId: actor.id,
      editorName: actor.displayName
    },
    createdByUserId: actor.id,
    createdByName: actor.displayName
  });
}

export async function handleKoshWikiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const route = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/wiki(?:\/pages\/([a-f0-9-]{36}))?(?:\/(history|restore))?$/i
  );
  if (!route) return false;

  try {
    await platformStore.ready();
    const namespace = route[1];
    const slug = route[2];
    const pageId = route[3] || "";
    const action = route[4] || "";
    const repository = await repositoryStore.get(namespace, slug);
    if (!repository) throw new WikiError("repository_not_found", 404);

    const write = request.method !== "GET";
    const authorization = await authorizeKoshRepositoryRequest(
      request,
      repository,
      write ? "repository.write" : "repository.read"
    );
    if (!authorization.decision.allowed || (write && !authorization.identity)) {
      sendJson(
        response,
        authorization.identity ? 403 : 401,
        {
          error: authorization.identity
            ? "repository_permission_denied"
            : "authentication_required"
        },
        origin,
        allowedOrigins
      );
      return true;
    }
    if (write && origin && !allowedOrigins.has(origin)) {
      throw new WikiError("origin_not_allowed", 403);
    }

    if (!pageId && request.method === "GET") {
      const query = clean(url.searchParams.get("q"), 200).toLowerCase();
      const includeArchived = url.searchParams.get("archived") === "true";
      let pages = await currentPages(repository.id, includeArchived);
      if (query) {
        pages = pages.filter((item) => {
          const haystack = [
            item.name,
            String(item.payload.path ?? ""),
            String(item.payload.content ?? ""),
            ...(Array.isArray(item.payload.tags) ? item.payload.tags.map(String) : [])
          ].join("\n").toLowerCase();
          return haystack.includes(query);
        });
      }
      sendJson(
        response,
        200,
        {
          pages: pages.slice(0, 200).map(pageSummary),
          query,
          limits: { maxContentBytes: MAX_CONTENT_BYTES, maxPagesReturned: 200 }
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (!pageId && request.method === "POST") {
      const body = await readJson(request);
      const title = clean(body.title, 200);
      if (!title) throw new WikiError("wiki_title_required");
      const path = normalizeWikiPath(body.path, title);
      const content = wikiContent(body.content);
      const pageTags = tags(body.tags);
      const actor = authorization.identity!.user;
      const created = await platformStore.createResource({
        repositoryId: repository.id,
        namespace,
        type: "wiki_page",
        key: "page:" + path,
        name: title,
        state: "active",
        payload: {
          path,
          content,
          revision: 1,
          excerpt: excerpt(content),
          tags: pageTags,
          links: extractLinks(content),
          updatedByUserId: actor.id,
          updatedByName: actor.displayName
        },
        createdByUserId: actor.id,
        createdByName: actor.displayName
      });
      await createRevision(created, 1, actor, clean(body.note, 500) || "Created page");
      await audit(repository.id, actor.id, actor.displayName, "wiki_page_created", created.id, { path, revision: 1 });
      sendJson(response, 201, { page: pageDetail(created) }, origin, allowedOrigins);
      return true;
    }

    if (!pageId) return false;
    const page = await pageById(repository.id, pageId);
    if (!page) throw new WikiError("wiki_page_not_found", 404);

    if (action === "history" && request.method === "GET") {
      const resources = await allWikiResources(repository.id);
      const history = resources
        .filter((item) => isRevision(item) && item.payload.pageId === page.id)
        .sort((a, b) => Number(b.payload.revision ?? 0) - Number(a.payload.revision ?? 0))
        .slice(0, MAX_HISTORY_RESULTS)
        .map((item) => ({
          id: item.id,
          revision: Number(item.payload.revision ?? 0),
          title: String(item.payload.title ?? page.name),
          note: String(item.payload.note ?? ""),
          editorName: String(item.payload.editorName ?? item.createdByName),
          createdAt: item.createdAt
        }));
      sendJson(response, 200, { history }, origin, allowedOrigins);
      return true;
    }

    if (action === "restore" && request.method === "POST") {
      const body = await readJson(request, 32 * 1024);
      const revisionId = clean(body.revisionId, 80);
      const source = revisionId ? await platformStore.getResource(revisionId) : null;
      if (
        !source ||
        source.repositoryId !== repository.id ||
        !isRevision(source) ||
        source.payload.pageId !== page.id
      ) {
        throw new WikiError("wiki_revision_not_found", 404);
      }
      const actor = authorization.identity!.user;
      const nextRevision = Number(page.payload.revision ?? 1) + 1;
      const restoredContent = wikiContent(source.payload.content);
      const restoredTags = tags(source.payload.tags);
      const updated = await platformStore.updateResource(page.id, {
        state: "active",
        name: clean(source.payload.title, 200) || page.name,
        payload: {
          ...page.payload,
          content: restoredContent,
          revision: nextRevision,
          excerpt: excerpt(restoredContent),
          tags: restoredTags,
          links: extractLinks(restoredContent),
          updatedByUserId: actor.id,
          updatedByName: actor.displayName,
          restoredFromRevision: Number(source.payload.revision ?? 0)
        }
      });
      if (!updated) throw new WikiError("wiki_page_not_found", 404);
      await createRevision(
        updated,
        nextRevision,
        actor,
        "Restored from r" + Number(source.payload.revision ?? 0)
      );
      await audit(repository.id, actor.id, actor.displayName, "wiki_page_restored", page.id, {
        revision: nextRevision,
        restoredFrom: Number(source.payload.revision ?? 0)
      });
      sendJson(response, 200, { page: pageDetail(updated) }, origin, allowedOrigins);
      return true;
    }

    if (action) return false;

    if (request.method === "GET") {
      const pages = await currentPages(repository.id, true);
      const pagePath = String(page.payload.path ?? "");
      const backlinks = pages
        .filter(
          (candidate) =>
            candidate.id !== page.id &&
            Array.isArray(candidate.payload.links) &&
            candidate.payload.links.includes(pagePath)
        )
        .map(pageSummary);
      sendJson(
        response,
        200,
        { page: pageDetail(page), backlinks },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "PATCH") {
      const body = await readJson(request);
      const expectedRevision = Number(body.expectedRevision ?? page.payload.revision ?? 1);
      const currentRevision = Number(page.payload.revision ?? 1);
      if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) {
        throw new WikiError("wiki_revision_conflict", 409);
      }
      const title = body.title === undefined ? page.name : clean(body.title, 200);
      if (!title) throw new WikiError("wiki_title_required");
      const content = body.content === undefined
        ? String(page.payload.content ?? "")
        : wikiContent(body.content);
      const pageTags = body.tags === undefined ? tags(page.payload.tags) : tags(body.tags);
      const nextRevision = currentRevision + 1;
      const actor = authorization.identity!.user;
      const updated = await platformStore.updateResource(page.id, {
        name: title,
        state: "active",
        payload: {
          ...page.payload,
          content,
          revision: nextRevision,
          excerpt: excerpt(content),
          tags: pageTags,
          links: extractLinks(content),
          updatedByUserId: actor.id,
          updatedByName: actor.displayName
        }
      });
      if (!updated) throw new WikiError("wiki_page_not_found", 404);
      await createRevision(updated, nextRevision, actor, clean(body.note, 500) || "Updated page");
      await audit(repository.id, actor.id, actor.displayName, "wiki_page_updated", page.id, {
        path: String(page.payload.path ?? ""),
        revision: nextRevision
      });
      sendJson(response, 200, { page: pageDetail(updated) }, origin, allowedOrigins);
      return true;
    }

    if (request.method === "DELETE") {
      const actor = authorization.identity!.user;
      const updated = await platformStore.updateResource(page.id, { state: "archived" });
      if (!updated) throw new WikiError("wiki_page_not_found", 404);
      await audit(repository.id, actor.id, actor.displayName, "wiki_page_archived", page.id, {
        path: String(page.payload.path ?? "")
      });
      sendJson(response, 200, { archived: true, page: pageSummary(updated) }, origin, allowedOrigins);
      return true;
    }
  } catch (error) {
    const status =
      error instanceof WikiError
        ? error.status
        : Number((error as { status?: number })?.status ?? 500);
    sendJson(
      response,
      status,
      { error: error instanceof Error ? error.message : "wiki_request_failed" },
      origin,
      allowedOrigins
    );
    return true;
  }

  return false;
}
