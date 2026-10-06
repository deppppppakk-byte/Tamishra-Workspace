"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../build.module.css";

type Target = "windows" | "android";

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

type Runner = {
  executor: "container" | "host";
  labels: string[];
  capacity: number;
  activeJobs: number;
  os: string;
  status: "online" | "draining" | "offline";
};

const WINDOWS_WORKFLOW = "Kosh Managed Windows EXE v1";
const ANDROID_WORKFLOW = "Kosh Managed Android APK AAB v1";

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

function windowsCommand() {
  return String.raw`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $built=$false; if(Test-Path 'scripts\build_kosh_windows.ps1'){ & powershell -NoProfile -ExecutionPolicy Bypass -File 'scripts\build_kosh_windows.ps1'; if($LASTEXITCODE -ne 0){ throw 'Project Windows build script failed.' }; $built=$true } elseif(Test-Path 'CMakeLists.txt'){ cmake -S . -B build-kosh-windows -G 'Visual Studio 17 2022' -A x64; if($LASTEXITCODE -ne 0){ throw 'CMake configure failed.' }; cmake --build build-kosh-windows --config Release --parallel; if($LASTEXITCODE -ne 0){ throw 'CMake build failed.' }; $built=$true } else { $project=Get-ChildItem -Recurse -Filter *.csproj -File | Select-Object -First 1; if($project){ dotnet publish $project.FullName -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o kosh-dotnet-out; if($LASTEXITCODE -ne 0){ throw '.NET publish failed.' }; $built=$true } elseif(Test-Path 'pubspec.yaml'){ flutter pub get; if($LASTEXITCODE -ne 0){ throw 'Flutter package restore failed.' }; flutter build windows --release; if($LASTEXITCODE -ne 0){ throw 'Flutter Windows build failed.' }; $built=$true } elseif(Test-Path 'Cargo.toml'){ cargo build --release; if($LASTEXITCODE -ne 0){ throw 'Rust build failed.' }; $built=$true } elseif(Test-Path 'go.mod'){ New-Item -ItemType Directory -Force '.kosh-artifacts' | Out-Null; $env:GOOS='windows'; $env:GOARCH='amd64'; go build -trimpath -o '.kosh-artifacts\app.exe' .; if($LASTEXITCODE -ne 0){ throw 'Go Windows build failed.' }; $built=$true } elseif(Test-Path 'package.json'){ npm install; if($LASTEXITCODE -ne 0){ throw 'Node dependency install failed.' }; npm run build --if-present; npm run dist --if-present -- --win; $built=$true } }; if(-not $built){ throw 'Kosh could not detect a supported Windows build system.' }; New-Item -ItemType Directory -Force '.kosh-artifacts' | Out-Null; $files=Get-ChildItem -Path . -Recurse -Filter *.exe -File | Where-Object { $_.FullName -notmatch '\\node_modules\\|\\.git\\|\\.kosh-artifacts\\' } | Select-Object -First 30; foreach($file in $files){ $target=Join-Path '.kosh-artifacts' $file.Name; if(-not (Test-Path $target)){ Copy-Item $file.FullName $target -Force } }; if(-not (Get-ChildItem '.kosh-artifacts' -Filter *.exe -File -ErrorAction SilentlyContinue)){ throw 'Build completed but no Windows EXE was found.' }; Write-Host 'Kosh managed Windows build completed.'"`;
}

