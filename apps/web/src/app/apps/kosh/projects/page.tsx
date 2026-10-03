"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./projects.module.css";

type ProjectKind = "project" | "iteration" | "field" | "item";
type ProjectResource = {
  id: string;
  name: string;
  state: string;
  payload: Record<string, unknown> & { kind?: ProjectKind; projectId?: string };
  createdAt: string;
  updatedAt: string;
};

type ProjectPayload = {
  projects: ProjectResource[];
  iterations: ProjectResource[];
  fields: ProjectResource[];
  items: ProjectResource[];
};

type Tab = "board" | "iterations" | "fields" | "roadmap";

const projectStates = ["active", "paused", "completed", "archived"];
const itemStates = ["todo", "in_progress", "blocked", "done"];
const iterationStates = ["planned", "active", "completed"];
const fieldTypes = ["text", "number", "date", "single_select", "multi_select", "boolean"];

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function prettyStatus(value: string) {
  return value.replace(/_/g, " ");
}

function dateLabel(value: unknown) {
  const source = text(value);
  if (!source) return "Not set";
  const date = new Date(source);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString() : source;
}

export default function ProjectsPage() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [data, setData] = useState<ProjectPayload>({ projects: [], iterations: [], fields: [], items: [] });
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<Tab>("board");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [projectOwner, setProjectOwner] = useState("");
  const [projectDueDate, setProjectDueDate] = useState("");
  const [childName, setChildName] = useState("");
  const [childKind, setChildKind] = useState<"items" | "iterations" | "fields">("items");
  const [childStatus, setChildStatus] = useState("todo");
  const [fieldType, setFieldType] = useState("text");
  const [fieldOptions, setFieldOptions] = useState("");
  const [iterationStart, setIterationStart] = useState("");
  const [iterationEnd, setIterationEnd] = useState("");
  const [iterationGoal, setIterationGoal] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() || "");
    setSlug(params.get("slug")?.trim() || "");
  }, []);

  const endpoint = useMemo(() => {
    if (!namespace || !slug) return "";
    return `${base}/v1/kosh/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}/systems/projects`;
  }, [base, namespace, slug]);

  const request = useCallback(async <T,>(url: string, init?: RequestInit) => {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      ...init,
      headers: init?.body === undefined
        ? init?.headers
        : { "content-type": "application/json", ...(init?.headers || {}) }
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || "Kosh Projects request failed.");
    return payload;
  }, []);

  const load = useCallback(async (preferredId?: string) => {
    if (!endpoint) return;
    setLoading(true);
    setError("");
    try {
      const payload = await request<ProjectPayload>(endpoint);
      const normalized = {
        projects: payload.projects || [],
        iterations: payload.iterations || [],
        fields: payload.fields || [],
        items: payload.items || []
      };
      setData(normalized);
      setSelectedId((current) => {
        const requested = preferredId || current;
        return normalized.projects.some((project) => project.id === requested)
          ? requested
          : normalized.projects[0]?.id || "";
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load projects.");
    } finally {
      setLoading(false);
    }
  }, [endpoint, request]);

  useEffect(() => {
    if (endpoint) void load();
  }, [endpoint, load]);

  const selected = data.projects.find((project) => project.id === selectedId) || null;
  const projectItems = data.items.filter((item) => item.payload.projectId === selectedId);
  const projectIterations = data.iterations.filter((item) => item.payload.projectId === selectedId);
  const projectFields = data.fields.filter((item) => item.payload.projectId === selectedId);

  const progress = useMemo(() => {
    if (!projectItems.length) return 0;
    const done = projectItems.filter((item) => text(item.payload.status) === "done").length;
    return Math.round((done / projectItems.length) * 100);
  }, [projectItems]);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!endpoint || !projectName.trim()) return;
    setBusy(true);
    setError("");
    try {
      const created = await request<ProjectResource>(endpoint, {
        method: "POST",
        body: JSON.stringify({
          name: projectName.trim(),
          description: projectDescription.trim(),
          owner: projectOwner.trim() || null,
          dueDate: projectDueDate || null,
          status: "active"
        })
      });
      setProjectName("");
      setProjectDescription("");
      setProjectOwner("");
      setProjectDueDate("");
      setNewProjectOpen(false);
      await load(created.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create project.");
    } finally {
      setBusy(false);
    }
  }

  async function patchResource(resource: ProjectResource, patch: Record<string, unknown>) {
    if (!endpoint) return;
    setBusy(true);
    setError("");
    try {
      await request(`${endpoint}/resources/${encodeURIComponent(resource.id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch)
      });
      await load(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update project resource.");
    } finally {
      setBusy(false);
    }
  }

  async function createChild(event: FormEvent) {
    event.preventDefault();
    if (!endpoint || !selected || !childName.trim()) return;
    if (childKind === "iterations" && iterationStart && iterationEnd && new Date(iterationEnd) < new Date(iterationStart)) {
      setError("Iteration end date must be on or after its start date.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = { name: childName.trim() };
      if (childKind === "items") {
        body.itemType = "note";
        body.status = childStatus;
      } else if (childKind === "iterations") {
        body.startDate = iterationStart || null;
        body.endDate = iterationEnd || null;
        body.goal = iterationGoal.trim();
        body.status = childStatus;
      } else {
        body.fieldType = fieldType;
        body.options = fieldOptions.split(",").map((value) => value.trim()).filter(Boolean);
      }
      await request(`${endpoint}/${encodeURIComponent(selected.id)}/${childKind}`, {
        method: "POST",
        body: JSON.stringify(body)
      });
      setChildName("");
      setChildStatus(childKind === "iterations" ? "planned" : "todo");
      setFieldOptions("");
      setIterationStart("");
      setIterationEnd("");
      setIterationGoal("");
      await load(selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create project resource.");
    } finally {
      setBusy(false);
    }
  }

  function chooseChildKind(kind: "items" | "iterations" | "fields") {
    setChildKind(kind);
    setChildStatus(kind === "iterations" ? "planned" : "todo");
  }

  const repositoryHref = namespace && slug
    ? `/apps/kosh/repository?namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(slug)}`
    : "/apps/kosh";

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <Link className={styles.back} href={repositoryHref}>← Repository</Link>
        <div className={styles.brand}>
          <span>K</span>
          <div><strong>Projects</strong><small>{namespace && slug ? `${namespace}/${slug}` : "Kosh"}</small></div>
        </div>
        <button className={styles.createProject} onClick={() => setNewProjectOpen(true)}>+ New project</button>
        <div className={styles.projectList}>
          {loading && data.projects.length === 0 && <p className={styles.muted}>Loading projects…</p>}
          {!loading && data.projects.length === 0 && <p className={styles.muted}>No projects yet.</p>}
          {data.projects.map((project) => (
            <button
              key={project.id}
              className={selectedId === project.id ? styles.projectActive : styles.projectButton}
              onClick={() => setSelectedId(project.id)}
            >
              <span>{project.name}</span>
              <small>{prettyStatus(project.state)}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.topbar}>
          <div>
            <p className={styles.eyebrow}>KOSH PROJECT COMMAND CENTER</p>
            <h1>{selected?.name || "Project planning"}</h1>
            <p>{selected ? text(selected.payload.description) || "Plan work, iterations and delivery from one native Kosh workspace." : "Create a project to start planning work."}</p>
          </div>
          {selected && (
            <select
              className={styles.statusSelect}
              value={selected.state}
              disabled={busy}
              onChange={(event) => void patchResource(selected, { state: event.target.value })}
            >
              {projectStates.map((state) => <option key={state} value={state}>{prettyStatus(state)}</option>)}
            </select>
          )}
        </header>

        {error && <div className={styles.error}>{error}</div>}

        {newProjectOpen && (
          <form className={styles.modalCard} onSubmit={createProject}>
            <div className={styles.modalHead}><div><p className={styles.eyebrow}>NEW PROJECT</p><h2>Create roadmap container</h2></div><button type="button" onClick={() => setNewProjectOpen(false)}>×</button></div>
            <div className={styles.formGrid}>
              <label>Name<input value={projectName} onChange={(event) => setProjectName(event.target.value)} maxLength={180} required /></label>
              <label>Owner<input value={projectOwner} onChange={(event) => setProjectOwner(event.target.value)} maxLength={160} placeholder="Team or lead" /></label>
              <label>Due date<input type="date" value={projectDueDate} onChange={(event) => setProjectDueDate(event.target.value)} /></label>
              <label className={styles.full}>Description<textarea rows={4} value={projectDescription} onChange={(event) => setProjectDescription(event.target.value)} maxLength={4000} /></label>
            </div>
            <div className={styles.modalActions}><button type="button" className={styles.secondary} onClick={() => setNewProjectOpen(false)}>Cancel</button><button className={styles.primary} disabled={busy || !projectName.trim()}>{busy ? "Creating…" : "Create project"}</button></div>
          </form>
        )}

        {!selected ? (
          <section className={styles.blank}>
            <div className={styles.blankMark}>P</div>
            <h2>Turn repository work into an execution plan.</h2>
            <p>Use native Kosh projects for roadmap containers, iterations, typed fields and linked planning items.</p>
            <button className={styles.primary} onClick={() => setNewProjectOpen(true)}>Create first project</button>
          </section>
        ) : (
          <>
            <section className={styles.metrics}>
              <article><small>Progress</small><strong>{progress}%</strong><span>{projectItems.filter((item) => text(item.payload.status) === "done").length} of {projectItems.length} done</span></article>
              <article><small>Iterations</small><strong>{projectIterations.length}</strong><span>{projectIterations.filter((item) => text(item.payload.status) === "active").length} active</span></article>
              <article><small>Custom fields</small><strong>{projectFields.length}</strong><span>typed metadata</span></article>
              <article><small>Due</small><strong>{dateLabel(selected.payload.dueDate)}</strong><span>{text(selected.payload.owner) || "No owner"}</span></article>
            </section>

            <nav className={styles.tabs}>
              {(["board", "iterations", "fields", "roadmap"] as Tab[]).map((value) => (
                <button key={value} className={tab === value ? styles.tabActive : ""} onClick={() => setTab(value)}>{value[0].toUpperCase() + value.slice(1)}</button>
              ))}
            </nav>

            {tab === "board" && (
              <section className={styles.board}>
                {itemStates.map((state) => (
                  <div className={styles.column} key={state}>
                    <div className={styles.columnHead}><strong>{prettyStatus(state)}</strong><span>{projectItems.filter((item) => text(item.payload.status) === state).length}</span></div>
                    <div className={styles.cards}>
                      {projectItems.filter((item) => text(item.payload.status) === state).map((item) => (
                        <article key={item.id} className={styles.workCard}>
                          <strong>{item.name}</strong>
                          <small>{text(item.payload.itemType) || "note"}</small>
                          <select value={text(item.payload.status) || "todo"} disabled={busy} onChange={(event) => void patchResource(item, { payload: { status: event.target.value } })}>
                            {itemStates.map((value) => <option key={value} value={value}>{prettyStatus(value)}</option>)}
                          </select>
                        </article>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            )}

            {tab === "iterations" && (
              <section className={styles.resourceGrid}>
                {projectIterations.map((iteration) => (
                  <article className={styles.resourceCard} key={iteration.id}>
                    <div><small>{prettyStatus(text(iteration.payload.status) || "planned")}</small><h3>{iteration.name}</h3></div>
                    <p>{text(iteration.payload.goal) || "No goal defined."}</p>
                    <span>{dateLabel(iteration.payload.startDate)} → {dateLabel(iteration.payload.endDate)}</span>
                    <select value={text(iteration.payload.status) || "planned"} disabled={busy} onChange={(event) => void patchResource(iteration, { payload: { status: event.target.value } })}>
                      {iterationStates.map((value) => <option key={value} value={value}>{prettyStatus(value)}</option>)}
                    </select>
                  </article>
                ))}
                {projectIterations.length === 0 && <p className={styles.muted}>No iterations yet.</p>}
              </section>
            )}

            {tab === "fields" && (
              <section className={styles.resourceGrid}>
                {projectFields.map((field) => (
                  <article className={styles.resourceCard} key={field.id}>
                    <small>{text(field.payload.fieldType) || "text"}</small>
                    <h3>{field.name}</h3>
                    <p>{Array.isArray(field.payload.options) && field.payload.options.length ? `${field.payload.options.length} configured options` : "No option list required"}</p>
                    <span>{field.payload.required === true ? "Required" : "Optional"}</span>
                  </article>
                ))}
                {projectFields.length === 0 && <p className={styles.muted}>No custom fields yet.</p>}
              </section>
            )}

            {tab === "roadmap" && (
              <section className={styles.roadmap}>
                <div><small>Owner</small><strong>{text(selected.payload.owner) || "Unassigned"}</strong></div>
                <div><small>Start</small><strong>{dateLabel(selected.payload.startDate)}</strong></div>
                <div><small>Due</small><strong>{dateLabel(selected.payload.dueDate)}</strong></div>
                <div><small>Roadmap order</small><strong>{numberValue(selected.payload.roadmapOrder)}</strong></div>
                <div className={styles.progressTrack}><span style={{ width: `${progress}%` }} /></div>
              </section>
            )}

            <form className={styles.creator} onSubmit={createChild}>
              <div className={styles.creatorHead}>
                <div><p className={styles.eyebrow}>ADD TO PROJECT</p><h2>Create planning resource</h2></div>
                <div className={styles.segmented}>
                  <button type="button" className={childKind === "items" ? styles.segmentActive : ""} onClick={() => chooseChildKind("items")}>Item</button>
                  <button type="button" className={childKind === "iterations" ? styles.segmentActive : ""} onClick={() => chooseChildKind("iterations")}>Iteration</button>
                  <button type="button" className={childKind === "fields" ? styles.segmentActive : ""} onClick={() => chooseChildKind("fields")}>Field</button>
                </div>
              </div>
              <div className={styles.formGrid}>
                <label>Name<input value={childName} onChange={(event) => setChildName(event.target.value)} maxLength={180} required /></label>
                {childKind === "items" && <label>Status<select value={childStatus} onChange={(event) => setChildStatus(event.target.value)}>{itemStates.map((value) => <option key={value} value={value}>{prettyStatus(value)}</option>)}</select></label>}
                {childKind === "iterations" && <>
                  <label>Status<select value={childStatus} onChange={(event) => setChildStatus(event.target.value)}>{iterationStates.map((value) => <option key={value} value={value}>{prettyStatus(value)}</option>)}</select></label>
                  <label>Start<input type="date" value={iterationStart} onChange={(event) => setIterationStart(event.target.value)} /></label>
                  <label>End<input type="date" value={iterationEnd} onChange={(event) => setIterationEnd(event.target.value)} /></label>
                  <label className={styles.full}>Goal<textarea rows={3} value={iterationGoal} onChange={(event) => setIterationGoal(event.target.value)} /></label>
                </>}
                {childKind === "fields" && <>
                  <label>Type<select value={fieldType} onChange={(event) => setFieldType(event.target.value)}>{fieldTypes.map((value) => <option key={value} value={value}>{prettyStatus(value)}</option>)}</select></label>
                  {(fieldType === "single_select" || fieldType === "multi_select") && <label className={styles.full}>Options<input value={fieldOptions} onChange={(event) => setFieldOptions(event.target.value)} placeholder="Design, Review, Approved" /></label>}
                </>}
              </div>
              <div className={styles.creatorActions}><button className={styles.primary} disabled={busy || !childName.trim()}>{busy ? "Saving…" : `Create ${childKind.slice(0, -1)}`}</button></div>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
