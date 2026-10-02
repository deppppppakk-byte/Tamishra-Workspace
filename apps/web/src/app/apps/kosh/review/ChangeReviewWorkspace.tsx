"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./review.module.css";

type ChangeRequest = {
  id: string;
  number: number;
  title: string;
  description: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  authorName: string;
  status: "open" | "merged" | "closed";
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergedByName: string | null;
  mergeCommitSha: string | null;
};

type CompareFile = {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
};

type Comparison = {
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  ahead: number;
  behind: number;
  mergeable: boolean;
  files: CompareFile[];
  patch: string | null;
  patchTruncated: boolean;
};

type Review = {
  id: string;
  reviewerUserId: string;
  reviewerName: string;
  state: "approve" | "request_changes" | "comment";
  body: string;
  createdAt: string;
};

type ReviewComment = {
  id: string;
  authorUserId: string;
  authorName: string;
  path: string | null;
  line: number | null;
  side: "base" | "head" | null;
  body: string;
  createdAt: string;
};

type BranchPolicy = {
  branch: string;
  requiredApprovals: number;
  blockOnChangesRequested: boolean;
  allowDirectPush: boolean;
  allowDelete: boolean;
};

type ReviewSummary = {
  approvals: number;
  changesRequested: number;
  requiredApprovals: number;
  readyToMerge: boolean;
  checksPassing: boolean;
  checksPending: number;
  checksFailing: number;
};

type Check = {
  id: string;
  name: string;
  status: "queued" | "running" | "success" | "failure" | "cancelled";
  required: boolean;
  details: string | null;
};

type DetailPayload = {
  changeRequest: ChangeRequest;
  comparison: Comparison;
  reviews: Review[];
  comments: ReviewComment[];
  policy: BranchPolicy;
  reviewSummary: ReviewSummary;
  checks: Check[];
};

function apiBase() {
  const configured =
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100";
  return configured.replace(/\/$/, "");
}

function ageLabel(value: string) {
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  const days = Math.floor(hours / 24);
  return days + "d ago";
}

function reviewLabel(state: Review["state"]) {
  if (state === "approve") return "Approved";
  if (state === "request_changes") return "Changes requested";
  return "Commented";
}