function androidCommand() {
  return String.raw`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; if(Test-Path 'package.json'){ npm install; if($LASTEXITCODE -ne 0){ throw 'JavaScript dependency install failed.' } }; if(Test-Path 'pubspec.yaml'){ flutter pub get; if($LASTEXITCODE -ne 0){ throw 'Flutter package restore failed.' }; flutter build apk --release; if($LASTEXITCODE -ne 0){ throw 'Flutter APK build failed.' }; flutter build appbundle --release; if($LASTEXITCODE -ne 0){ throw 'Flutter AAB build failed.' } } elseif(Test-Path 'android\gradlew.bat'){ if((Get-ChildItem -Name 'capacitor.config.*' -ErrorAction SilentlyContinue | Select-Object -First 1) -and (Test-Path 'package.json')){ npx cap sync android; if($LASTEXITCODE -ne 0){ throw 'Capacitor Android sync failed.' } }; Push-Location android; & .\gradlew.bat clean assembleRelease bundleRelease; $code=$LASTEXITCODE; Pop-Location; if($code -ne 0){ throw 'Android Gradle build failed.' } } elseif(Test-Path 'gradlew.bat'){ & .\gradlew.bat clean assembleRelease bundleRelease; if($LASTEXITCODE -ne 0){ throw 'Android Gradle build failed.' } } else { throw 'Kosh could not detect a supported Android build system.' }; New-Item -ItemType Directory -Force '.kosh-artifacts' | Out-Null; $files=Get-ChildItem -Path . -Recurse -File | Where-Object { ($_.Extension -eq '.apk' -or $_.Extension -eq '.aab') -and $_.FullName -notmatch '\\intermediates\\|\\.kosh-artifacts\\' } | Select-Object -First 30; foreach($file in $files){ $name=$file.Name; $target=Join-Path '.kosh-artifacts' $name; if(Test-Path $target){ $name=([IO.Path]::GetFileNameWithoutExtension($file.Name) + '-' + ([guid]::NewGuid().ToString('N').Substring(0,6)) + $file.Extension); $target=Join-Path '.kosh-artifacts' $name }; Copy-Item $file.FullName $target -Force }; if(-not (Get-ChildItem '.kosh-artifacts' -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -eq '.apk' -or $_.Extension -eq '.aab' })){ throw 'Build completed but no APK or AAB was found.' }; Write-Host 'Kosh managed Android build completed.'"`;
}

function workflowFor(target: Target) {
  const windows = target === "windows";
  return {
    name: windows ? WINDOWS_WORKFLOW : ANDROID_WORKFLOW,
    path: windows
      ? ".kosh/workflows/managed-windows-exe.kosh.json"
      : ".kosh/workflows/managed-android-apk-aab.kosh.json",
    definition: {
      version: 1,
      name: windows ? WINDOWS_WORKFLOW : ANDROID_WORKFLOW,
      triggers: { manual: true },
      jobs: [
        {
          id: windows ? "managed-windows" : "managed-android",
          name: windows ? "Build Windows EXE" : "Build Android APK and AAB",
          timeoutMinutes: windows ? 180 : 180,
          network: "egress",
          runsOn: windows
            ? ["os:win32", "executor:host", "windows-build"]
            : ["os:win32", "executor:host", "android-build"],
          steps: [
            {
              name: windows ? "Detect and build Windows application" : "Detect and build Android application",
              run: windows ? windowsCommand() : androidCommand()
            }
          ]
        }
      ]
    }
  };
}

