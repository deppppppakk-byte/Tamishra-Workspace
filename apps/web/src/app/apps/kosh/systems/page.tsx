"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./systems.module.css";

type Resource = {
  id: string;
  name: string;
  state: string;
  key: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

type ProjectsPayload = {
  projects: Resource[];
  fields: Resource[];
  iterations: Resource[];
  items: Resource[];
};

type DeploymentRecord = {
  id: string;
  environmentName: string;
  refName: string;
  commitSha: string;
  status: string;
};

type DeploymentPayload = {
  policies: Resource[];
  requests: Resource[];
  environments: Array<{ id: string; name: string; requiredApprovals: number }>;
  deployments: DeploymentRecord[];
};

type StoragePayload = {
  policy: Resource | null;
  adapter: string;
  usage: {
    knownBytes: number;
    packageBytes: number;
    releaseBytes: number;
    artifactBytes: number;
    backupBytes: number;
    packageVersions: number;
    releaseAssets: number;
    artifacts: number;
    backups: number;
  };
};

type RecoveryPayload = {
  backups: Resource[];
  keepCount: number;
  staged: number;
  verified: number;
};

type QueuePayload = {
  entries: Resource[];
  counts: Record<string, number>;
  processEndpoint: string;
};

type AdminPayload = {
  settings: Resource[];
  allowedSettings: string[];
  runtime: Record<string, unknown>;
};

type GlobalExtensionsPayload = {
  extensions: Resource[];
  capabilities: string[];
  permissions: string[];
  runtime: string;
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return size.toFixed(index > 1 ? 1 : 0) + " " + units[index];
}

function shortSha(value: unknown) {
  const sha = String(value ?? "");
  return sha ? sha.slice(0, 10) : "—";
}

function settingValue(admin: AdminPayload | null, key: string) {
  const item = admin?.settings.find((setting) => setting.key === key);
  return item?.payload?.value;
}

export default function KoshSystemsPage() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [queue, setQueue] = useState<QueuePayload | null>(null);
  const [projects, setProjects] = useState<ProjectsPayload | null>(null);
  const [deployments, setDeployments] = useState<DeploymentPayload | null>(null);
  const [storage, setStorage] = useState<StoragePayload | null>(null);
  const [recovery, setRecovery] = useState<RecoveryPayload | null>(null);
  const [observability, setObservability] = useState<Record<string, unknown> | null>(null);
  const [admin, setAdmin] = useState<AdminPayload | null>(null);
  const [extensions, setExtensions] = useState<GlobalExtensionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");
  const [projectName, setProjectName] = useState("");
  const [environmentName, setEnvironmentName] = useState("production");
  const [releaseId, setReleaseId] = useState("");
  const [storageQuotaGb, setStorageQuotaGb] = useState("50");
  const [extensionManifest, setExtensionManifest] = useState(
    JSON.stringify(
      {
        id: "tamishra.sample",
        name: "Sample Kosh extension",
        version: "1.0.0",
        runtime: "declarative",
        capabilities: ["project-panel"],
        permissions: ["repository.read"],
        assetKinds: []
      },
      null,
      2
    )
  );

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace") ?? "");
    setSlug(params.get("slug") ?? "");
  }, []);

  const repoRoot = namespace && slug
    ? `/v1/kosh/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`
    : "";

  const apiRequest = useCallback(async <T,>(path: string, options?: RequestInit) => {
    const response = await fetch(base + path, {
      credentials: "include",
      cache: "no-store",
      ...options,
      headers: {
        ...(options?.body ? { "content-type": "application/json" } : {}),
        ...(options?.headers ?? {})
      }
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as T & { error?: string } : ({} as T & { error?: string });
    if (!response.ok) {
      throw new Error(payload.error || `Kosh returned ${response.status}.`);
    }
    return payload as T;
  }, [base]);

  const load = useCallback(async () => {
    if (!repoRoot) return;
    setLoading(true);
    setError("");
    try {
      const [queueData, projectsData, deploymentsData, storageData, recoveryData, observabilityData] =
        await Promise.all([
          apiRequest<QueuePayload>(repoRoot + "/systems/merge-queue"),
          apiRequest<ProjectsPayload>(repoRoot + "/systems/projects"),
          apiRequest<DeploymentPayload>(repoRoot + "/systems/deployments"),
          apiRequest<StoragePayload>(repoRoot + "/systems/storage"),
          apiRequest<RecoveryPayload>(repoRoot + "/systems/recovery"),
          apiRequest<Record<string, unknown>>(repoRoot + "/systems/observability")
        ]);
      setQueue(queueData);
      setProjects(projectsData);
      setDeployments(deploymentsData);
      setStorage(storageData);
      setRecovery(recoveryData);
      setObservability(observabilityData);

      const [adminResult, extensionResult] = await Promise.allSettled([
        apiRequest<AdminPayload>("/v1/kosh/systems/admin"),
        apiRequest<GlobalExtensionsPayload>("/v1/kosh/systems/extensions")
      ]);
      setAdmin(adminResult.status === "fulfilled" ? adminResult.value : null);
      setExtensions(extensionResult.status === "fulfilled" ? extensionResult.value : null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh systems.");
    } finally {
      setLoading(false);
    }
  }, [repoRoot, apiRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runAction(label: string, action: () => Promise<unknown>) {
    setWorking(label);
    setError("");
    try {
      await action();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `${label} failed.`);
    } finally {
      setWorking("");
    }
  }

  function promptText(message: string, initial = "") {
    const value = window.prompt(message, initial);
    return value == null ? null : value.trim();
  }

  async function updateQueueEntry(entry: Resource, action?: "pause" | "resume" | "cancel") {
    const body: Record<string, unknown> = action ? { action } : {};
    if (!action) {
      const value = promptText("Priority from -1000 to 1000", String(entry.payload.priority ?? 0));
      if (value == null || value === "") return;
      const priority = Number(value);
      if (!Number.isFinite(priority)) {
        setError("Priority must be a number.");
        return;
      }
      body.priority = priority;
    }
    await runAction(action ? `${action} merge entry` : "Updating merge priority", () =>
      apiRequest(repoRoot + "/systems/merge-queue/" + entry.id, {
        method: "PATCH",
        body: JSON.stringify(body)
      })
    );
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!projectName.trim()) return;
    await runAction("Creating project", async () => {
      await apiRequest(repoRoot + "/systems/projects", {
        method: "POST",
        body: JSON.stringify({ name: projectName.trim() })
      });
      setProjectName("");
    });
  }

  async function addProjectField(project: Resource) {
    const name = promptText("Custom field name");
    if (!name) return;
    const fieldType = promptText("Field type: text, number, date, single_select, multi_select, boolean", "text");
    if (!fieldType) return;
    const optionsText = ["single_select", "multi_select"].includes(fieldType)
      ? promptText("Comma-separated options", "")
      : "";
    await runAction("Creating project field", () =>
      apiRequest(repoRoot + `/systems/projects/${project.id}/fields`, {
        method: "POST",
        body: JSON.stringify({
          name,
          fieldType,
          options: optionsText ? optionsText.split(",").map((item) => item.trim()).filter(Boolean) : []
        })
      })
    );
  }

  async function addIteration(project: Resource) {
    const name = promptText("Iteration name");
    if (!name) return;
    const startDate = promptText("Start date (YYYY-MM-DD)", new Date().toISOString().slice(0, 10));
    if (startDate == null) return;
    const endDate = promptText("End date (YYYY-MM-DD)", "");
    if (endDate == null) return;
    const goal = promptText("Iteration goal", "") ?? "";
    await runAction("Creating iteration", () =>
      apiRequest(repoRoot + `/systems/projects/${project.id}/iterations`, {
        method: "POST",
        body: JSON.stringify({ name, startDate, endDate, goal, status: "planned" })
      })
    );
  }

  async function addProjectItem(project: Resource) {
    const title = promptText("Planning item title");
    if (!title) return;
    const itemType = promptText("Item type: issue, change_request, note", "note") || "note";
    const reference = itemType === "note" ? "" : (promptText("Reference number or identifier", "") ?? "");
    const projectIterations = (projects?.iterations ?? []).filter(
      (iteration) => iteration.payload.projectId === project.id
    );
    const iterationId = projectIterations.length
      ? promptText("Iteration ID (optional)", projectIterations[0].id) ?? ""
      : "";
    await runAction("Creating planning item", () =>
      apiRequest(repoRoot + `/systems/projects/${project.id}/items`, {
        method: "POST",
        body: JSON.stringify({ title, itemType, reference, iterationId, status: "todo" })
      })
    );
  }

  async function cycleItem(item: Resource) {
    const status = String(item.payload.status ?? item.state ?? "todo");
    const next = status === "todo" ? "in_progress" : status === "in_progress" ? "done" : "todo";
    await runAction("Updating planning item", () =>
      apiRequest(repoRoot + "/systems/projects/resources/" + item.id, {
        method: "PATCH",
        body: JSON.stringify({ payload: { status: next } })
      })
    );
  }

  async function saveDeploymentPolicy() {
    await runAction("Saving deployment policy", () =>
      apiRequest(repoRoot + "/systems/deployments/policies/" + encodeURIComponent(environmentName), {
        method: "PUT",
        body: JSON.stringify({
          requiredApprovals: environmentName === "production" ? 1 : 0,
          protectedBranches: ["main"],
          retentionDays: 90
        })
      })
    );
  }

  async function createDeploymentRequest() {
    if (!releaseId.trim()) {
      setError("Enter a published Kosh release ID first.");
      return;
    }
    await runAction("Creating deployment request", () =>
      apiRequest(repoRoot + "/systems/deployments/requests", {
        method: "POST",
        body: JSON.stringify({ releaseId: releaseId.trim(), environmentName })
      })
    );
  }

  async function createPromotion(source: DeploymentRecord, rollback: boolean) {
    const target = promptText(
      rollback ? "Rollback environment" : "Target environment",
      source.environmentName === "production" ? "staging" : "production"
    );
    if (!target) return;
    await runAction(rollback ? "Creating rollback request" : "Creating promotion request", () =>
      apiRequest(repoRoot + (rollback ? "/systems/deployments/rollback" : "/systems/deployments/promote"), {
        method: "POST",
        body: JSON.stringify(
          rollback
            ? { targetDeploymentId: source.id, environmentName: target }
            : { deploymentId: source.id, targetEnvironmentName: target }
        )
      })
    );
  }

  async function saveStoragePolicy() {
    const gb = Math.max(1, Number(storageQuotaGb) || 50);
    await runAction("Saving storage policy", () =>
      apiRequest(repoRoot + "/systems/storage/policy", {
        method: "PUT",
        body: JSON.stringify({ maxTotalBytes: Math.floor(gb * 1024 ** 3) })
      })
    );
  }

  async function saveAdminSetting(key: string, value: unknown) {
    await runAction("Saving " + key, () =>
      apiRequest("/v1/kosh/systems/admin/settings/" + encodeURIComponent(key), {
        method: "PUT",
        body: JSON.stringify({ value })
      })
    );
  }

  async function editAdminSetting(key: string) {
    const current = settingValue(admin, key);
    let defaultValue = current == null ? "" : String(current);
    if (key === "default_storage_quota_bytes" && typeof current === "number") {
      defaultValue = String(Math.round(current / 1024 ** 3));
    }
    const value = promptText(
      key === "default_storage_quota_bytes" ? "Default repository quota in GB" : `Value for ${key}`,
      defaultValue
    );
    if (value == null) return;
    if (key === "backup_keep_count") {
      await saveAdminSetting(key, Number(value));
    } else if (key === "default_storage_quota_bytes") {
      await saveAdminSetting(key, Math.floor((Number(value) || 50) * 1024 ** 3));
    } else {
      await saveAdminSetting(key, value);
    }
  }

  async function registerExtension() {
    await runAction("Registering extension", async () => {
      const manifest = JSON.parse(extensionManifest) as Record<string, unknown>;
      await apiRequest("/v1/kosh/systems/extensions", {
        method: "POST",
        body: JSON.stringify({ manifest, enable: false })
      });
    });
  }

  if (!namespace || !slug) {
    return (
      <main className={styles.shell}>
        <div className={styles.empty}>
          <strong>Repository context required</strong>
          <p>Open Systems from a Kosh repository so the control plane has a namespace and repository slug.</p>
          <Link href="/apps/kosh">Back to Kosh</Link>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <Link href="/apps/kosh" className={styles.back}>← Kosh</Link>
          <p className={styles.eyebrow}>KOSH SYSTEMS</p>
          <h1>{namespace}/{slug}</h1>
          <p>Eight native control planes for merge, planning, delivery, storage, recovery, operations, administration and extensions.</p>
        </div>
        <button className={styles.secondary} onClick={() => void load()} disabled={loading || Boolean(working)}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>

      {error && <div className={styles.error}>{error}</div>}
      {working && <div className={styles.working}>{working}…</div>}

      <section className={styles.grid}>
        <article className={styles.card}>
          <div className={styles.cardHead}><span>01</span><h2>Merge Queue</h2></div>
          <p>Validated sequencing with pause, resume, cancellation and bounded priority control.</p>
          <div className={styles.metrics}>
            <strong>{queue?.counts?.queued ?? 0}<small>queued</small></strong>
            <strong>{queue?.counts?.blocked ?? 0}<small>blocked</small></strong>
            <strong>{queue?.counts?.merged ?? 0}<small>merged</small></strong>
          </div>
          <button className={styles.primary} onClick={() => void runAction("Processing merge queue", () => apiRequest(repoRoot + "/merge-queue/process", { method: "POST", body: "{}" }))}>Process queue</button>
          <div className={styles.rows}>
            {(queue?.entries ?? []).slice(0, 8).map((entry) => (
              <div className={styles.row} key={entry.id}>
                <span><b>{entry.name}</b><small>{entry.state} · priority {String(entry.payload.priority ?? 0)}</small></span>
                <div className={styles.rowActions}>
                  {!['merged', 'processing', 'cancelled'].includes(entry.state) && <button onClick={() => void updateQueueEntry(entry)}>Priority</button>}
                  {entry.state === 'queued' && <button onClick={() => void updateQueueEntry(entry, 'pause')}>Pause</button>}
                  {entry.state === 'blocked' && <button onClick={() => void updateQueueEntry(entry, 'resume')}>Resume</button>}
                  {!['merged', 'processing', 'cancelled'].includes(entry.state) && <button className={styles.danger} onClick={() => void updateQueueEntry(entry, 'cancel')}>Cancel</button>}
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.card}>
          <div className={styles.cardHead}><span>02</span><h2>Projects</h2></div>
          <p>Roadmaps with iterations, custom fields and linked issue/change-request planning items.</p>
          <div className={styles.metrics}>
            <strong>{projects?.projects.length ?? 0}<small>projects</small></strong>
            <strong>{projects?.iterations.length ?? 0}<small>iterations</small></strong>
            <strong>{projects?.items.length ?? 0}<small>items</small></strong>
          </div>
          <form className={styles.inlineForm} onSubmit={createProject}>
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Roadmap project name" />
            <button className={styles.primary} type="submit">Create</button>
          </form>
          <div className={styles.rows}>
            {(projects?.projects ?? []).slice(0, 6).map((project) => {
              const fieldCount = (projects?.fields ?? []).filter((item) => item.payload.projectId === project.id).length;
              const iterationCount = (projects?.iterations ?? []).filter((item) => item.payload.projectId === project.id).length;
              const itemCount = (projects?.items ?? []).filter((item) => item.payload.projectId === project.id).length;
              return (
                <div className={styles.row} key={project.id}>
                  <span><b>{project.name}</b><small>{project.state} · {fieldCount} fields · {iterationCount} iterations · {itemCount} items</small></span>
                  <div className={styles.rowActions}>
                    <button onClick={() => void addProjectField(project)}>Field</button>
                    <button onClick={() => void addIteration(project)}>Iteration</button>
                    <button onClick={() => void addProjectItem(project)}>Item</button>
                  </div>
                </div>
              );
            })}
            {(projects?.items ?? []).slice(0, 6).map((item) => (
              <div className={styles.row} key={item.id}>
                <span><b>{item.name}</b><small>{String(item.payload.itemType ?? 'note')} · {String(item.payload.status ?? item.state)}</small></span>
                <button onClick={() => void cycleItem(item)}>Advance</button>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.card}>
          <div className={styles.cardHead}><span>03</span><h2>Deployments</h2></div>
          <p>Environment policy, approvals, release execution, promotion and rollback.</p>
          <div className={styles.metrics}>
            <strong>{deployments?.environments.length ?? 0}<small>environments</small></strong>
            <strong>{deployments?.requests.length ?? 0}<small>requests</small></strong>
            <strong>{deployments?.deployments.length ?? 0}<small>deployments</small></strong>
          </div>
          <div className={styles.inlineForm}>
            <input value={environmentName} onChange={(event) => setEnvironmentName(event.target.value)} placeholder="production" />
            <button className={styles.secondary} onClick={() => void saveDeploymentPolicy()}>Save policy</button>
          </div>
          <div className={styles.inlineForm}>
            <input value={releaseId} onChange={(event) => setReleaseId(event.target.value)} placeholder="Published release ID" />
            <button className={styles.primary} onClick={() => void createDeploymentRequest()}>Request</button>
          </div>
          <div className={styles.rows}>
            {(deployments?.requests ?? []).slice(0, 6).map((requestItem) => (
              <div className={styles.row} key={requestItem.id}>
                <span><b>{requestItem.name}</b><small>{requestItem.state} · {shortSha(requestItem.payload.commitSha)}</small></span>
                <div className={styles.rowActions}>
                  {requestItem.state === "pending_approval" && <button onClick={() => void runAction("Approving deployment", () => apiRequest(repoRoot + "/systems/deployments/requests/" + requestItem.id + "/approve", { method: "POST", body: "{}" }))}>Approve</button>}
                  {requestItem.state === "ready" && <button onClick={() => void runAction("Starting deployment", () => apiRequest(repoRoot + "/systems/deployments/requests/" + requestItem.id + "/execute", { method: "POST", body: "{}" }))}>Execute</button>}
                </div>
              </div>
            ))}
            {(deployments?.deployments ?? []).filter((item) => item.status === "success").slice(0, 6).map((deployment) => (
              <div className={styles.row} key={deployment.id}>
                <span><b>{deployment.environmentName}</b><small>{shortSha(deployment.commitSha)} · successful</small></span>
                <div className={styles.rowActions}>
                  <button onClick={() => void createPromotion(deployment, false)}>Promote</button>
                  <button onClick={() => void createPromotion(deployment, true)}>Rollback</button>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.card}>
          <div className={styles.cardHead}><span>04</span><h2>Storage</h2></div>
          <p>Repository quota policy and persistent-storage accounting without guessing unknown bytes.</p>
          <div className={styles.metrics}>
            <strong>{bytes(storage?.usage.knownBytes ?? 0)}<small>known usage</small></strong>
            <strong>{storage?.usage.packageVersions ?? 0}<small>packages</small></strong>
            <strong>{storage?.usage.backups ?? 0}<small>backups</small></strong>
          </div>
          <div className={styles.inlineForm}>
            <input type="number" min="1" value={storageQuotaGb} onChange={(event) => setStorageQuotaGb(event.target.value)} />
            <span className={styles.unit}>GB quota</span>
            <button className={styles.primary} onClick={() => void saveStoragePolicy()}>Save</button>
          </div>
          <dl className={styles.breakdown}>
            <div><dt>Packages</dt><dd>{bytes(storage?.usage.packageBytes ?? 0)}</dd></div>
            <div><dt>Release assets</dt><dd>{bytes(storage?.usage.releaseBytes ?? 0)}</dd></div>
            <div><dt>Artifacts</dt><dd>{bytes(storage?.usage.artifactBytes ?? 0)}</dd></div>
            <div><dt>Restore points</dt><dd>{bytes(storage?.usage.backupBytes ?? 0)}</dd></div>
          </dl>
        </article>

        <article className={styles.card}>
          <div className={styles.cardHead}><span>05</span><h2>Recovery</h2></div>
          <p>Verified Git restore points with staging before destructive activation.</p>
          <div className={styles.metrics}>
            <strong>{recovery?.backups.length ?? 0}<small>restore points</small></strong>
            <strong>{recovery?.verified ?? 0}<small>verified</small></strong>
            <strong>{recovery?.staged ?? 0}<small>staged</small></strong>
          </div>
          <button className={styles.primary} onClick={() => void runAction("Creating restore point", () => apiRequest(repoRoot + "/systems/recovery/backups", { method: "POST", body: JSON.stringify({ reason: "manual" }) }))}>Create restore point</button>
          <div className={styles.rows}>
            {(recovery?.backups ?? []).slice(0, 5).map((backup) => (
              <div className={styles.row} key={backup.id}>
                <span><b>{backup.name}</b><small>{bytes(Number(backup.payload.sizeBytes) || 0)} · {backup.state}</small></span>
                <div className={styles.rowActions}>
                  <button onClick={() => void runAction("Verifying restore point", () => apiRequest(repoRoot + "/systems/recovery/backups/" + backup.id + "/verify", { method: "POST", body: "{}" }))}>Verify</button>
                  <button onClick={() => void runAction("Staging restore", () => apiRequest(repoRoot + "/systems/recovery/backups/" + backup.id + "/stage", { method: "POST", body: "{}" }))}>Stage</button>
                  {backup.payload.staged === true && <button className={styles.danger} onClick={() => {
                    const confirmValue = window.prompt(`Type ${namespace}/${slug} to activate this restore:`);
                    if (confirmValue) void runAction("Activating restore", () => apiRequest(repoRoot + "/systems/recovery/backups/" + backup.id + "/activate", { method: "POST", body: JSON.stringify({ confirm: confirmValue }) }));
                  }}>Activate</button>}
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className={styles.card}>
          <div className={styles.cardHead}><span>06</span><h2>Observability</h2></div>
          <p>Operational evidence over automation, deployment, storage, resources and audit state.</p>
          <pre className={styles.code}>{JSON.stringify(observability, null, 2).slice(0, 5000)}</pre>
        </article>

        <article className={styles.card}>
          <div className={styles.cardHead}><span>07</span><h2>Administration</h2></div>
          <p>Audited global settings plus non-secret runtime posture. Controls appear only for platform administrators.</p>
          {admin ? (
            <>
              <div className={styles.rows}>
                {admin.allowedSettings.map((key) => (
                  <div className={styles.row} key={key}>
                    <span><b>{key}</b><small>{String(settingValue(admin, key) ?? "default")}</small></span>
                    <button onClick={() => void editAdminSetting(key)}>Edit</button>
                  </div>
                ))}
              </div>
              <pre className={styles.code}>{JSON.stringify(admin.runtime, null, 2).slice(0, 3000)}</pre>
            </>
          ) : (
            <div className={styles.restricted}>Administrator access required.</div>
          )}
        </article>

        <article className={styles.card}>
          <div className={styles.cardHead}><span>08</span><h2>Extension SDK</h2></div>
          <p>Declarative, versioned manifests with explicit capabilities, permissions and controlled activation.</p>
          <textarea value={extensionManifest} onChange={(event) => setExtensionManifest(event.target.value)} rows={10} spellCheck={false} />
          <button className={styles.primary} disabled={!extensions} onClick={() => void registerExtension()}>Register disabled</button>
          <div className={styles.rows}>
            {(extensions?.extensions ?? []).slice(0, 8).map((extension) => (
              <div className={styles.row} key={extension.id}>
                <span><b>{extension.name}</b><small>{extension.key} · {extension.state}</small></span>
                <button onClick={() => void runAction("Changing extension state", () => apiRequest("/v1/kosh/systems/extensions/" + extension.id, { method: "PATCH", body: JSON.stringify({ enabled: extension.state !== "enabled" }) }))}>{extension.state === "enabled" ? "Disable" : "Enable"}</button>
              </div>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}
