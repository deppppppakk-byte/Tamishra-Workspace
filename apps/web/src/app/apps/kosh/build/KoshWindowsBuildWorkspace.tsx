"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./build.module.css";

type Runner = {
  id: string;
  executor: "container" | "host";
  labels: string[];
  capacity: number;
  activeJobs: number;
  version: string;
  os: string;
  arch: string;
  status: "online" | "draining" | "offline";
  lastSeenAt: string;
};

type Workflow = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
};

type Run = {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "queued" | "running" | "success" | "failure" | "cancelled";
  refName: string;
  commitSha: string;
  createdAt: string;
};

type Artifact = {
  id: string;
  name: string;
  sizeBytes: number;
  sha256: string;
};

type RunDetail = {
  run: Run;
  jobs: Array<{
    id: string;
    name: string;
    status: Run["status"];
    logs: Array<{ id: string; stream: string; text: string }>;
  }>;
  artifacts: Artifact[];
};

type Summary = {
  workflows: Workflow[];
  runs: Run[];
};

type RepoSummary = {
  repository: { defaultBranch: string; name?: string };
  headSha: string | null;
  empty: boolean;
};

type Preset = {
  id: string;
  title: string;
  description: string;
  workflowName: string;
  path: string;
  timeoutMinutes: number;
  stepName: string;
  command: string;
  publishPackages?: boolean;
};

