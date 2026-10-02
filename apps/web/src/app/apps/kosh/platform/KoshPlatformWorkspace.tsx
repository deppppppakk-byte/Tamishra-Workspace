"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { koshModules } from "@tamishra/kosh-core";
import styles from "./platform.module.css";

type ResourceType =
  | "package"
  | "package_channel"
  | "release"
  | "security_finding"
  | "organization"
  | "team"
  | "merge_queue_entry"
  | "dev_environment"
  | "wiki_page"
  | "page_site"
  | "webhook"
  | "subscription"
  | "project_field"
  | "storage_policy"
  | "backup"
  | "extension"
  | "admin_setting"
  | "code_index"
  | "code_owner_rule"
  | "deployment_policy";

type Resource = {
  id: string;
  repositoryId: string | null;
  namespace: string;
  type: ResourceType;
  key: string;
  name: string;
  state: string;
  payload: Record<string, unknown>;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

type Secret = {
  id: string;
  environmentName: string | null;
  name: string;
  createdByName: string;
  updatedAt: string;
};

type SshKey = {
  id: string;
  title: string;
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  lastUsedAt: string | null;
};

type ApiToken = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type AuditEvent = {
  id: string;
  actorName: string;
  eventType: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

type Summary = {
  repository: {
    id: string;
    namespace: string;
    slug: string;
    name: string;
  };
  counts: Record<string, number>;
  secrets: Secret[];
  recentAudit: AuditEvent[];
};

type SearchResult = {
  query: string;
  mode: string;
  commitSha: string | null;
  results: Array<Record<string, unknown>>;
};

const resourceOptions: Array<{ value: ResourceType; label: string }> = [
  { value: "release", label: "Release" },
  { value: "security_finding", label: "Security finding" },
  { value: "organization", label: "Organization" },
  { value: "team", label: "Team" },
  { value: "merge_queue_entry", label: "Merge queue entry" },
  { value: "dev_environment", label: "Development environment" },
  { value: "wiki_page", label: "Wiki page" },
  { value: "page_site", label: "Pages site" },
  { value: "webhook", label: "Webhook" },
  { value: "subscription", label: "Subscription" },
  { value: "project_field", label: "Project custom field" },
  { value: "storage_policy", label: "Storage policy" },
  { value: "backup", label: "Backup / restore point" },
  { value: "extension", label: "Extension" },
  { value: "admin_setting", label: "Administration setting" },
  { value: "code_index", label: "Code index" },
  { value: "code_owner_rule", label: "Code owner rule" },
  { value: "deployment_policy", label: "Deployment policy" }
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

function defaultPayload(type: ResourceType) {
  const payloads: Record<ResourceType, Record<string, unknown>> = {
    package: { version: "0.1.0", format: "generic", immutable: true },
    package_channel: { channel: "stable", packageKey: "" },
    release: { tag: "v0.1.0", prerelease: false, notes: "" },
    security_finding: { severity: "medium", status: "open", detector: "manual" },
    organization: { visibility: "internal" },
    team: { organizationKey: "", role: "member" },
    merge_queue_entry: { changeRequestNumber: 0, priority: 0 },
    dev_environment: { image: "", cpu: 2, memoryMb: 4096, ttlMinutes: 120 },
    wiki_page: { slug: "home", content: "# Home" },
    page_site: { sourceBranch: "main", sourcePath: "/", customDomain: "" },
    webhook: {
      url: "",
      events: [
        "push",
        "change_review.opened",
        "workflow.completed",
        "package.published",
        "release.published"
      ],
      active: true
    },
    subscription: { events: ["review", "ci", "release"], channel: "inbox" },
    project_field: { fieldType: "text", required: false },
    storage_policy: { lfsEnabled: true, artifactRetentionDays: 30, quotaGb: 10 },
    backup: { kind: "repository", state: "requested" },
    extension: { version: "0.1.0", entrypoint: "", permissions: [] },
    admin_setting: { value: "" },
    code_index: { languages: [], state: "requested" },
    code_owner_rule: { pattern: "/**", owners: [] },
    deployment_policy: { environments: ["staging", "production"], approvals: 1 }
  };
  return payloads[type];
}

export function KoshPlatformWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [resources, setResources] = useState<Resource[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [createdToken, setCreatedToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState("");

  const [resourceType, setResourceType] = useState<ResourceType>("package");
  const [resourceKey, setResourceKey] = useState("");
  const [resourceName, setResourceName] = useState("");
  const [resourcePayload, setResourcePayload] = useState(
    JSON.stringify(defaultPayload("package"), null, 2)
  );

  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [secretEnvironment, setSecretEnvironment] = useState("");

  const [sshTitle, setSshTitle] = useState("");
  const [sshPublicKey, setSshPublicKey] = useState("");

  const [tokenName, setTokenName] = useState("");
  const [tokenScopes, setTokenScopes] = useState("repo:read,repo:write");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState("code");
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() ?? "");
    setSlug(params.get("slug")?.trim() ?? "");
  }, []);

  const repositoryBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug)
    );
  }, [base, namespace, slug]);

  const platformBase = repositoryBase ? repositoryBase + "/platform" : "";

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
      method: "POST" | "PATCH" | "DELETE",
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
    if (!platformBase) return;
    setLoading(true);
    setError("");
    try {
      const [nextSummary, resourcePayloadResponse, keyPayload, tokenPayload] =
        await Promise.all([
          fetchJson<Summary>(platformBase + "/summary"),
          fetchJson<{ resources: Resource[] }>(platformBase + "/resources"),
          fetchJson<{ keys: SshKey[] }>(base + "/v1/kosh/platform/ssh-keys"),
          fetchJson<{ tokens: ApiToken[] }>(base + "/v1/kosh/platform/tokens")
        ]);
      setSummary(nextSummary);
      setResources(resourcePayloadResponse.resources);
      setSshKeys(keyPayload.keys);
      setTokens(tokenPayload.tokens);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load Kosh Platform."
      );
    } finally {
      setLoading(false);
    }
  }, [base, fetchJson, platformBase]);

  useEffect(() => {
    void load();
  }, [load]);

  function changeResourceType(next: ResourceType) {
    setResourceType(next);
    setResourcePayload(JSON.stringify(defaultPayload(next), null, 2));
    setResourceKey("");
    setResourceName("");
  }

  async function createResource(event: FormEvent) {
    event.preventDefault();
    if (!platformBase || !resourceKey.trim() || !resourceName.trim()) return;
    setMutating(true);
    setError("");
    try {
      const payload = JSON.parse(resourcePayload) as Record<string, unknown>;
      await mutateJson(platformBase + "/resources", "POST", {
        type: resourceType,
        key: resourceKey.trim(),
        name: resourceName.trim(),
        payload
      });
      setResourceKey("");
      setResourceName("");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not create resource."
      );
    } finally {
      setMutating(false);
    }
  }

  async function deleteResource(resource: Resource) {
    if (!platformBase) return;
    setMutating(true);
    try {
      await mutateJson(
        platformBase + "/resources/" + encodeURIComponent(resource.id),
        "DELETE"
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not delete resource."
      );
    } finally {
      setMutating(false);
    }
  }

  async function saveSecret() {
    if (!platformBase || !secretName.trim() || !secretValue) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(platformBase + "/secrets", "POST", {
        name: secretName.trim().toUpperCase(),
        value: secretValue,
        environmentName: secretEnvironment.trim() || null
      });
      setSecretName("");
      setSecretValue("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save secret.");
    } finally {
      setMutating(false);
    }
  }

  async function deleteSecret(secret: Secret) {
    if (!platformBase) return;
    setMutating(true);
    try {
      await mutateJson(
        platformBase + "/secrets/" + encodeURIComponent(secret.id),
        "DELETE"
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not delete secret."
      );
    } finally {
      setMutating(false);
    }
  }

  async function addSshKey() {
    if (!sshTitle.trim() || !sshPublicKey.trim()) return;
    setMutating(true);
    setError("");
    try {
      await mutateJson(base + "/v1/kosh/platform/ssh-keys", "POST", {
        title: sshTitle.trim(),
        publicKey: sshPublicKey.trim()
      });
      setSshTitle("");
      setSshPublicKey("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not add SSH key.");
    } finally {
      setMutating(false);
    }
  }

  async function deleteSshKey(key: SshKey) {
    setMutating(true);
    setError("");
    try {
      await mutateJson(
        base + "/v1/kosh/platform/ssh-keys/" + encodeURIComponent(key.id),
        "DELETE"
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not remove SSH key."
      );
    } finally {
      setMutating(false);
    }
  }

  async function createToken() {
    if (!tokenName.trim()) return;
    setMutating(true);
    setError("");
    try {
      const result = await mutateJson<{ token: string; record: ApiToken }>(
        base + "/v1/kosh/platform/tokens",
        "POST",
        {
          name: tokenName.trim(),
          scopes: tokenScopes
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        }
      );
      setCreatedToken(result.token);
      setTokenName("");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not create API token."
      );
    } finally {
      setMutating(false);
    }
  }

  async function search() {
    if (!platformBase || searchQuery.trim().length < 2) return;
    setMutating(true);
    setError("");
    try {
      const result = await fetchJson<SearchResult>(
        platformBase +
          "/search?q=" +
          encodeURIComponent(searchQuery.trim()) +
          "&mode=" +
          encodeURIComponent(searchMode)
      );
      setSearchResult(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Search failed.");
    } finally {
      setMutating(false);
    }
  }

  if (loading && !summary) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Platform</strong>
        <span>Loading platform services…</span>
      </main>
    );
  }

  if (!summary) {
    return (
      <main className={styles.loading}>
        <strong>Platform unavailable</strong>
        <span>{error || "Kosh could not open this repository platform."}</span>
        <Link href={repositoryHref}>Back to repository</Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH PLATFORM</p>
          <h1>{summary.repository.name}</h1>
          <span>
            Packages, security, search, credentials, documentation, storage and
            extension foundations in one control plane.
          </span>
        </div>
        <div className={styles.headerStats}>
          <div>
            <strong>{resources.length}</strong>
            <span>platform resources</span>
          </div>
          <div>
            <strong>{summary.secrets.length}</strong>
            <span>encrypted secrets</span>
          </div>
          <div>
            <strong>
              {koshModules.filter((module) => module.status === "active").length}
            </strong>
            <span>active modules</span>
          </div>
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}

        <section className={styles.moduleGrid}>
          {koshModules.map((module) => (
            <article key={module.id}>
              <span className={styles[module.status]}>{module.status}</span>
              <strong>{module.name}</strong>
              <p>{module.description}</p>
            </article>
          ))}
        </section>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Git-native search</strong>
                <span>Code, paths and commit messages</span>
              </div>
            </div>
            <div className={styles.searchForm}>
              <select
                value={searchMode}
                onChange={(event) => setSearchMode(event.target.value)}
              >
                <option value="code">Code</option>
                <option value="paths">Paths</option>
                <option value="commits">Commits</option>
              </select>
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search repository"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void search();
                }}
              />
              <button
                className={styles.primary}
                disabled={mutating || searchQuery.trim().length < 2}
                onClick={() => void search()}
              >
                Search
              </button>
            </div>
            <div className={styles.searchResults}>
              {searchResult?.results.map((result, index) => (
                <pre key={index}>{JSON.stringify(result, null, 2)}</pre>
              ))}
              {searchResult && !searchResult.results.length && (
                <div className={styles.empty}>No matches.</div>
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Create platform resource</strong>
                <span>Shared control plane for the remaining Kosh modules</span>
              </div>
            </div>
            <form className={styles.resourceForm} onSubmit={createResource}>
              <label>
                <span>Type</span>
                <select
                  value={resourceType}
                  onChange={(event) =>
                    changeResourceType(event.target.value as ResourceType)
                  }
                >
                  {resourceOptions.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Key</span>
                <input
                  value={resourceKey}
                  onChange={(event) => setResourceKey(event.target.value)}
                  placeholder="stable identifier"
                />
              </label>
              <label className={styles.wide}>
                <span>Name</span>
                <input
                  value={resourceName}
                  onChange={(event) => setResourceName(event.target.value)}
                  placeholder="Display name"
                />
              </label>
              <label className={styles.wide}>
                <span>Configuration</span>
                <textarea
                  value={resourcePayload}
                  onChange={(event) => setResourcePayload(event.target.value)}
                  spellCheck={false}
                />
              </label>
              <button
                className={styles.primary}
                disabled={
                  mutating || !resourceKey.trim() || !resourceName.trim()
                }
              >
                Create resource
              </button>
            </form>
          </section>
        </div>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <strong>Repository platform resources</strong>
              <span>{resources.length} persisted resources</span>
            </div>
          </div>
          <div className={styles.resourceList}>
            {resources.map((resource) => (
              <article key={resource.id}>
                <div>
                  <span>{resource.type}</span>
                  <strong>{resource.name}</strong>
                  <small>
                    {resource.key} · {resource.state} · {age(resource.updatedAt)}
                  </small>
                </div>
                <code>{JSON.stringify(resource.payload)}</code>
                <button
                  className={styles.danger}
                  disabled={mutating}
                  onClick={() => void deleteResource(resource)}
                >
                  Delete
                </button>
              </article>
            ))}
            {!resources.length && (
              <div className={styles.empty}>No platform resources yet.</div>
            )}
          </div>
        </section>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Encrypted secrets</strong>
                <span>Values are never returned after storage</span>
              </div>
            </div>
            <div className={styles.secretForm}>
              <input
                value={secretName}
                onChange={(event) => setSecretName(event.target.value)}
                placeholder="API_KEY"
              />
              <input
                value={secretEnvironment}
                onChange={(event) => setSecretEnvironment(event.target.value)}
                placeholder="environment (optional)"
              />
              <input
                type="password"
                value={secretValue}
                onChange={(event) => setSecretValue(event.target.value)}
                placeholder="secret value"
              />
              <button
                className={styles.primary}
                disabled={mutating || !secretName.trim() || !secretValue}
                onClick={() => void saveSecret()}
              >
                Save secret
              </button>
            </div>
            {summary.secrets.map((secret) => (
              <article className={styles.credentialRow} key={secret.id}>
                <div>
                  <strong>{secret.name}</strong>
                  <span>
                    {secret.environmentName || "repository"} ·{" "}
                    {age(secret.updatedAt)}
                  </span>
                </div>
                <button
                  className={styles.danger}
                  onClick={() => void deleteSecret(secret)}
                >
                  Delete
                </button>
              </article>
            ))}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>SSH keys</strong>
                <span>Public keys and fingerprints</span>
              </div>
            </div>
            <div className={styles.stackForm}>
              <input
                value={sshTitle}
                onChange={(event) => setSshTitle(event.target.value)}
                placeholder="Laptop"
              />
              <textarea
                value={sshPublicKey}
                onChange={(event) => setSshPublicKey(event.target.value)}
                placeholder="ssh-ed25519 AAAA…"
              />
              <button
                className={styles.primary}
                disabled={mutating || !sshTitle.trim() || !sshPublicKey.trim()}
                onClick={() => void addSshKey()}
              >
                Add SSH key
              </button>
            </div>
            {sshKeys.map((key) => (
              <article className={styles.credentialRow} key={key.id}>
                <div>
                  <strong>{key.title}</strong>
                  <span>{key.fingerprint}</span>
                  <span>
                    Last used: {key.lastUsedAt ? age(key.lastUsedAt) : "never"}
                  </span>
                </div>
                <button
                  className={styles.danger}
                  disabled={mutating}
                  onClick={() => void deleteSshKey(key)}
                >
                  Remove
                </button>
              </article>
            ))}
          </section>
        </div>

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>API tokens</strong>
                <span>Hashed at rest; plaintext shown only once</span>
              </div>
            </div>
            <div className={styles.stackForm}>
              <input
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                placeholder="CLI token"
              />
              <input
                value={tokenScopes}
                onChange={(event) => setTokenScopes(event.target.value)}
                placeholder="repo:read,repo:write"
              />
              <button
                className={styles.primary}
                disabled={mutating || !tokenName.trim()}
                onClick={() => void createToken()}
              >
                Create token
              </button>
              {createdToken && (
                <div className={styles.tokenReveal}>
                  <strong>Copy this token now</strong>
                  <code>{createdToken}</code>
                  <span>It cannot be displayed again.</span>
                </div>
              )}
            </div>
            {tokens.map((token) => (
              <article className={styles.credentialRow} key={token.id}>
                <div>
                  <strong>{token.name}</strong>
                  <span>
                    {token.tokenPrefix}… · {token.scopes.join(", ")}
                  </span>
                </div>
              </article>
            ))}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Audit trail</strong>
                <span>Recent repository control-plane changes</span>
              </div>
            </div>
            <div className={styles.auditList}>
              {summary.recentAudit.map((event) => (
                <article key={event.id}>
                  <span>{event.actorName}</span>
                  <strong>{event.eventType.replace(/_/g, " ")}</strong>
                  <em>{age(event.createdAt)}</em>
                </article>
              ))}
              {!summary.recentAudit.length && (
                <div className={styles.empty}>No audited changes yet.</div>
              )}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
