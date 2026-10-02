"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./access.module.css";

type OrganizationMembership = {
  membership: {
    id: string;
    userId: string;
    organizationId: string;
    role: "owner" | "admin" | "member" | "guest";
    disabled: boolean;
  };
  organization: {
    id: string;
    name: string;
    slug: string;
  };
};

type Repository = {
  id: string;
  namespace: string;
  slug: string;
  name: string;
  visibility: string;
  access: {
    role: string | null;
    source: string;
    legacy: boolean;
  };
};

type Binding = {
  namespace: string;
  organizationId: string;
  createdByName: string;
  createdAt: string;
};

type AccessSummary = {
  repositories: Repository[];
  organizations: OrganizationMembership[];
  bindings: Binding[];
  legacyMode: string;
  persistence: string;
};

type Grant = {
  id: string;
  subjectType: "user" | "team";
  subjectId: string;
  role: string;
  createdByName: string;
  updatedAt: string;
};

type TeamMember = {
  id: string;
  teamId: string;
  userId: string;
  role: "maintainer" | "member";
  addedByName: string;
  createdAt: string;
};

type Team = {
  id: string;
  namespace: string;
  slug: string;
  name: string;
  description: string;
  members: TeamMember[];
};

type RepositoryAccess = {
  repository: {
    id: string;
    namespace: string;
    slug: string;
    visibility: string;
  };
  role: string | null;
  source: string;
  legacy: boolean;
  permissions: string[];
  namespaceAdmin: boolean;
  binding: Binding | null;
  grants: Grant[];
  teams: Team[];
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

export function KoshAccessWorkspace() {
  const base = useMemo(apiBase, []);
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [access, setAccess] = useState<RepositoryAccess | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);

  const [bindNamespace, setBindNamespace] = useState("");
  const [bindOrganizationId, setBindOrganizationId] = useState("");

  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");
  const [memberTeamId, setMemberTeamId] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [memberRole, setMemberRole] = useState<"maintainer" | "member">("member");

  const [grantType, setGrantType] = useState<"user" | "team">("user");
  const [grantSubject, setGrantSubject] = useState("");
  const [grantRole, setGrantRole] = useState("reader");

  const fetchJson = useCallback(async <T,>(path: string): Promise<T> => {
    const response = await fetch(base + path, {
      credentials: "include",
      cache: "no-store"
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Kosh request failed.");
    return payload;
  }, [base]);

  const mutateJson = useCallback(
    async <T,>(
      path: string,
      method: "POST" | "DELETE",
      body?: unknown
    ): Promise<T> => {
      const response = await fetch(base + path, {
        method,
        credentials: "include",
        headers:
          body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const payload = (await response.json()) as T & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Kosh request failed.");
      return payload;
    },
    [base]
  );

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await fetchJson<AccessSummary>("/v1/kosh/access/summary");
      setSummary(payload);

      const params = new URLSearchParams(window.location.search);
      const namespace = params.get("namespace")?.trim();
      const slug = params.get("slug")?.trim();
      const requested =
        namespace && slug ? namespace + "/" + slug : "";
      const next =
        requested && payload.repositories.some(
          (repo) => repo.namespace + "/" + repo.slug === requested
        )
          ? requested
          : selectedRepo && payload.repositories.some(
              (repo) => repo.namespace + "/" + repo.slug === selectedRepo
            )
            ? selectedRepo
            : payload.repositories[0]
              ? payload.repositories[0].namespace + "/" + payload.repositories[0].slug
              : "";
      setSelectedRepo(next);

      if (!bindOrganizationId) {
        const adminOrg = payload.organizations.find((item) =>
          ["owner", "admin"].includes(item.membership.role)
        );
        if (adminOrg) setBindOrganizationId(adminOrg.organization.id);
      }
      if (!bindNamespace && payload.repositories[0]) {
        setBindNamespace(payload.repositories[0].namespace);
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load Kosh Access."
      );
    } finally {
      setLoading(false);
    }
  }, [bindNamespace, bindOrganizationId, fetchJson, selectedRepo]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const loadRepositoryAccess = useCallback(async () => {
    if (!selectedRepo) {
      setAccess(null);
      return;
    }
    const [namespace, slug] = selectedRepo.split("/");
    if (!namespace || !slug) return;
    try {
      const payload = await fetchJson<RepositoryAccess>(
        "/v1/kosh/repos/" +
          encodeURIComponent(namespace) +
          "/" +
          encodeURIComponent(slug) +
          "/access"
      );
      setAccess(payload);
    } catch (reason) {
      setAccess(null);
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not load repository access."
      );
    }
  }, [fetchJson, selectedRepo]);

  useEffect(() => {
    void loadRepositoryAccess();
  }, [loadRepositoryAccess]);

  async function bindNamespaceSubmit(event: FormEvent) {
    event.preventDefault();
    if (!bindNamespace.trim() || !bindOrganizationId) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        "/v1/kosh/access/namespaces/" +
          encodeURIComponent(bindNamespace.trim()) +
          "/bind",
        "POST",
        { organizationId: bindOrganizationId }
      );
      await loadSummary();
      await loadRepositoryAccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Namespace bind failed.");
    } finally {
      setMutating(false);
    }
  }

  async function createTeam(event: FormEvent) {
    event.preventDefault();
    if (!access || !teamName.trim()) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson("/v1/kosh/access/teams", "POST", {
        namespace: access.repository.namespace,
        name: teamName.trim(),
        description: teamDescription.trim()
      });
      setTeamName("");
      setTeamDescription("");
      await loadRepositoryAccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Team creation failed.");
    } finally {
      setMutating(false);
    }
  }

  async function addTeamMember(event: FormEvent) {
    event.preventDefault();
    if (!memberTeamId || !memberUserId.trim()) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        "/v1/kosh/access/teams/" +
          encodeURIComponent(memberTeamId) +
          "/members",
        "POST",
        {
          userId: memberUserId.trim(),
          role: memberRole
        }
      );
      setMemberUserId("");
      await loadRepositoryAccess();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Team member update failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function removeTeamMember(teamId: string, userId: string) {
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        "/v1/kosh/access/teams/" +
          encodeURIComponent(teamId) +
          "/members/" +
          encodeURIComponent(userId),
        "DELETE"
      );
      await loadRepositoryAccess();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Team member removal failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function createGrant(event: FormEvent) {
    event.preventDefault();
    if (!access || !grantSubject.trim()) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        "/v1/kosh/repos/" +
          encodeURIComponent(access.repository.namespace) +
          "/" +
          encodeURIComponent(access.repository.slug) +
          "/access/grants",
        "POST",
        {
          subjectType: grantType,
          subjectId: grantSubject.trim(),
          role: grantRole
        }
      );
      setGrantSubject("");
      await loadRepositoryAccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Grant update failed.");
    } finally {
      setMutating(false);
    }
  }

  async function deleteGrant(grant: Grant) {
    if (!access) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        "/v1/kosh/repos/" +
          encodeURIComponent(access.repository.namespace) +
          "/" +
          encodeURIComponent(access.repository.slug) +
          "/access/grants/" +
          encodeURIComponent(grant.id),
        "DELETE"
      );
      await loadRepositoryAccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Grant removal failed.");
    } finally {
      setMutating(false);
    }
  }

  if (loading && !summary) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Access</strong>
        <span>Resolving organizations and repository roles…</span>
      </main>
    );
  }

  if (!summary) {
    return (
      <main className={styles.loading}>
        <strong>Access unavailable</strong>
        <span>{error || "Kosh Access could not be loaded."}</span>
        <Link href="/apps/kosh">Back to Kosh</Link>
      </main>
    );
  }

  const selectedRepository = summary.repositories.find(
    (repo) => repo.namespace + "/" + repo.slug === selectedRepo
  );

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href="/apps/kosh">← Kosh</Link>
          <p>KOSH ACCESS</p>
          <h1>Permissions</h1>
          <span>
            Namespace ownership, teams and repository roles from one policy
            surface.
          </span>
        </div>
        <div className={styles.headerStats}>
          <div>
            <strong>{summary.repositories.length}</strong>
            <span>visible repositories</span>
          </div>
          <div>
            <strong>{summary.organizations.length}</strong>
            <span>organizations</span>
          </div>
          <div>
            <strong>{summary.bindings.length}</strong>
            <span>bound namespaces</span>
          </div>
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Repository access</strong>
                <span>Effective role and permission source</span>
              </div>
            </div>
            <select
              className={styles.repoSelect}
              value={selectedRepo}
              onChange={(event) => setSelectedRepo(event.target.value)}
            >
              {summary.repositories.map((repo) => (
                <option
                  key={repo.id}
                  value={repo.namespace + "/" + repo.slug}
                >
                  {repo.namespace}/{repo.slug}
                </option>
              ))}
            </select>

            {selectedRepository && (
              <div className={styles.roleCard}>
                <span>{selectedRepository.visibility}</span>
                <strong>{selectedRepository.name}</strong>
                <p>
                  Role: {selectedRepository.access.role || "none"} · source:{" "}
                  {selectedRepository.access.source}
                </p>
                {selectedRepository.access.legacy && (
                  <em>Legacy compatibility access is active for this repository.</em>
                )}
              </div>
            )}

            {access && (
              <div className={styles.permissions}>
                {access.permissions.map((permission) => (
                  <span key={permission}>{permission}</span>
                ))}
              </div>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Namespace ownership</strong>
                <span>Bind a Kosh namespace to one Workspace organization</span>
              </div>
            </div>
            <form className={styles.form} onSubmit={bindNamespaceSubmit}>
              <label>
                <span>Namespace</span>
                <input
                  value={bindNamespace}
                  onChange={(event) => setBindNamespace(event.target.value)}
                  placeholder="tamishra"
                />
              </label>
              <label>
                <span>Organization</span>
                <select
                  value={bindOrganizationId}
                  onChange={(event) =>
                    setBindOrganizationId(event.target.value)
                  }
                >
                  {summary.organizations
                    .filter((item) =>
                      ["owner", "admin"].includes(item.membership.role)
                    )
                    .map((item) => (
                      <option
                        key={item.organization.id}
                        value={item.organization.id}
                      >
                        {item.organization.name} ({item.membership.role})
                      </option>
                    ))}
                </select>
              </label>
              <button
                className={styles.primary}
                disabled={mutating || !bindNamespace.trim() || !bindOrganizationId}
              >
                Bind namespace
              </button>
            </form>

            <div className={styles.list}>
              {summary.bindings.map((binding) => (
                <article key={binding.namespace}>
                  <strong>{binding.namespace}</strong>
                  <span>{binding.organizationId}</span>
                  <em>{binding.createdByName} · {age(binding.createdAt)}</em>
                </article>
              ))}
            </div>
          </section>
        </div>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Repository grants</strong>
                <span>User or team role assignments</span>
              </div>
            </div>

            {access && access.permissions.includes("access.manage") ? (
              <>
                <form className={styles.form} onSubmit={createGrant}>
                  <label>
                    <span>Subject</span>
                    <select
                      value={grantType}
                      onChange={(event) =>
                        setGrantType(event.target.value as "user" | "team")
                      }
                    >
                      <option value="user">User</option>
                      <option value="team">Team</option>
                    </select>
                  </label>
                  <label>
                    <span>Role</span>
                    <select
                      value={grantRole}
                      onChange={(event) => setGrantRole(event.target.value)}
                    >
                      <option value="reader">Reader</option>
                      <option value="reviewer">Reviewer</option>
                      <option value="contributor">Contributor</option>
                      <option value="maintainer">Maintainer</option>
                      <option value="owner">Owner</option>
                    </select>
                  </label>
                  <label className={styles.wide}>
                    <span>
                      {grantType === "user" ? "User ID" : "Team"}
                    </span>
                    {grantType === "team" ? (
                      <select
                        value={grantSubject}
                        onChange={(event) => setGrantSubject(event.target.value)}
                      >
                        <option value="">Choose team</option>
                        {access.teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        value={grantSubject}
                        onChange={(event) => setGrantSubject(event.target.value)}
                        placeholder="Workspace user ID"
                      />
                    )}
                  </label>
                  <button
                    className={styles.primary}
                    disabled={mutating || !grantSubject.trim()}
                  >
                    Save grant
                  </button>
                </form>

                <div className={styles.grants}>
                  {access.grants.map((grant) => (
                    <article key={grant.id}>
                      <div>
                        <span>{grant.subjectType}</span>
                        <strong>{grant.subjectId}</strong>
                        <small>
                          {grant.role} · {grant.createdByName} ·{" "}
                          {age(grant.updatedAt)}
                        </small>
                      </div>
                      <button
                        disabled={mutating}
                        onClick={() => void deleteGrant(grant)}
                      >
                        Remove
                      </button>
                    </article>
                  ))}
                  {!access.grants.length && (
                    <div className={styles.empty}>No explicit grants.</div>
                  )}
                </div>
              </>
            ) : (
              <div className={styles.empty}>
                Your effective role does not manage repository access.
              </div>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Teams</strong>
                <span>Namespace-scoped access groups</span>
              </div>
            </div>

            {access && access.namespaceAdmin ? (
              <>
                <form className={styles.form} onSubmit={createTeam}>
                  <label className={styles.wide}>
                    <span>Team name</span>
                    <input
                      value={teamName}
                      onChange={(event) => setTeamName(event.target.value)}
                      placeholder="Platform Engineering"
                    />
                  </label>
                  <label className={styles.wide}>
                    <span>Description</span>
                    <input
                      value={teamDescription}
                      onChange={(event) => setTeamDescription(event.target.value)}
                    />
                  </label>
                  <button
                    className={styles.primary}
                    disabled={mutating || !teamName.trim()}
                  >
                    Create team
                  </button>
                </form>

                {access.teams.length > 0 && (
                  <form className={styles.form} onSubmit={addTeamMember}>
                    <label>
                      <span>Team</span>
                      <select
                        value={memberTeamId}
                        onChange={(event) => setMemberTeamId(event.target.value)}
                      >
                        <option value="">Choose team</option>
                        {access.teams.map((team) => (
                          <option key={team.id} value={team.id}>
                            {team.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Member role</span>
                      <select
                        value={memberRole}
                        onChange={(event) =>
                          setMemberRole(
                            event.target.value as "maintainer" | "member"
                          )
                        }
                      >
                        <option value="member">Member</option>
                        <option value="maintainer">Maintainer</option>
                      </select>
                    </label>
                    <label className={styles.wide}>
                      <span>Workspace user ID</span>
                      <input
                        value={memberUserId}
                        onChange={(event) => setMemberUserId(event.target.value)}
                        placeholder="Workspace user ID"
                      />
                    </label>
                    <button
                      className={styles.primary}
                      disabled={mutating || !memberTeamId || !memberUserId.trim()}
                    >
                      Add member
                    </button>
                  </form>
                )}

                <div className={styles.list}>
                  {access.teams.map((team) => (
                    <article key={team.id}>
                      <strong>{team.name}</strong>
                      <span>{team.slug}</span>
                      <em>{team.description || "No description."}</em>
                      <div className={styles.memberList}>
                        {team.members.map((member) => (
                          <div key={member.id}>
                            <span>{member.userId}</span>
                            <small>{member.role}</small>
                            <button
                              type="button"
                              disabled={mutating}
                              onClick={() =>
                                void removeTeamMember(team.id, member.userId)
                              }
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                        {!team.members.length && <small>No members yet.</small>}
                      </div>
                    </article>
                  ))}
                  {!access.teams.length && (
                    <div className={styles.empty}>No teams in this namespace.</div>
                  )}
                </div>
              </>
            ) : (
              <div className={styles.empty}>
                Team management requires namespace administration.
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
