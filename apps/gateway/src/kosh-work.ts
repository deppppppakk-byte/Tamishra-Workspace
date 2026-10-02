import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveKoshIdentity } from "./kosh-auth.js";
import { getKoshStore } from "./kosh-store.js";
import {
  getKoshWorkStore,
  type KoshBoardColumn,
  type KoshDiscussionState,
  type KoshIssueState,
  type StoredKoshIssue
} from "./kosh-work-store.js";

const repositoryStore = getKoshStore();
const workStore = getKoshWorkStore();

type JsonBody = Record<string, unknown>;

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 256 * 1024
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
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function cleanColor(value: unknown) {
  const color = clean(value, 7).replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(color)) {
    throw Object.assign(new Error("invalid_label_color"), { status: 400 });
  }
  return color.toUpperCase();
}

async function requireIdentity(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
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
    return null;
  }
  return identity;
}

async function repositoryContext(namespace: string, slug: string) {
  const repository = await repositoryStore.get(namespace, slug);
  if (!repository) {
    throw Object.assign(new Error("repository_not_found"), { status: 404 });
  }
  return repository;
}

async function activity(
  repositoryId: string,
  entityType: string,
  entityId: string,
  entityNumber: number | null,
  eventType: string,
  actor: { id: string; displayName: string },
  payload: Record<string, unknown> = {}
) {
  return workStore.createActivity({
    repositoryId,
    entityType,
    entityId,
    entityNumber,
    eventType,
    actorUserId: actor.id,
    actorName: actor.displayName,
    payload
  });
}

function issueHref(namespace: string, slug: string, number: number) {
  return (
    "/apps/kosh/work?namespace=" +
    encodeURIComponent(namespace) +
    "&slug=" +
    encodeURIComponent(slug) +
    "&issue=" +
    number
  );
}

async function notifyIssueStakeholders(
  issue: StoredKoshIssue,
  actorUserId: string,
  title: string,
  body: string
) {
  const recipients = new Set<string>();
  if (issue.authorUserId && issue.authorUserId !== actorUserId) {
    recipients.add(issue.authorUserId);
  }
  if (issue.assigneeUserId && issue.assigneeUserId !== actorUserId) {
    recipients.add(issue.assigneeUserId);
  }

  for (const userId of recipients) {
    await workStore.createNotification({
      userId,
      repositoryId: issue.repositoryId,
      title,
      body,
      href: issueHref(issue.namespace, issue.slug, issue.number)
    });
  }
}

function issueNumberFromTail(tail: string) {
  const match = tail.match(/^\/issues\/(\d+)/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function discussionNumberFromTail(tail: string) {
  const match = tail.match(/^\/discussions\/(\d+)/);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
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
        error instanceof Error
          ? error.message
          : "kosh_work_management_error"
    },
    origin,
    allowedOrigins
  );
}