export function KoshQuickBuild() {
  const gateway = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [target, setTarget] = useState<Target>("windows");
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
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
    if (params.get("target") === "android") setTarget("android");
  }, []);

  const resourceBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return `${gateway}/v1/kosh/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`;
  }, [gateway, namespace, slug]);
  const automationBase = resourceBase ? `${resourceBase}/automation` : "";
  const query = `namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(slug)}`;

  const fetchJson = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Kosh request failed (${response.status}).`);
    return payload;
  }, []);

  const postJson = useCallback(async <T,>(url: string, body: unknown): Promise<T> => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
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
        fetchJson<{ runners: Runner[] }>(`${gateway}/v1/kosh/automation/runners`).catch(() => ({ runners: [] }))
      ]);
      setRepo(repoPayload);
      setSummary(automationPayload);
      setRunners(runnerPayload.runners || []);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Quick Build.");
    } finally {
      setLoading(false);
    }
  }, [automationBase, fetchJson, gateway, resourceBase]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!runId || !automationBase) return;
    let cancelled = false;
    async function refresh() {
      try {
        const detail = await fetchJson<RunDetail>(`${automationBase}/runs/${encodeURIComponent(runId)}`);
        if (!cancelled) setRunDetail(detail);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not refresh build.");
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [automationBase, fetchJson, runId]);

  async function startBuild() {
    if (!automationBase || !repo?.headSha || !summary) return;
    setBuilding(true);
    setError("");
    try {
      const requested = workflowFor(target);
      let workflow = summary.workflows.find((item) => item.name === requested.name);
      if (!workflow) {
        workflow = await postJson<Workflow>(`${automationBase}/workflows`, {
          path: requested.path,
          definition: requested.definition
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
      setError(reason instanceof Error ? reason.message : "Kosh could not queue this build.");
    } finally {
      setBuilding(false);
    }
  }

  const matchingCapacity = runners.filter((runner) =>
    runner.status === "online" &&
    runner.executor === "host" &&
    (runner.os === "win32" || runner.labels.includes("os:win32")) &&
    runner.labels.includes(target === "windows" ? "windows-build" : "android-build")
  );
  const freeSlots = matchingCapacity.reduce(
    (sum, runner) => sum + Math.max(0, runner.capacity - runner.activeJobs),
    0
  );
  const activeRun = runDetail?.run || summary?.runs.find((item) => item.id === runId) || null;
  const logText = runDetail?.jobs
    .flatMap((job) => job.logs.map((log) => `${log.stream === "system" ? "[kosh] " : log.stream === "stderr" ? "[stderr] " : ""}${log.text}`))
    .join("") || "";
  const buildReady = Boolean(repo?.headSha);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={`/apps/kosh/repository?${query}`}>← Repository</Link>
          <p>KOSH MANAGED BUILD</p>
          <h1>Quick Build</h1>
          <span>Choose an output and press Build. Kosh queues, assigns build capacity, compiles and returns the finished file in the browser.</span>
        </div>
        <div className={styles.statusCard}>
          <span>Managed build pool</span>
          <strong>{freeSlots > 0 ? "Ready" : "Automatic queue"}</strong>
          <em>{freeSlots > 0 ? `${freeSlots} build slot${freeSlots === 1 ? "" : "s"} available` : "Kosh will assign capacity when available"}</em>
        </div>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}

      <section className={styles.grid}>
        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>What do you want?</strong><span>Kosh detects the repository toolchain automatically.</span></div>
          </div>
          <div className={styles.presets}>
            <button type="button" className={target === "windows" ? styles.presetActive : styles.preset} onClick={() => setTarget("windows")}>
              <strong>Windows EXE</strong>
              <span>CMake/MSVC, .NET, Flutter, Rust, Go, Electron and kavYN 2D build scripts.</span>
            </button>
            <button type="button" className={target === "android" ? styles.presetActive : styles.preset} onClick={() => setTarget("android")}>
              <strong>Android APK + AAB</strong>
              <span>Flutter, native Gradle, React Native and Capacitor Android projects.</span>
            </button>
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Build now</strong><span>{namespace}/{slug}</span></div>
          </div>
          <div className={styles.buildSummary}>
            <div><span>Output</span><strong>{target === "windows" ? "Windows EXE" : "APK + AAB"}</strong></div>
            <div><span>Branch</span><strong>{repo?.repository.defaultBranch || "main"}</strong></div>
            <div><span>Commit</span><strong className={styles.mono}>{repo?.headSha?.slice(0, 12) || "—"}</strong></div>
            <div><span>Capacity</span><strong>{freeSlots > 0 ? "Ready" : "Managed queue"}</strong></div>
          </div>
          <button className={styles.primary} type="button" disabled={building || !buildReady} onClick={() => void startBuild()}>
            {building ? "Starting build…" : target === "windows" ? "Build Windows EXE" : "Build APK + AAB"}
          </button>
          <p className={styles.hint}>No local setup is required in this screen. If managed capacity is busy, the build remains safely queued until Kosh can run it.</p>
        </article>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Build status</strong><span>Kosh-managed queue, build logs and downloadable output.</span></div>
          {activeRun ? <span className={`${styles.badge} ${styles[activeRun.status] || ""}`}>{activeRun.status}</span> : null}
        </div>
        {activeRun ? (
          <>
            <div className={styles.runMeta}>
              <span>{activeRun.workflowName}</span>
              <span className={styles.mono}>{activeRun.commitSha.slice(0, 12)}</span>
              <span>{activeRun.refName}</span>
            </div>
            <pre className={styles.logs}>{logText || (activeRun.status === "queued" ? "Waiting for Kosh managed build capacity…" : "Build is starting…")}</pre>
          </>
        ) : (
          <div className={styles.empty}>{loading ? "Loading build state…" : "Choose an output above and start a build."}</div>
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Build output</strong><span>Checksummed files generated by this Kosh build.</span></div>
          <Link href={`/apps/kosh/packages?${query}`}>Kosh Packages</Link>
        </div>
        <div className={styles.artifacts}>
          {runDetail?.artifacts.map((artifact) => (
            <a key={artifact.id} href={`${automationBase}/runs/${encodeURIComponent(runDetail.run.id)}/artifacts/${encodeURIComponent(artifact.id)}/download`}>
              <div><strong>{artifact.name}</strong><span className={styles.mono}>{artifact.sha256.slice(0, 16)}…</span></div>
              <em>{sizeLabel(artifact.sizeBytes)} · Download</em>
            </a>
          ))}
          {!runDetail?.artifacts.length ? <div className={styles.empty}>The generated EXE, APK or AAB will appear here after the build succeeds.</div> : null}
        </div>
      </section>
    </main>
  );
}
