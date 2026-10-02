"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./work.module.css";

type IssueState = "open" | "closed";
type BoardColumn = "backlog" | "ready" | "in_progress" | "in_review" | "done";

type Issue = {
  id: string;
  number: number;
  title: string;
  body: string;
  authorName: string;
  state: IssueState;
  milestoneId: string | null;
  milestoneTitle: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  createdAt: string;
  updatedAt: string;
};

type Label = {
  id: string;
  name: string;
  description: string;
  color: string;
};

type Milestone = {
  id: string;
  title: string;
  description: string;
  dueAt: string | null;
  state: "open" | "closed";
};

type IssueComment = {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
};

type Dependency = {
  dependsOnIssueId: string;
  dependsOnNumber: number;
  dependsOnTitle: string;
  dependsOnState: IssueState;
};

type IssueLink = {
  id: string;
  linkType: "change_request" | "commit";
  refValue: string;
  title: string | null;
};

type IssueDetail = {
  issue: Issue;
  labels: Label[];
  comments: IssueComment[];
  dependencies: Dependency[];
  links: IssueLink[];
};

type Discussion = {
  id: string;
  number: number;
  title: string;
  body: string;
  category: string;
  authorName: string;
  state: "open" | "locked";
  createdAt: string;
  updatedAt: string;
};

type DiscussionReply = {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
};

type BoardCard = {
  id: string;
  issueNumber: number;
  issueTitle: string;
  issueState: IssueState;
  column: BoardColumn;
  position: number;
};

type Board = {
  id: string;
  name: string;
  description: string;
  cards?: BoardCard[];
};

type Template = {
  id: string;
  name: string;
  titleTemplate: string;
  bodyTemplate: string;
  labelNames: string[];
};