export async function handleKoshWorkRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const match = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/work(.*)$/
  );

  if (!match) return false;

  const namespace = match[1];
  const slug = match[2];
  const tail = match[3] || "";

  const identity = await requireIdentity(
    request,
    response,
    origin,
    allowedOrigins
  );
  if (!identity) return true;

  try {
    await workStore.ready();
    const repository = await repositoryContext(namespace, slug);

    if (request.method === "GET" && (tail === "" || tail === "/summary")) {
      const [
        issues,
        labels,
        milestones,
        discussions,
        boards,
        templates,
        activityItems,
        notifications
      ] = await Promise.all([
        workStore.listIssues(repository.id),
        workStore.listLabels(repository.id),
        workStore.listMilestones(repository.id),
        workStore.listDiscussions(repository.id),
        workStore.listBoards(repository.id),
        workStore.listTemplates(repository.id),
        workStore.listActivity(repository.id, 50),
        workStore.listNotifications(identity.user.id, repository.id)
      ]);

      sendJson(
        response,
        200,
        {
          repository,
          counts: {
            openIssues: issues.filter((item) => item.state === "open").length,
            closedIssues: issues.filter((item) => item.state === "closed").length,
            discussions: discussions.length,
            boards: boards.length,
            unreadNotifications: notifications.filter((item) => !item.readAt).length
          },
          issues,
          labels,
          milestones,
          discussions,
          boards,
          templates,
          activity: activityItems,
          notifications
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/issues" && request.method === "GET") {
      const issues = await workStore.listIssues(repository.id);
      const enriched = await Promise.all(
        issues.map(async (issue) => ({
          ...issue,
          labels: await workStore.getIssueLabels(issue.id)
        }))
      );
      sendJson(response, 200, { issues: enriched }, origin, allowedOrigins);
      return true;
    }

    if (tail === "/issues" && request.method === "POST") {
      const body = await readJson(request);
      const title = clean(body.title, 200);
      const issueBody = clean(body.body, 30_000);

      if (!title) {
        throw Object.assign(new Error("issue_title_required"), { status: 400 });
      }

      let milestoneId = clean(body.milestoneId, 100) || null;
      if (milestoneId) {
        const allowed = (await workStore.listMilestones(repository.id))
          .some((item) => item.id === milestoneId);
        if (!allowed) {
          throw Object.assign(new Error("milestone_not_found"), { status: 404 });
        }
      }

      const assignToMe = body.assignToMe === true;
      const issue = await workStore.createIssue({
        repositoryId: repository.id,
        namespace,
        slug,
        title,
        body: issueBody,
        authorUserId: identity.user.id,
        authorName: identity.user.displayName,
        milestoneId,
        assigneeUserId: assignToMe ? identity.user.id : null,
        assigneeName: assignToMe ? identity.user.displayName : null
      });

      const requestedLabels = Array.isArray(body.labelIds)
        ? body.labelIds.map(String).slice(0, 50)
        : [];
      const allowedLabels = await workStore.listLabels(repository.id);
      const allowedIds = new Set(allowedLabels.map((item) => item.id));
      const labels = await workStore.replaceIssueLabels(
        issue.id,
        requestedLabels.filter((id) => allowedIds.has(id))
      );

      await activity(
        repository.id,
        "issue",
        issue.id,
        issue.number,
        "issue_created",
        identity.user,
        { title: issue.title }
      );

      sendJson(
        response,
        201,
        { issue, labels },
        origin,
        allowedOrigins
      );
      return true;
    }

    const issueNumber = issueNumberFromTail(tail);
    if (issueNumber) {
      const issue = await workStore.getIssue(repository.id, issueNumber);
      if (!issue) {
        throw Object.assign(new Error("issue_not_found"), { status: 404 });
      }

      if (tail === "/issues/" + issueNumber && request.method === "GET") {
        const [labels, comments, dependencies, links] = await Promise.all([
          workStore.getIssueLabels(issue.id),
          workStore.listIssueComments(issue.id),
          workStore.listDependencies(issue.id),
          workStore.listIssueLinks(issue.id)
        ]);

        sendJson(
          response,
          200,
          { issue, labels, comments, dependencies, links },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (tail === "/issues/" + issueNumber && request.method === "PATCH") {
        const body = await readJson(request);
        const nextState =
          body.state === "open" || body.state === "closed"
            ? body.state as KoshIssueState
            : undefined;

        let milestoneId: string | null | undefined = undefined;
        if ("milestoneId" in body) {
          milestoneId = clean(body.milestoneId, 100) || null;
          if (milestoneId) {
            const allowed = (await workStore.listMilestones(repository.id))
              .some((item) => item.id === milestoneId);
            if (!allowed) {
              throw Object.assign(new Error("milestone_not_found"), { status: 404 });
            }
          }
        }

        let assigneeUserId: string | null | undefined = undefined;
        let assigneeName: string | null | undefined = undefined;
        if (body.assignToMe === true) {
          assigneeUserId = identity.user.id;
          assigneeName = identity.user.displayName;
        } else if (body.unassign === true) {
          assigneeUserId = null;
          assigneeName = null;
        }

        const updated = await workStore.updateIssue(
          repository.id,
          issueNumber,
          {
            title:
              "title" in body ? clean(body.title, 200) || issue.title : undefined,
            body:
              "body" in body ? clean(body.body, 30_000) : undefined,
            state: nextState,
            milestoneId,
            assigneeUserId,
            assigneeName,
            actorUserId: identity.user.id,
            actorName: identity.user.displayName
          }
        );

        if (!updated) {
          throw Object.assign(new Error("issue_not_found"), { status: 404 });
        }

        await activity(
          repository.id,
          "issue",
          issue.id,
          issue.number,
          nextState && nextState !== issue.state
            ? nextState === "closed"
              ? "issue_closed"
              : "issue_reopened"
            : "issue_updated",
          identity.user,
          { title: updated.title }
        );

        await notifyIssueStakeholders(
          updated,
          identity.user.id,
          "Issue #" + updated.number + " updated",
          updated.title
        );

        sendJson(response, 200, updated, origin, allowedOrigins);
        return true;
      }

      if (
        tail === "/issues/" + issueNumber + "/comments" &&
        request.method === "GET"
      ) {
        sendJson(
          response,
          200,
          { comments: await workStore.listIssueComments(issue.id) },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (
        tail === "/issues/" + issueNumber + "/comments" &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        const commentBody = clean(body.body, 20_000);
        if (!commentBody) {
          throw Object.assign(new Error("comment_body_required"), { status: 400 });
        }

        const comment = await workStore.createIssueComment({
          issueId: issue.id,
          authorUserId: identity.user.id,
          authorName: identity.user.displayName,
          body: commentBody
        });

        await activity(
          repository.id,
          "issue",
          issue.id,
          issue.number,
          "issue_comment_added",
          identity.user,
          { commentId: comment.id }
        );

        await notifyIssueStakeholders(
          issue,
          identity.user.id,
          "New comment on issue #" + issue.number,
          issue.title
        );

        sendJson(response, 201, comment, origin, allowedOrigins);
        return true;
      }

      if (
        tail === "/issues/" + issueNumber + "/labels" &&
        request.method === "PUT"
      ) {
        const body = await readJson(request);
        const requested = Array.isArray(body.labelIds)
          ? body.labelIds.map(String).slice(0, 50)
          : [];
        const allowed = await workStore.listLabels(repository.id);
        const allowedIds = new Set(allowed.map((item) => item.id));
        const labels = await workStore.replaceIssueLabels(
          issue.id,
          requested.filter((id) => allowedIds.has(id))
        );

        await activity(
          repository.id,
          "issue",
          issue.id,
          issue.number,
          "issue_labels_changed",
          identity.user,
          { labels: labels.map((item) => item.name) }
        );

        sendJson(response, 200, { labels }, origin, allowedOrigins);
        return true;
      }

      if (
        tail === "/issues/" + issueNumber + "/dependencies" &&
        request.method === "GET"
      ) {
        sendJson(
          response,
          200,
          { dependencies: await workStore.listDependencies(issue.id) },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (
        tail === "/issues/" + issueNumber + "/dependencies" &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        const dependsOnNumber = Number(body.issueNumber);
        if (!Number.isInteger(dependsOnNumber) || dependsOnNumber < 1) {
          throw Object.assign(new Error("valid_dependency_issue_required"), {
            status: 400
          });
        }

        const target = await workStore.getIssue(repository.id, dependsOnNumber);
        if (!target) {
          throw Object.assign(new Error("dependency_issue_not_found"), {
            status: 404
          });
        }

        const dependency = await workStore.createDependency({
          issueId: issue.id,
          dependsOnIssueId: target.id,
          createdByUserId: identity.user.id
        });

        await activity(
          repository.id,
          "issue",
          issue.id,
          issue.number,
          "issue_dependency_added",
          identity.user,
          { dependsOn: dependsOnNumber }
        );

        sendJson(response, 201, dependency, origin, allowedOrigins);
        return true;
      }

      const dependencyDelete = tail.match(
        new RegExp("^/issues/" + issueNumber + "/dependencies/(\\d+)$")
      );
      if (dependencyDelete && request.method === "DELETE") {
        const dependsOnNumber = Number(dependencyDelete[1]);
        const target = await workStore.getIssue(repository.id, dependsOnNumber);
        if (!target) {
          throw Object.assign(new Error("dependency_issue_not_found"), {
            status: 404
          });
        }

        const deleted = await workStore.deleteDependency(issue.id, target.id);
        if (!deleted) {
          throw Object.assign(new Error("dependency_not_found"), { status: 404 });
        }

        await activity(
          repository.id,
          "issue",
          issue.id,
          issue.number,
          "issue_dependency_removed",
          identity.user,
          { dependsOn: dependsOnNumber }
        );

        sendJson(response, 200, { deleted: true }, origin, allowedOrigins);
        return true;
      }

      if (
        tail === "/issues/" + issueNumber + "/links" &&
        request.method === "GET"
      ) {
        sendJson(
          response,
          200,
          { links: await workStore.listIssueLinks(issue.id) },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (
        tail === "/issues/" + issueNumber + "/links" &&
        request.method === "POST"
      ) {
        const body = await readJson(request);
        const linkType =
          body.linkType === "commit" || body.linkType === "change_request"
            ? body.linkType
            : null;
        const refValue = clean(body.refValue, 200);
        const title = clean(body.title, 300) || null;

        if (!linkType || !refValue) {
          throw Object.assign(new Error("valid_issue_link_required"), {
            status: 400
          });
        }

        const link = await workStore.createIssueLink({
          issueId: issue.id,
          linkType,
          refValue,
          title,
          createdByUserId: identity.user.id
        });

        await activity(
          repository.id,
          "issue",
          issue.id,
          issue.number,
          "issue_link_added",
          identity.user,
          { linkType, refValue }
        );

        sendJson(response, 201, link, origin, allowedOrigins);
        return true;
      }
    }

    if (tail === "/labels" && request.method === "GET") {
      sendJson(
        response,
        200,
        { labels: await workStore.listLabels(repository.id) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/labels" && request.method === "POST") {
      const body = await readJson(request);
      const name = clean(body.name, 60);
      if (!name) {
        throw Object.assign(new Error("label_name_required"), { status: 400 });
      }

      const label = await workStore.createLabel({
        repositoryId: repository.id,
        name,
        description: clean(body.description, 300),
        color: cleanColor(body.color || "667085")
      });

      await activity(
        repository.id,
        "label",
        label.id,
        null,
        "label_created",
        identity.user,
        { name: label.name }
      );

      sendJson(response, 201, label, origin, allowedOrigins);
      return true;
    }

    if (tail === "/milestones" && request.method === "GET") {
      sendJson(
        response,
        200,
        { milestones: await workStore.listMilestones(repository.id) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/milestones" && request.method === "POST") {
      const body = await readJson(request);
      const title = clean(body.title, 120);
      if (!title) {
        throw Object.assign(new Error("milestone_title_required"), { status: 400 });
      }

      let dueAt: string | null = null;
      if (body.dueAt) {
        const date = new Date(String(body.dueAt));
        if (Number.isNaN(date.getTime())) {
          throw Object.assign(new Error("invalid_milestone_due_date"), {
            status: 400
          });
        }
        dueAt = date.toISOString();
      }

      const milestone = await workStore.createMilestone({
        repositoryId: repository.id,
        title,
        description: clean(body.description, 1000),
        dueAt
      });

      await activity(
        repository.id,
        "milestone",
        milestone.id,
        null,
        "milestone_created",
        identity.user,
        { title: milestone.title }
      );

      sendJson(response, 201, milestone, origin, allowedOrigins);
      return true;
    }

    if (tail === "/discussions" && request.method === "GET") {
      sendJson(
        response,
        200,
        { discussions: await workStore.listDiscussions(repository.id) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/discussions" && request.method === "POST") {
      const body = await readJson(request);
      const title = clean(body.title, 200);
      const discussionBody = clean(body.body, 30_000);
      if (!title || !discussionBody) {
        throw Object.assign(new Error("discussion_title_and_body_required"), {
          status: 400
        });
      }

      const discussion = await workStore.createDiscussion({
        repositoryId: repository.id,
        namespace,
        slug,
        title,
        body: discussionBody,
        category: clean(body.category, 40) || "general",
        authorUserId: identity.user.id,
        authorName: identity.user.displayName
      });

      await activity(
        repository.id,
        "discussion",
        discussion.id,
        discussion.number,
        "discussion_created",
        identity.user,
        { title: discussion.title }
      );

      sendJson(response, 201, discussion, origin, allowedOrigins);
      return true;
    }

    const discussionNumber = discussionNumberFromTail(tail);
    if (discussionNumber) {
      const discussion = await workStore.getDiscussion(
        repository.id,
        discussionNumber
      );
      if (!discussion) {
        throw Object.assign(new Error("discussion_not_found"), { status: 404 });
      }

      if (
        tail === "/discussions/" + discussionNumber &&
        request.method === "GET"
      ) {
        sendJson(
          response,
          200,
          {
            discussion,
            replies: await workStore.listDiscussionReplies(discussion.id)
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      if (
        tail === "/discussions/" + discussionNumber &&
        request.method === "PATCH"
      ) {
        const body = await readJson(request);
        const state =
          body.state === "open" || body.state === "locked"
            ? body.state as KoshDiscussionState
            : null;

        if (!state) {
          throw Object.assign(new Error("invalid_discussion_state"), {
            status: 400
          });
        }

        const updated = await workStore.updateDiscussionState(
          repository.id,
          discussionNumber,
          state
        );

        await activity(
          repository.id,
          "discussion",
          discussion.id,
          discussion.number,
          state === "locked"
            ? "discussion_locked"
            : "discussion_reopened",
          identity.user
        );

        sendJson(response, 200, updated, origin, allowedOrigins);
        return true;
      }

      if (
        tail === "/discussions/" + discussionNumber + "/replies" &&
        request.method === "POST"
      ) {
        if (discussion.state === "locked") {
          throw Object.assign(new Error("discussion_locked"), { status: 409 });
        }

        const body = await readJson(request);
        const replyBody = clean(body.body, 20_000);
        if (!replyBody) {
          throw Object.assign(new Error("reply_body_required"), { status: 400 });
        }

        const reply = await workStore.createDiscussionReply({
          discussionId: discussion.id,
          authorUserId: identity.user.id,
          authorName: identity.user.displayName,
          body: replyBody
        });

        await activity(
          repository.id,
          "discussion",
          discussion.id,
          discussion.number,
          "discussion_reply_added",
          identity.user,
          { replyId: reply.id }
        );

        sendJson(response, 201, reply, origin, allowedOrigins);
        return true;
      }
    }

    if (tail === "/boards" && request.method === "GET") {
      const boards = await workStore.listBoards(repository.id);
      const enriched = await Promise.all(
        boards.map(async (board) => ({
          ...board,
          cards: await workStore.listBoardCards(board.id)
        }))
      );
      sendJson(response, 200, { boards: enriched }, origin, allowedOrigins);
      return true;
    }

    if (tail === "/boards" && request.method === "POST") {
      const body = await readJson(request);
      const name = clean(body.name, 100);
      if (!name) {
        throw Object.assign(new Error("board_name_required"), { status: 400 });
      }

      const board = await workStore.createBoard({
        repositoryId: repository.id,
        name,
        description: clean(body.description, 1000)
      });

      await activity(
        repository.id,
        "board",
        board.id,
        null,
        "board_created",
        identity.user,
        { name: board.name }
      );

      sendJson(response, 201, board, origin, allowedOrigins);
      return true;
    }

    const boardMatch = tail.match(/^\/boards\/([^/]+)$/);
    if (boardMatch && request.method === "GET") {
      const boardId = decodeURIComponent(boardMatch[1]);
      const board = (await workStore.listBoards(repository.id))
        .find((item) => item.id === boardId);
      if (!board) {
        throw Object.assign(new Error("board_not_found"), { status: 404 });
      }

      sendJson(
        response,
        200,
        { board, cards: await workStore.listBoardCards(board.id) },
        origin,
        allowedOrigins
      );
      return true;
    }

    const boardCardsMatch = tail.match(/^\/boards\/([^/]+)\/cards$/);
    if (boardCardsMatch && request.method === "PUT") {
      const boardId = decodeURIComponent(boardCardsMatch[1]);
      const board = (await workStore.listBoards(repository.id))
        .find((item) => item.id === boardId);
      if (!board) {
        throw Object.assign(new Error("board_not_found"), { status: 404 });
      }

      const body = await readJson(request);
      const issueNumber = Number(body.issueNumber);
      const column =
        ["backlog", "ready", "in_progress", "in_review", "done"].includes(
          String(body.column)
        )
          ? String(body.column) as KoshBoardColumn
          : null;

      if (!Number.isInteger(issueNumber) || issueNumber < 1 || !column) {
        throw Object.assign(new Error("valid_board_card_required"), {
          status: 400
        });
      }

      const issue = await workStore.getIssue(repository.id, issueNumber);
      if (!issue) {
        throw Object.assign(new Error("issue_not_found"), { status: 404 });
      }

      const card = await workStore.putBoardCard({
        boardId,
        issueId: issue.id,
        column,
        position: Math.max(0, Number(body.position) || 0)
      });

      await activity(
        repository.id,
        "issue",
        issue.id,
        issue.number,
        "board_card_moved",
        identity.user,
        { boardId, column }
      );

      sendJson(response, 200, card, origin, allowedOrigins);
      return true;
    }

    if (boardCardsMatch && request.method === "DELETE") {
      const boardId = decodeURIComponent(boardCardsMatch[1]);
      const issueNumber = Number(url.searchParams.get("issue"));
      if (!Number.isInteger(issueNumber) || issueNumber < 1) {
        throw Object.assign(new Error("valid_issue_number_required"), {
          status: 400
        });
      }

      const issue = await workStore.getIssue(repository.id, issueNumber);
      if (!issue) {
        throw Object.assign(new Error("issue_not_found"), { status: 404 });
      }

      const deleted = await workStore.deleteBoardCard(boardId, issue.id);
      sendJson(response, 200, { deleted }, origin, allowedOrigins);
      return true;
    }

    if (tail === "/templates" && request.method === "GET") {
      sendJson(
        response,
        200,
        { templates: await workStore.listTemplates(repository.id) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/templates" && request.method === "POST") {
      const body = await readJson(request);
      const name = clean(body.name, 100);
      if (!name) {
        throw Object.assign(new Error("template_name_required"), { status: 400 });
      }

      const template = await workStore.createTemplate({
        repositoryId: repository.id,
        name,
        titleTemplate: clean(body.titleTemplate, 300),
        bodyTemplate: clean(body.bodyTemplate, 20_000),
        labelNames: Array.isArray(body.labelNames)
          ? body.labelNames.map((value) => clean(value, 60)).filter(Boolean).slice(0, 20)
          : []
      });

      await activity(
        repository.id,
        "template",
        template.id,
        null,
        "issue_template_created",
        identity.user,
        { name: template.name }
      );

      sendJson(response, 201, template, origin, allowedOrigins);
      return true;
    }

    if (tail === "/activity" && request.method === "GET") {
      const limit = Math.min(
        500,
        Math.max(1, Number(url.searchParams.get("limit")) || 100)
      );
      sendJson(
        response,
        200,
        { activity: await workStore.listActivity(repository.id, limit) },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (tail === "/notifications" && request.method === "GET") {
      sendJson(
        response,
        200,
        {
          notifications: await workStore.listNotifications(
            identity.user.id,
            repository.id
          )
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    const notificationRead = tail.match(/^\/notifications\/([^/]+)\/read$/);
    if (notificationRead && request.method === "POST") {
      const read = await workStore.markNotificationRead(
        decodeURIComponent(notificationRead[1]),
        identity.user.id
      );
      if (!read) {
        throw Object.assign(new Error("notification_not_found"), {
          status: 404
        });
      }
      sendJson(response, 200, { read: true }, origin, allowedOrigins);
      return true;
    }

    sendJson(
      response,
      404,
      { error: "kosh_work_route_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