const presets: Preset[] = [
  {
    id: "kavyn2d",
    title: "kavYN 2D",
    description: "C++20/MSVC core + tests + native DLL + PyInstaller Windows desktop EXE and full release package.",
    workflowName: "kavYN 2D Windows EXE",
    path: ".kosh/workflows/windows-exe.kosh.json",
    timeoutMinutes: 180,
    stepName: "Build, test and package kavYN 2D",
    command: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\build_kosh_windows.ps1",
    publishPackages: true
  },
  {
    id: "cmake",
    title: "CMake / MSVC",
    description: "Configure Visual Studio x64 Release, compile, then collect generated EXE files.",
    workflowName: "Windows CMake EXE",
    path: ".kosh/workflows/windows-cmake-exe.kosh.json",
    timeoutMinutes: 120,
    stepName: "Build Windows Release",
    command: "cmake -S . -B build-windows -G \"Visual Studio 17 2022\" -A x64 && cmake --build build-windows --config Release --parallel && powershell -NoProfile -Command \"New-Item -ItemType Directory -Force .kosh-artifacts | Out-Null; Get-ChildItem build-windows -Recurse -Filter *.exe | ForEach-Object { Copy-Item $_.FullName (Join-Path .kosh-artifacts $_.Name) -Force }\""
  },
  {
    id: "dotnet",
    title: ".NET",
    description: "Publish a self-contained Windows x64 single-file application.",
    workflowName: "Windows .NET EXE",
    path: ".kosh/workflows/windows-dotnet-exe.kosh.json",
    timeoutMinutes: 90,
    stepName: "Publish Windows EXE",
    command: "dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o kosh-dotnet-out && powershell -NoProfile -Command \"New-Item -ItemType Directory -Force .kosh-artifacts | Out-Null; Get-ChildItem kosh-dotnet-out -Filter *.exe | Copy-Item -Destination .kosh-artifacts -Force\""
  },
  {
    id: "go",
    title: "Go",
    description: "Compile the repository entry point as a Windows amd64 executable.",
    workflowName: "Windows Go EXE",
    path: ".kosh/workflows/windows-go-exe.kosh.json",
    timeoutMinutes: 45,
    stepName: "Build Go Windows EXE",
    command: "if not exist .kosh-artifacts mkdir .kosh-artifacts && set GOOS=windows&& set GOARCH=amd64&& go build -trimpath -o .kosh-artifacts\\app.exe ."
  },
  {
    id: "rust",
    title: "Rust",
    description: "Build Cargo Release and collect Windows executables.",
    workflowName: "Windows Rust EXE",
    path: ".kosh/workflows/windows-rust-exe.kosh.json",
    timeoutMinutes: 90,
    stepName: "Build Cargo Release",
    command: "cargo build --release && powershell -NoProfile -Command \"New-Item -ItemType Directory -Force .kosh-artifacts | Out-Null; Get-ChildItem target\\release -Filter *.exe | Copy-Item -Destination .kosh-artifacts -Force\""
  },
  {
    id: "flutter",
    title: "Flutter Windows",
    description: "Build a Flutter Windows Release application and collect its launcher EXE.",
    workflowName: "Windows Flutter EXE",
    path: ".kosh/workflows/windows-flutter-exe.kosh.json",
    timeoutMinutes: 120,
    stepName: "Build Flutter Windows Release",
    command: "flutter pub get && flutter build windows --release && powershell -NoProfile -Command \"New-Item -ItemType Directory -Force .kosh-artifacts | Out-Null; Get-ChildItem build\\windows -Recurse -Filter *.exe | Copy-Item -Destination .kosh-artifacts -Force\""
  },
  {
    id: "electron",
    title: "Electron",
    description: "Install dependencies and run the project Windows packaging command.",
    workflowName: "Windows Electron EXE",
    path: ".kosh/workflows/windows-electron-exe.kosh.json",
    timeoutMinutes: 120,
    stepName: "Package Electron for Windows",
    command: "npm ci && npm run build && npm run dist -- --win && powershell -NoProfile -Command \"New-Item -ItemType Directory -Force .kosh-artifacts | Out-Null; Get-ChildItem dist -Recurse -Filter *.exe | Copy-Item -Destination .kosh-artifacts -Force\""
  }
];

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function sizeLabel(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function workflowDefinition(preset: Preset) {
  return {
    version: 1,
    name: preset.workflowName,
    triggers: { manual: true, push: { branches: ["main"] } },
    jobs: [
      {
        id: "windows-exe",
        name: preset.title + " Windows EXE",
        timeoutMinutes: preset.timeoutMinutes,
        network: "egress",
        runsOn: ["os:win32", "executor:host", "windows-build"],
        publishPackages: preset.publishPackages === true,
        steps: [{ name: preset.stepName, run: preset.command }]
      }
    ]
  };
}

export function KoshWindowsBuildWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("kavyn2d");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [runId, setRunId] = useState("");
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() || "tamishra");
    setSlug(params.get("slug")?.trim() || "kavyn-2d");
  }, []);

  const resourceBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return `${base}/v1/kosh/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`;
  }, [base, namespace, slug]);
  const automationBase = resourceBase ? `${resourceBase}/automation` : "";
  const currentPreset = presets.find((item) => item.id === selectedPreset) || presets[0];
  const repositoryHref = `/apps/kosh/repository?namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(slug)}`;
  const packagesHref = `/apps/kosh/packages?namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(slug)}`;

  const fetchJson = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Kosh request failed (${response.status}).`);
    return payload;
  }, []);

  const load = useCallback(async () => {
    if (!resourceBase || !automationBase) return;
    setLoading(true);
    try {
      const [repoPayload, automationPayload, runnerPayload] = await Promise.all([
        fetchJson<RepoSummary>(resourceBase),
        fetchJson<Summary>(`${automationBase}/summary`),
        fetchJson<{ runners: Runner[] }>(`${base}/v1/kosh/automation/runners`).catch(() => ({ runners: [] }))
      ]);
      setRepo(repoPayload);
      setSummary(automationPayload);
      setRunners(runnerPayload.runners || []);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Windows Builds.");
    } finally {
      setLoading(false);
    }
  }, [automationBase, base, fetchJson, resourceBase]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!runId || !automationBase) return;
    let cancelled = false;
    async function refreshRun() {
      try {
        const detail = await fetchJson<RunDetail>(`${automationBase}/runs/${encodeURIComponent(runId)}`);
        if (!cancelled) setRunDetail(detail);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not refresh build.");
      }
    }
    void refreshRun();
    const timer = window.setInterval(() => void refreshRun(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [automationBase, fetchJson, runId]);

  async function postJson<T>(url: string, body: unknown): Promise<T> {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Kosh request failed (${response.status}).`);
    return payload;
  }

  async function startBuild() {
    if (!automationBase || !repo?.headSha || !summary) return;
    setBuilding(true);
    setError("");
    try {
      let workflow = summary.workflows.find((item) => item.name === currentPreset.workflowName);
      if (!workflow) {
        workflow = await postJson<Workflow>(`${automationBase}/workflows`, {
          path: currentPreset.path,
          definition: workflowDefinition(currentPreset)
        });
      }
      const run = await postJson<Run>(`${automationBase}/workflows/${encodeURIComponent(workflow.id)}/runs`, {
        refName: repo.repository.defaultBranch || "main",
        commitSha: repo.headSha
      });
      setRunId(run.id);
      setRunDetail(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Windows build could not be started.");
    } finally {
      setBuilding(false);
    }
  }

  const windowsRunners = runners.filter(
    (runner) =>
      runner.status === "online" &&
      runner.executor === "host" &&
      (runner.os === "win32" || runner.labels.includes("os:win32")) &&
      runner.labels.includes("windows-build")
  );
  const activeRun = runDetail?.run || summary?.runs.find((run) => run.id === runId) || null;
  const buildReady = windowsRunners.length > 0 && Boolean(repo?.headSha);
  const logText = runDetail?.jobs
    .flatMap((job) => job.logs.map((log) => `${log.stream === "system" ? "[kosh] " : log.stream === "stderr" ? "[stderr] " : ""}${log.text}`))
    .join("") || "";

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH BUILD</p>
          <h1>Windows Builds</h1>
          <span>Compile, test, package and download Windows executables using your own Kosh runners.</span>
        </div>
        <div className={styles.statusCard}>
          <span>Windows build capacity</span>
          <strong>{windowsRunners.length} runner{windowsRunners.length === 1 ? "" : "s"} online</strong>
          <em>{windowsRunners.reduce((sum, runner) => sum + Math.max(0, runner.capacity - runner.activeJobs), 0)} free slots</em>
        </div>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.grid}>
        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Build target</strong><span>Choose a Windows toolchain preset.</span></div>
          </div>
          <div className={styles.presets}>
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={selectedPreset === preset.id ? styles.presetActive : styles.preset}
                onClick={() => setSelectedPreset(preset.id)}
              >
                <strong>{preset.title}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Build now</strong><span>{namespace}/{slug}</span></div>
          </div>
          <div className={styles.buildSummary}>
            <div><span>Preset</span><strong>{currentPreset.title}</strong></div>
            <div><span>Branch</span><strong>{repo?.repository.defaultBranch || "main"}</strong></div>
            <div><span>Commit</span><strong className={styles.mono}>{repo?.headSha?.slice(0, 12) || "—"}</strong></div>
            <div><span>Runner</span><strong>{windowsRunners.length ? "Ready" : "Windows runner required"}</strong></div>
          </div>
          <button className={styles.primary} type="button" disabled={building || !buildReady} onClick={() => void startBuild()}>
            {building ? "Queueing build…" : `Build ${currentPreset.title} EXE`}
          </button>
          {!windowsRunners.length ? (
            <p className={styles.hint}>Start a Kosh Windows Builder with labels <code>os:win32</code>, <code>executor:host</code> and <code>windows-build</code>.</p>
          ) : null}
        </article>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Current build</strong><span>Live Kosh runner status and output.</span></div>
          {activeRun ? <span className={`${styles.badge} ${styles[activeRun.status] || ""}`}>{activeRun.status}</span> : null}
        </div>
        {activeRun ? (
          <>
            <div className={styles.runMeta}>
              <span>{activeRun.workflowName}</span>
              <span className={styles.mono}>{activeRun.commitSha.slice(0, 12)}</span>
              <span>{activeRun.refName}</span>
            </div>
            <pre className={styles.logs}>{logText || "Waiting for Windows runner…"}</pre>
          </>
        ) : (
          <div className={styles.empty}>{loading ? "Loading build state…" : "No build started in this session."}</div>
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Windows EXE artifacts</strong><span>Verified output from the selected Kosh run.</span></div>
          <Link href={packagesHref}>Kosh Packages</Link>
        </div>
        <div className={styles.artifacts}>
          {runDetail?.artifacts.map((artifact) => (
            <a
              key={artifact.id}
              href={`${automationBase}/runs/${encodeURIComponent(runDetail.run.id)}/artifacts/${encodeURIComponent(artifact.id)}/download`}
            >
              <div><strong>{artifact.name}</strong><span className={styles.mono}>{artifact.sha256.slice(0, 16)}…</span></div>
              <em>{sizeLabel(artifact.sizeBytes)} · Download</em>
            </a>
          ))}
          {!runDetail?.artifacts.length ? <div className={styles.empty}>Generated EXE files will appear here after a successful build.</div> : null}
        </div>
      </section>
    </main>
  );
}