type Activity = {
  id: string;
  entityType: string;
  entityNumber: number | null;
  eventType: string;
  actorName: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type Notification = {
  id: string;
  title: string;
  body: string;
  href: string;
  readAt: string | null;
  createdAt: string;
};

type Summary = {
  repository: {
    namespace: string;
    slug: string;
    name: string;
  };
  counts: {
    openIssues: number;
    closedIssues: number;
    discussions: number;
    boards: number;
    unreadNotifications: number;
  };
  issues: Issue[];
  labels: Label[];
  milestones: Milestone[];
  discussions: Discussion[];
  boards: Board[];
  templates: Template[];
  activity: Activity[];
  notifications: Notification[];
};

type Tab =
  | "issues"
  | "boards"
  | "discussions"
  | "planning"
  | "activity"
  | "notifications";

const boardColumns: Array<{ key: BoardColumn; title: string }> = [
  { key: "backlog", title: "Backlog" },
  { key: "ready", title: "Ready" },
  { key: "in_progress", title: "In progress" },
  { key: "in_review", title: "In review" },
  { key: "done", title: "Done" }
];

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

function eventLabel(eventType: string) {
  return eventType
    .replace(/^issue_/, "")
    .replace(/^discussion_/, "")
    .replace(/_/g, " ");
}

export function KoshWorkWorkspace() {
  const router = useRouter();
  const base = useMemo(apiBase, []);

  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [tab, setTab] = useState<Tab>("issues");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");

  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);
  const [issueDetail, setIssueDetail] = useState<IssueDetail | null>(null);
  const [issueComment, setIssueComment] = useState("");
  const [dependencyNumber, setDependencyNumber] = useState("");
  const [selectedIssueLabels, setSelectedIssueLabels] = useState<string[]>([]);

  const [issueCreateOpen, setIssueCreateOpen] = useState(false);
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [issueMilestone, setIssueMilestone] = useState("");
  const [issueLabels, setIssueLabels] = useState<string[]>([]);
  const [assignToMe, setAssignToMe] = useState(false);

  const [labelName, setLabelName] = useState("");
  const [labelColor, setLabelColor] = useState("667085");
  const [milestoneTitle, setMilestoneTitle] = useState("");
  const [milestoneDue, setMilestoneDue] = useState("");

  const [boardName, setBoardName] = useState("");
  const [boards, setBoards] = useState<Board[]>([]);
  const [activeBoardId, setActiveBoardId] = useState("");

  const [discussionTitle, setDiscussionTitle] = useState("");
  const [discussionBody, setDiscussionBody] = useState("");
  const [discussionCategory, setDiscussionCategory] = useState("general");
  const [selectedDiscussion, setSelectedDiscussion] = useState<number | null>(null);
  const [discussionDetail, setDiscussionDetail] = useState<{
    discussion: Discussion;
    replies: DiscussionReply[];
  } | null>(null);
  const [discussionReply, setDiscussionReply] = useState("");

  const [templateName, setTemplateName] = useState("");
  const [templateTitle, setTemplateTitle] = useState("");
  const [templateBody, setTemplateBody] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() ?? "");
    setSlug(params.get("slug")?.trim() ?? "");

    const issue = Number(params.get("issue") ?? 0);
    if (Number.isInteger(issue) && issue > 0) {
      setSelectedIssue(issue);
      setTab("issues");
    }
  }, []);

  const workBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug) +
      "/work"
    );
  }, [base, namespace, slug]);

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

  const mutate = useCallback(
    async <T,>(
      url: string,
      method: "POST" | "PUT" | "PATCH" | "DELETE",
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

  const loadSummary = useCallback(async () => {
    if (!workBase) return;
    setLoading(true);
    setError("");
    try {
      const payload = await fetchJson<Summary>(workBase + "/summary");
      setSummary(payload);
      if (!activeBoardId && payload.boards[0]) {
        setActiveBoardId(payload.boards[0].id);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Work.");
    } finally {
      setLoading(false);
    }
  }, [activeBoardId, fetchJson, workBase]);

  const loadBoards = useCallback(async () => {
    if (!workBase) return;
    const payload = await fetchJson<{ boards: Board[] }>(workBase + "/boards");
    setBoards(payload.boards);
    if (!activeBoardId && payload.boards[0]) setActiveBoardId(payload.boards[0].id);
  }, [activeBoardId, fetchJson, workBase]);

  const loadIssue = useCallback(
    async (number: number) => {
      if (!workBase) return;
      setError("");
      try {
        const detail = await fetchJson<IssueDetail>(
          workBase + "/issues/" + number
        );
        setIssueDetail(detail);
        setSelectedIssueLabels(detail.labels.map((label) => label.id));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not load issue.");
      }
    },
    [fetchJson, workBase]
  );

  const loadDiscussion = useCallback(
    async (number: number) => {
      if (!workBase) return;
      setError("");
      try {
        const detail = await fetchJson<{
          discussion: Discussion;
          replies: DiscussionReply[];
        }>(workBase + "/discussions/" + number);
        setDiscussionDetail(detail);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Could not load discussion.");
      }
    },
    [fetchJson, workBase]
  );

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (selectedIssue) void loadIssue(selectedIssue);
  }, [loadIssue, selectedIssue]);

  useEffect(() => {
    if (selectedDiscussion) void loadDiscussion(selectedDiscussion);
  }, [loadDiscussion, selectedDiscussion]);

  useEffect(() => {
    if (tab === "boards") void loadBoards();
  }, [loadBoards, tab]);

  function openIssue(number: number) {
    setSelectedIssue(number);
    setTab("issues");
    router.replace(
      "/apps/kosh/work?namespace=" +
        encodeURIComponent(namespace) +
        "&slug=" +
        encodeURIComponent(slug) +
        "&issue=" +
        number
    );
  }

  function closeIssueDetail() {
    setSelectedIssue(null);
    setIssueDetail(null);
    router.replace(
      "/apps/kosh/work?namespace=" +
        encodeURIComponent(namespace) +
        "&slug=" +
        encodeURIComponent(slug)
    );
  }

  function useTemplate(template: Template) {
    setIssueTitle(template.titleTemplate);
    setIssueBody(template.bodyTemplate);
    const names = new Set(template.labelNames.map((value) => value.toLowerCase()));
    setIssueLabels(
      (summary?.labels ?? [])
        .filter((label) => names.has(label.name.toLowerCase()))
        .map((label) => label.id)
    );
    setIssueCreateOpen(true);
    setTab("issues");
  }

  async function createIssue(event: FormEvent) {
    event.preventDefault();
    if (!workBase || !issueTitle.trim()) return;
    setMutating(true);
    setError("");
    try {
      const result = await mutate<{ issue: Issue }>(
        workBase + "/issues",
        "POST",
        {
          title: issueTitle.trim(),
          body: issueBody.trim(),
          milestoneId: issueMilestone || null,
          labelIds: issueLabels,
          assignToMe
        }
      );
      setIssueTitle("");
      setIssueBody("");
      setIssueMilestone("");
      setIssueLabels([]);
      setAssignToMe(false);
      setIssueCreateOpen(false);
      await loadSummary();
      openIssue(result.issue.number);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Issue creation failed.");
    } finally {
      setMutating(false);
    }
  }

  async function updateIssue(body: unknown) {
    if (!workBase || !selectedIssue) return;
    setMutating(true);
    setError("");
    try {
      await mutate(workBase + "/issues/" + selectedIssue, "PATCH", body);
      await Promise.all([loadIssue(selectedIssue), loadSummary()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Issue update failed.");
    } finally {
      setMutating(false);
    }
  }

  async function saveIssueLabels() {
    if (!workBase || !selectedIssue) return;
    setMutating(true);
    try {
      await mutate(
        workBase + "/issues/" + selectedIssue + "/labels",
        "PUT",
        { labelIds: selectedIssueLabels }
      );
      await loadIssue(selectedIssue);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update labels.");
    } finally {
      setMutating(false);
    }
  }

  async function addIssueComment() {
    if (!workBase || !selectedIssue || !issueComment.trim()) return;
    setMutating(true);
    try {
      await mutate(
        workBase + "/issues/" + selectedIssue + "/comments",
        "POST",
        { body: issueComment.trim() }
      );
      setIssueComment("");
      await loadIssue(selectedIssue);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add comment.");
    } finally {
      setMutating(false);
    }
  }

  async function addDependency() {
    if (!workBase || !selectedIssue || !dependencyNumber) return;
    setMutating(true);
    try {
      await mutate(
        workBase + "/issues/" + selectedIssue + "/dependencies",
        "POST",
        { issueNumber: Number(dependencyNumber) }
      );
      setDependencyNumber("");
      await loadIssue(selectedIssue);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add dependency.");
    } finally {
      setMutating(false);
    }
  }

  async function createLabel() {
    if (!workBase || !labelName.trim()) return;
    setMutating(true);
    try {
      await mutate(workBase + "/labels", "POST", {
        name: labelName.trim(),
        color: labelColor
      });
      setLabelName("");
      await loadSummary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create label.");
    } finally {
      setMutating(false);
    }
  }

  async function createMilestone() {
    if (!workBase || !milestoneTitle.trim()) return;
    setMutating(true);
    try {
      await mutate(workBase + "/milestones", "POST", {
        title: milestoneTitle.trim(),
        dueAt: milestoneDue || null
      });
      setMilestoneTitle("");
      setMilestoneDue("");
      await loadSummary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create milestone.");
    } finally {
      setMutating(false);
    }
  }

  async function createBoard() {
    if (!workBase || !boardName.trim()) return;
    setMutating(true);
    try {
      const board = await mutate<Board>(workBase + "/boards", "POST", {
        name: boardName.trim()
      });
      setBoardName("");
      setActiveBoardId(board.id);
      await Promise.all([loadSummary(), loadBoards()]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create board.");
    } finally {
      setMutating(false);
    }
  }

  async function moveCard(issueNumber: number, column: BoardColumn) {
    if (!workBase || !activeBoardId) return;
    setMutating(true);
    try {
      await mutate(
        workBase + "/boards/" + encodeURIComponent(activeBoardId) + "/cards",
        "PUT",
        { issueNumber, column, position: Date.now() }
      );
      await loadBoards();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not move card.");
    } finally {
      setMutating(false);
    }
  }

  async function createDiscussion() {
    if (!workBase || !discussionTitle.trim() || !discussionBody.trim()) return;
    setMutating(true);
    try {
      const discussion = await mutate<Discussion>(
        workBase + "/discussions",
        "POST",
        {
          title: discussionTitle.trim(),
          body: discussionBody.trim(),
          category: discussionCategory
        }
      );
      setDiscussionTitle("");
      setDiscussionBody("");
      await loadSummary();
      setSelectedDiscussion(discussion.number);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Discussion creation failed.");
    } finally {
      setMutating(false);
    }
  }

  async function addDiscussionReply() {
    if (!workBase || !selectedDiscussion || !discussionReply.trim()) return;
    setMutating(true);
    try {
      await mutate(
        workBase + "/discussions/" + selectedDiscussion + "/replies",
        "POST",
        { body: discussionReply.trim() }
      );
      setDiscussionReply("");
      await loadDiscussion(selectedDiscussion);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add reply.");
    } finally {
      setMutating(false);
    }
  }

  async function createTemplate() {
    if (!workBase || !templateName.trim()) return;
    setMutating(true);
    try {
      await mutate(workBase + "/templates", "POST", {
        name: templateName.trim(),
        titleTemplate: templateTitle,
        bodyTemplate: templateBody,
        labelNames: []
      });
      setTemplateName("");
      setTemplateTitle("");
      setTemplateBody("");
      await loadSummary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create template.");
    } finally {
      setMutating(false);
    }
  }

  async function markRead(notification: Notification) {
    if (!workBase || notification.readAt) return;
    try {
      await mutate(
        workBase +
          "/notifications/" +
          encodeURIComponent(notification.id) +
          "/read",
        "POST"
      );
      await loadSummary();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update notification.");
    }
  }

  if (loading && !summary) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Work</strong>
        <span>Loading project work…</span>
      </main>
    );
  }

  if (!summary) {
    return (
      <main className={styles.loading}>
        <strong>Work unavailable</strong>
        <span>{error || "Kosh could not open this repository work area."}</span>
        <Link href={repositoryHref}>Back to repository</Link>
      </main>
    );
  }

  const activeBoard =
    boards.find((board) => board.id === activeBoardId) ??
    boards[0] ??
    null;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH WORK</p>
          <h1>{summary.repository.name}</h1>
          <span>
            Issues, planning, discussions and project activity in one workspace.
          </span>
        </div>

        <div className={styles.headerStats}>
          <div>
            <strong>{summary.counts.openIssues}</strong>
            <span>open issues</span>
          </div>
          <div>
            <strong>{summary.counts.discussions}</strong>
            <span>discussions</span>
          </div>
          <div>
            <strong>{summary.counts.boards}</strong>
            <span>boards</span>
          </div>
          <div>
            <strong>{summary.counts.unreadNotifications}</strong>
            <span>unread</span>
          </div>
        </div>
      </header>

      <nav className={styles.tabs}>
        {(
          [
            ["issues", "Issues"],
            ["boards", "Boards"],
            ["discussions", "Discussions"],
            ["planning", "Planning"],
            ["activity", "Activity"],
            ["notifications", "Notifications"]
          ] as Array<[Tab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            className={tab === value ? styles.active : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        {tab === "issues" && (
          <div className={styles.issueLayout}>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <strong>Issues</strong>
                  <span>
                    {summary.counts.openIssues} open ·{" "}
                    {summary.counts.closedIssues} closed
                  </span>
                </div>
                <button
                  className={styles.primary}
                  onClick={() => setIssueCreateOpen((value) => !value)}
                >
                  + New issue
                </button>
              </div>

              {issueCreateOpen && (
                <form className={styles.createForm} onSubmit={createIssue}>
                  <label>
                    <span>Template</span>
                    <select
                      defaultValue=""
                      onChange={(event) => {
                        const template = summary.templates.find(
                          (item) => item.id === event.target.value
                        );
                        if (template) useTemplate(template);
                      }}
                    >
                      <option value="">Blank issue</option>
                      {summary.templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Title</span>
                    <input
                      value={issueTitle}
                      onChange={(event) => setIssueTitle(event.target.value)}
                      placeholder="What needs attention?"
                    />
                  </label>
                  <label className={styles.wide}>
                    <span>Description</span>
                    <textarea
                      value={issueBody}
                      onChange={(event) => setIssueBody(event.target.value)}
                      placeholder="Context, acceptance criteria, reproduction steps…"
                    />
                  </label>
                  <label>
                    <span>Milestone</span>
                    <select
                      value={issueMilestone}
                      onChange={(event) => setIssueMilestone(event.target.value)}
                    >
                      <option value="">No milestone</option>
                      {summary.milestones
                        .filter((item) => item.state === "open")
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    <span>Labels</span>
                    <select
                      multiple
                      value={issueLabels}
                      onChange={(event) =>
                        setIssueLabels(
                          [...event.target.selectedOptions].map(
                            (option) => option.value
                          )
                        )
                      }
                    >
                      {summary.labels.map((label) => (
                        <option key={label.id} value={label.id}>
                          {label.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={assignToMe}
                      onChange={(event) => setAssignToMe(event.target.checked)}
                    />
                    <span>Assign to me</span>
                  </label>
                  <div className={styles.formActions}>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => setIssueCreateOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className={styles.primary}
                      disabled={mutating || !issueTitle.trim()}
                    >
                      Create issue
                    </button>
                  </div>
                </form>
              )}

              <div className={styles.issueList}>
                {summary.issues.map((issue) => (
                  <button
                    key={issue.id}
                    className={
                      selectedIssue === issue.number
                        ? styles.selectedRow
                        : styles.issueRow
                    }
                    onClick={() => openIssue(issue.number)}
                  >
                    <span
                      className={
                        issue.state === "open"
                          ? styles.openDot
                          : styles.closedDot
                      }
                    />
                    <div>
                      <strong>
                        #{issue.number} {issue.title}
                      </strong>
                      <span>
                        {issue.authorName} · {age(issue.updatedAt)}
                        {issue.milestoneTitle
                          ? " · " + issue.milestoneTitle
                          : ""}
                        {issue.assigneeName
                          ? " · assigned to " + issue.assigneeName
                          : ""}
                      </span>
                    </div>
                    <em>{issue.state}</em>
                  </button>
                ))}
                {!summary.issues.length && (
                  <div className={styles.empty}>No issues yet.</div>
                )}
              </div>
            </section>

            <aside className={styles.detailPanel}>
              {issueDetail ? (
                <>
                  <div className={styles.detailHeader}>
                    <div>
                      <span>ISSUE #{issueDetail.issue.number}</span>
                      <strong>{issueDetail.issue.title}</strong>
                    </div>
                    <button onClick={closeIssueDetail}>×</button>
                  </div>

                  <div className={styles.detailBody}>
                    <p>{issueDetail.issue.body || "No description."}</p>

                    <div className={styles.detailActions}>
                      <button
                        className={styles.secondary}
                        disabled={mutating}
                        onClick={() =>
                          void updateIssue({
                            state:
                              issueDetail.issue.state === "open"
                                ? "closed"
                                : "open"
                          })
                        }
                      >
                        {issueDetail.issue.state === "open"
                          ? "Close issue"
                          : "Reopen issue"}
                      </button>
                      <button
                        className={styles.secondary}
                        disabled={mutating}
                        onClick={() =>
                          void updateIssue(
                            issueDetail.issue.assigneeUserId
                              ? { unassign: true }
                              : { assignToMe: true }
                          )
                        }
                      >
                        {issueDetail.issue.assigneeUserId
                          ? "Unassign"
                          : "Assign to me"}
                      </button>
                    </div>

                    <div className={styles.sectionBlock}>
                      <strong>Labels</strong>
                      <select
                        multiple
                        value={selectedIssueLabels}
                        onChange={(event) =>
                          setSelectedIssueLabels(
                            [...event.target.selectedOptions].map(
                              (option) => option.value
                            )
                          )
                        }
                      >
                        {summary.labels.map((label) => (
                          <option key={label.id} value={label.id}>
                            {label.name}
                          </option>
                        ))}
                      </select>
                      <button
                        className={styles.secondary}
                        disabled={mutating}
                        onClick={() => void saveIssueLabels()}
                      >
                        Save labels
                      </button>
                    </div>

                    <div className={styles.sectionBlock}>
                      <strong>Dependencies</strong>
                      {issueDetail.dependencies.map((dependency) => (
                        <button
                          key={dependency.dependsOnIssueId}
                          className={styles.reference}
                          onClick={() => openIssue(dependency.dependsOnNumber)}
                        >
                          #{dependency.dependsOnNumber}{" "}
                          {dependency.dependsOnTitle}
                          <em>{dependency.dependsOnState}</em>
                        </button>
                      ))}
                      <div className={styles.inline}>
                        <input
                          type="number"
                          min={1}
                          value={dependencyNumber}
                          onChange={(event) =>
                            setDependencyNumber(event.target.value)
                          }
                          placeholder="Issue #"
                        />
                        <button
                          className={styles.secondary}
                          onClick={() => void addDependency()}
                        >
                          Add
                        </button>
                      </div>
                    </div>

                    <div className={styles.sectionBlock}>
                      <strong>Linked development</strong>
                      {issueDetail.links.map((link) => (
                        <div className={styles.linkItem} key={link.id}>
                          <span>{link.linkType}</span>
                          <code>{link.refValue.slice(0, 12)}</code>
                          <small>{link.title || ""}</small>
                        </div>
                      ))}
                      {!issueDetail.links.length && (
                        <span className={styles.muted}>
                          Commits and Change Requests referencing this issue
                          appear here.
                        </span>
                      )}
                    </div>

                    <div className={styles.sectionBlock}>
                      <strong>Comments</strong>
                      {issueDetail.comments.map((comment) => (
                        <article
                          className={styles.comment}
                          key={comment.id}
                        >
                          <div>
                            <strong>{comment.authorName}</strong>
                            <span>{age(comment.createdAt)}</span>
                          </div>
                          <p>{comment.body}</p>
                        </article>
                      ))}
                      <textarea
                        value={issueComment}
                        onChange={(event) => setIssueComment(event.target.value)}
                        placeholder="Add a comment"
                      />
                      <button
                        className={styles.primary}
                        disabled={mutating || !issueComment.trim()}
                        onClick={() => void addIssueComment()}
                      >
                        Comment
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className={styles.emptyDetail}>
                  Select an issue to inspect its work, dependencies and linked
                  development.
                </div>
              )}
            </aside>
          </div>
        )}

        {tab === "boards" && (
          <section>
            <div className={styles.boardToolbar}>
              <div>
                <strong>Project boards</strong>
                <span>Move issues through a standard delivery flow.</span>
              </div>
              <div className={styles.inline}>
                <input
                  value={boardName}
                  onChange={(event) => setBoardName(event.target.value)}
                  placeholder="New board"
                />
                <button
                  className={styles.primary}
                  disabled={mutating || !boardName.trim()}
                  onClick={() => void createBoard()}
                >
                  Create
                </button>
              </div>
            </div>

            {boards.length > 0 && (
              <div className={styles.boardPicker}>
                <select
                  value={activeBoardId}
                  onChange={(event) => setActiveBoardId(event.target.value)}
                >
                  {boards.map((board) => (
                    <option key={board.id} value={board.id}>
                      {board.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {activeBoard ? (
              <div className={styles.board}>
                {boardColumns.map((column) => (
                  <div className={styles.boardColumn} key={column.key}>
                    <div className={styles.columnHeader}>
                      <strong>{column.title}</strong>
                      <span>
                        {
                          (activeBoard.cards ?? []).filter(
                            (card) => card.column === column.key
                          ).length
                        }
                      </span>
                    </div>

                    <div className={styles.cardList}>
                      {(activeBoard.cards ?? [])
                        .filter((card) => card.column === column.key)
                        .map((card) => (
                          <article className={styles.workCard} key={card.id}>
                            <button onClick={() => openIssue(card.issueNumber)}>
                              <span>#{card.issueNumber}</span>
                              <strong>{card.issueTitle}</strong>
                            </button>
                            <select
                              value={card.column}
                              onChange={(event) =>
                                void moveCard(
                                  card.issueNumber,
                                  event.target.value as BoardColumn
                                )
                              }
                            >
                              {boardColumns.map((target) => (
                                <option key={target.key} value={target.key}>
                                  {target.title}
                                </option>
                              ))}
                            </select>
                          </article>
                        ))}

                      {column.key === "backlog" &&
                        summary.issues
                          .filter(
                            (issue) =>
                              !(activeBoard.cards ?? []).some(
                                (card) => card.issueNumber === issue.number
                              )
                          )
                          .slice(0, 20)
                          .map((issue) => (
                            <article
                              className={styles.workCard}
                              key={"available-" + issue.id}
                            >
                              <button onClick={() => openIssue(issue.number)}>
                                <span>#{issue.number}</span>
                                <strong>{issue.title}</strong>
                              </button>
                              <button
                                className={styles.secondary}
                                onClick={() =>
                                  void moveCard(issue.number, "backlog")
                                }
                              >
                                Add
                              </button>
                            </article>
                          ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className={styles.empty}>Create a board to start planning.</div>
            )}
          </section>
        )}

        {tab === "discussions" && (
          <div className={styles.discussionLayout}>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <strong>Discussions</strong>
                  <span>Long-form technical and project conversations.</span>
                </div>
              </div>

              <div className={styles.discussionCreate}>
                <input
                  value={discussionTitle}
                  onChange={(event) => setDiscussionTitle(event.target.value)}
                  placeholder="Discussion title"
                />
                <select
                  value={discussionCategory}
                  onChange={(event) =>
                    setDiscussionCategory(event.target.value)
                  }
                >
                  <option value="general">General</option>
                  <option value="ideas">Ideas</option>
                  <option value="q-and-a">Q&A</option>
                  <option value="design">Design</option>
                  <option value="announcements">Announcements</option>
                </select>
                <textarea
                  value={discussionBody}
                  onChange={(event) => setDiscussionBody(event.target.value)}
                  placeholder="Start the conversation"
                />
                <button
                  className={styles.primary}
                  disabled={
                    mutating ||
                    !discussionTitle.trim() ||
                    !discussionBody.trim()
                  }
                  onClick={() => void createDiscussion()}
                >
                  Start discussion
                </button>
              </div>

              {summary.discussions.map((discussion) => (
                <button
                  className={styles.discussionRow}
                  key={discussion.id}
                  onClick={() => setSelectedDiscussion(discussion.number)}
                >
                  <div>
                    <strong>
                      #{discussion.number} {discussion.title}
                    </strong>
                    <span>
                      {discussion.category} · {discussion.authorName} ·{" "}
                      {age(discussion.updatedAt)}
                    </span>
                  </div>
                  <em>{discussion.state}</em>
                </button>
              ))}
            </section>

            <aside className={styles.detailPanel}>
              {discussionDetail ? (
                <>
                  <div className={styles.detailHeader}>
                    <div>
                      <span>
                        DISCUSSION #{discussionDetail.discussion.number}
                      </span>
                      <strong>{discussionDetail.discussion.title}</strong>
                    </div>
                    <button
                      onClick={() => {
                        setSelectedDiscussion(null);
                        setDiscussionDetail(null);
                      }}
                    >
                      ×
                    </button>
                  </div>
                  <div className={styles.detailBody}>
                    <p>{discussionDetail.discussion.body}</p>
                    {discussionDetail.replies.map((reply) => (
                      <article className={styles.comment} key={reply.id}>
                        <div>
                          <strong>{reply.authorName}</strong>
                          <span>{age(reply.createdAt)}</span>
                        </div>
                        <p>{reply.body}</p>
                      </article>
                    ))}
                    {discussionDetail.discussion.state === "open" && (
                      <>
                        <textarea
                          value={discussionReply}
                          onChange={(event) =>
                            setDiscussionReply(event.target.value)
                          }
                          placeholder="Reply to this discussion"
                        />
                        <button
                          className={styles.primary}
                          disabled={mutating || !discussionReply.trim()}
                          onClick={() => void addDiscussionReply()}
                        >
                          Reply
                        </button>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className={styles.emptyDetail}>
                  Select a discussion to open the conversation.
                </div>
              )}
            </aside>
          </div>
        )}

        {tab === "planning" && (
          <div className={styles.planningGrid}>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <strong>Labels</strong>
                  <span>Classify work consistently.</span>
                </div>
              </div>
              <div className={styles.inlineForm}>
                <input
                  value={labelName}
                  onChange={(event) => setLabelName(event.target.value)}
                  placeholder="Label name"
                />
                <input
                  value={labelColor}
                  onChange={(event) => setLabelColor(event.target.value)}
                  maxLength={6}
                  placeholder="667085"
                />
                <button
                  className={styles.primary}
                  onClick={() => void createLabel()}
                  disabled={mutating || !labelName.trim()}
                >
                  Add
                </button>
              </div>
              <div className={styles.chipList}>
                {summary.labels.map((label) => (
                  <span
                    key={label.id}
                    style={{ borderColor: "#" + label.color }}
                  >
                    {label.name}
                  </span>
                ))}
              </div>
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <strong>Milestones</strong>
                  <span>Group issues around delivery targets.</span>
                </div>
              </div>
              <div className={styles.inlineForm}>
                <input
                  value={milestoneTitle}
                  onChange={(event) => setMilestoneTitle(event.target.value)}
                  placeholder="Milestone title"
                />
                <input
                  type="date"
                  value={milestoneDue}
                  onChange={(event) => setMilestoneDue(event.target.value)}
                />
                <button
                  className={styles.primary}
                  onClick={() => void createMilestone()}
                  disabled={mutating || !milestoneTitle.trim()}
                >
                  Add
                </button>
              </div>
              {summary.milestones.map((milestone) => (
                <div className={styles.metaRow} key={milestone.id}>
                  <div>
                    <strong>{milestone.title}</strong>
                    <span>
                      {milestone.dueAt
                        ? new Date(milestone.dueAt).toLocaleDateString()
                        : "No due date"}
                    </span>
                  </div>
                  <em>{milestone.state}</em>
                </div>
              ))}
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <strong>Issue templates</strong>
                  <span>Standardize recurring work.</span>
                </div>
              </div>
              <div className={styles.templateForm}>
                <input
                  value={templateName}
                  onChange={(event) => setTemplateName(event.target.value)}
                  placeholder="Template name"
                />
                <input
                  value={templateTitle}
                  onChange={(event) => setTemplateTitle(event.target.value)}
                  placeholder="Default issue title"
                />
                <textarea
                  value={templateBody}
                  onChange={(event) => setTemplateBody(event.target.value)}
                  placeholder="Default issue body"
                />
                <button
                  className={styles.primary}
                  disabled={mutating || !templateName.trim()}
                  onClick={() => void createTemplate()}
                >
                  Save template
                </button>
              </div>
              {summary.templates.map((template) => (
                <button
                  key={template.id}
                  className={styles.templateRow}
                  onClick={() => useTemplate(template)}
                >
                  <strong>{template.name}</strong>
                  <span>Use template →</span>
                </button>
              ))}
            </section>
          </div>
        )}

        {tab === "activity" && (
          <section className={styles.timelinePanel}>
            {summary.activity.map((item) => (
              <article key={item.id}>
                <span className={styles.activityDot} />
                <div>
                  <strong>
                    {item.actorName} {eventLabel(item.eventType)}
                    {item.entityNumber ? " #" + item.entityNumber : ""}
                  </strong>
                  <span>{age(item.createdAt)}</span>
                </div>
              </article>
            ))}
            {!summary.activity.length && (
              <div className={styles.empty}>No project activity yet.</div>
            )}
          </section>
        )}

        {tab === "notifications" && (
          <section className={styles.notificationList}>
            {summary.notifications.map((notification) => (
              <button
                key={notification.id}
                className={
                  notification.readAt
                    ? styles.notificationRead
                    : styles.notificationUnread
                }
                onClick={() => {
                  void markRead(notification);
                  router.push(notification.href);
                }}
              >
                <div>
                  <strong>{notification.title}</strong>
                  <span>{notification.body}</span>
                </div>
                <em>{age(notification.createdAt)}</em>
              </button>
            ))}
            {!summary.notifications.length && (
              <div className={styles.empty}>No notifications.</div>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