export function ChangeReviewWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [number, setNumber] = useState(0);
  const [detail, setDetail] = useState<DetailPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");

  const [reviewState, setReviewState] = useState<Review["state"]>("comment");
  const [reviewBody, setReviewBody] = useState("");

  const [commentPath, setCommentPath] = useState("");
  const [commentLine, setCommentLine] = useState("");
  const [commentSide, setCommentSide] = useState<"base" | "head">("head");
  const [commentBody, setCommentBody] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() ?? "");
    setSlug(params.get("slug")?.trim() ?? "");
    setNumber(Number(params.get("number") ?? 0));
  }, []);

  const resourceBase = useMemo(() => {
    if (!namespace || !slug || !number) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug) +
      "/change-requests/" +
      number
    );
  }, [base, namespace, number, slug]);

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
    if (!resourceBase) return;
    setLoading(true);
    setError("");
    try {
      const payload = await fetchJson<DetailPayload>(resourceBase);
      setDetail(payload);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load Change Request."
      );
    } finally {
      setLoading(false);
    }
  }, [fetchJson, resourceBase]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitReview() {
    if (!resourceBase) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(resourceBase + "/reviews", "POST", {
        state: reviewState,
        body: reviewBody.trim()
      });
      setReviewBody("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review submission failed.");
    } finally {
      setMutating(false);
    }
  }

  async function submitComment() {
    if (!resourceBase || !commentBody.trim()) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(resourceBase + "/comments", "POST", {
        path: commentPath.trim() || null,
        line: commentLine ? Number(commentLine) : null,
        side: commentPath.trim() ? commentSide : null,
        body: commentBody.trim()
      });
      setCommentBody("");
      setCommentLine("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Comment submission failed.");
    } finally {
      setMutating(false);
    }
  }

  async function merge() {
    if (!resourceBase) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(resourceBase + "/merge", "POST");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Merge failed.");
    } finally {
      setMutating(false);
    }
  }

  async function closeReview() {
    if (!resourceBase) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(resourceBase, "PATCH", { status: "closed" });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Close failed.");
    } finally {
      setMutating(false);
    }
  }

  if (loading && !detail) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Change Review</strong>
        <span>Loading review…</span>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className={styles.loading}>
        <strong>Change Review unavailable</strong>
        <span>{error || "Kosh could not open this review."}</span>
        <Link href={repositoryHref}>Back to repository</Link>
      </main>
    );
  }

  const change = detail.changeRequest;
  const comparison = detail.comparison;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href={repositoryHref}>← Repository</Link>
        <div className={styles.titleRow}>
          <div>
            <div className={styles.kicker}>
              CHANGE REQUEST #{change.number}
            </div>
            <h1>{change.title}</h1>
            <p>
              {change.authorName} wants to merge{" "}
              <code>{change.headBranch}</code> into{" "}
              <code>{change.baseBranch}</code>.
            </p>
          </div>
          <span className={styles[change.status]}>{change.status}</span>
        </div>

        <div className={styles.metrics}>
          <span>{comparison.ahead} commits ahead</span>
          <span>{comparison.behind} behind</span>
          <span>{comparison.files.length} files changed</span>
          <span>{comparison.mergeable ? "No Git conflicts" : "Conflicts detected"}</span>
        </div>
      </header>

      <section className={styles.body}>
        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.mainGrid}>
          <section className={styles.primaryColumn}>
            {change.description && (
              <article className={styles.card}>
                <div className={styles.cardTitle}>Description</div>
                <p className={styles.description}>{change.description}</p>
              </article>
            )}

            <article className={styles.card}>
              <div className={styles.cardTitle}>
                Changed files
                <span>{comparison.files.length}</span>
              </div>
              <div className={styles.fileList}>
                {comparison.files.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => {
                      setCommentPath(file.path);
                      setCommentSide("head");
                    }}
                  >
                    <span className={styles.fileStatus}>{file.status}</span>
                    <strong>{file.path}</strong>
                    <em>
                      {file.additions === null ? "—" : "+" + file.additions}
                      {" / "}
                      {file.deletions === null ? "—" : "-" + file.deletions}
                    </em>
                  </button>
                ))}
              </div>
            </article>

            <article className={styles.card}>
              <div className={styles.cardTitle}>
                Diff
                <span>
                  {comparison.patchTruncated
                    ? "preview limit reached"
                    : "unified patch"}
                </span>
              </div>
              {comparison.patch ? (
                <pre className={styles.diff}>{comparison.patch}</pre>
              ) : (
                <div className={styles.emptyNote}>
                  The patch is too large for the 2 MB review preview. File
                  metadata remains available above.
                </div>
              )}
            </article>

            <article className={styles.card}>
              <div className={styles.cardTitle}>
                Review activity
                <span>{detail.reviews.length + detail.comments.length}</span>
              </div>
              <div className={styles.timeline}>
                {detail.reviews.map((review) => (
                  <div className={styles.timelineItem} key={review.id}>
                    <div>
                      <strong>{review.reviewerName}</strong>
                      <span>
                        {reviewLabel(review.state)} · {ageLabel(review.createdAt)}
                      </span>
                    </div>
                    <em className={styles[review.state]}>{reviewLabel(review.state)}</em>
                    {review.body && <p>{review.body}</p>}
                  </div>
                ))}

                {detail.comments.map((comment) => (
                  <div className={styles.timelineItem} key={comment.id}>
                    <div>
                      <strong>{comment.authorName}</strong>
                      <span>
                        Commented · {ageLabel(comment.createdAt)}
                        {comment.path
                          ? " · " +
                            comment.path +
                            (comment.line ? ":" + comment.line : "")
                          : ""}
                      </span>
                    </div>
                    <p>{comment.body}</p>
                  </div>
                ))}

                {!detail.reviews.length && !detail.comments.length && (
                  <div className={styles.emptyNote}>
                    No review activity yet.
                  </div>
                )}
              </div>
            </article>
          </section>

          <aside className={styles.sidebar}>
            <section className={styles.card}>
              <div className={styles.cardTitle}>Merge gate</div>
              <dl className={styles.gateList}>
                <div>
                  <dt>Approvals</dt>
                  <dd>
                    {detail.reviewSummary.approvals}/
                    {detail.reviewSummary.requiredApprovals}
                  </dd>
                </div>
                <div>
                  <dt>Changes requested</dt>
                  <dd>{detail.reviewSummary.changesRequested}</dd>
                </div>
                <div>
                  <dt>Git mergeable</dt>
                  <dd>{comparison.mergeable ? "Yes" : "No"}</dd>
                </div>
                <div>
                  <dt>Direct push</dt>
                  <dd>{detail.policy.allowDirectPush ? "Allowed" : "Protected"}</dd>
                </div>
                <div>
                  <dt>Required checks</dt>
                  <dd>
                    {detail.reviewSummary.checksFailing > 0
                      ? detail.reviewSummary.checksFailing + " failing"
                      : detail.reviewSummary.checksPending > 0
                        ? detail.reviewSummary.checksPending + " pending"
                        : detail.reviewSummary.checksPassing
                          ? "Passing"
                          : "Not configured"}
                  </dd>
                </div>
              </dl>

              {detail.checks.length > 0 && (
                <div className={styles.checkList}>
                  {detail.checks.map((check) => (
                    <div className={styles.checkRow} key={check.id}>
                      <div>
                        <strong>{check.name}</strong>
                        <span>{check.details || (check.required ? "Required" : "Optional")}</span>
                      </div>
                      <em className={styles["check_" + check.status]}>
                        {check.status}
                      </em>
                    </div>
                  ))}
                </div>
              )}

              {change.status === "open" && (
                <>
                  <button
                    className={styles.mergeButton}
                    disabled={mutating || !detail.reviewSummary.readyToMerge}
                    onClick={() => void merge()}
                  >
                    {mutating ? "Working…" : "Merge Change Request"}
                  </button>
                  {!detail.reviewSummary.readyToMerge && (
                    <p className={styles.gateHelp}>
                      Required approvals, review status, Git mergeability and
                      required Automation checks must all pass before Kosh enables merge.
                    </p>
                  )}
                  <button
                    className={styles.closeButton}
                    disabled={mutating}
                    onClick={() => void closeReview()}
                  >
                    Close without merging
                  </button>
                </>
              )}

              {change.status === "merged" && (
                <div className={styles.mergedBox}>
                  <strong>Merged</strong>
                  <span>
                    {change.mergeCommitSha?.slice(0, 10) || "merge recorded"}
                  </span>
                </div>
              )}
            </section>

            {change.status === "open" && (
              <section className={styles.card}>
                <div className={styles.cardTitle}>Submit review</div>
                <label className={styles.field}>
                  <span>Decision</span>
                  <select
                    value={reviewState}
                    onChange={(event) =>
                      setReviewState(event.target.value as Review["state"])
                    }
                  >
                    <option value="comment">Comment only</option>
                    <option value="approve">Approve</option>
                    <option value="request_changes">Request changes</option>
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Review note</span>
                  <textarea
                    value={reviewBody}
                    onChange={(event) => setReviewBody(event.target.value)}
                    placeholder="Add context for your decision"
                  />
                </label>
                <button
                  className={styles.primaryButton}
                  disabled={mutating}
                  onClick={() => void submitReview()}
                >
                  Submit review
                </button>
              </section>
            )}

            {change.status === "open" && (
              <section className={styles.card}>
                <div className={styles.cardTitle}>Add comment</div>
                <label className={styles.field}>
                  <span>File path (optional)</span>
                  <select
                    value={commentPath}
                    onChange={(event) => setCommentPath(event.target.value)}
                  >
                    <option value="">General comment</option>
                    {comparison.files.map((file) => (
                      <option key={file.path} value={file.path}>
                        {file.path}
                      </option>
                    ))}
                  </select>
                </label>

                {commentPath && (
                  <div className={styles.inlineFields}>
                    <label className={styles.field}>
                      <span>Side</span>
                      <select
                        value={commentSide}
                        onChange={(event) =>
                          setCommentSide(event.target.value as "base" | "head")
                        }
                      >
                        <option value="head">Head</option>
                        <option value="base">Base</option>
                      </select>
                    </label>
                    <label className={styles.field}>
                      <span>Line</span>
                      <input
                        type="number"
                        min={1}
                        value={commentLine}
                        onChange={(event) => setCommentLine(event.target.value)}
                        placeholder="Optional"
                      />
                    </label>
                  </div>
                )}

                <label className={styles.field}>
                  <span>Comment</span>
                  <textarea
                    value={commentBody}
                    onChange={(event) => setCommentBody(event.target.value)}
                    placeholder="What should the author know?"
                  />
                </label>
                <button
                  className={styles.primaryButton}
                  disabled={mutating || !commentBody.trim()}
                  onClick={() => void submitComment()}
                >
                  Add comment
                </button>
              </section>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}
