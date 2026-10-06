"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import base from "../build.module.css";
import styles from "./android.module.css";

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

type RunDetail = {
  run: Run;
  jobs: Array<{
    id: string;
    name: string;
    status: Run["status"];
    logs: Array<{ id: string; stream: string; text: string }>;
  }>;
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

type PackageVersion = {
  id: string;
  packageKey: string;
  version: string;
  filename: string;
  format: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

type PackagePayload = {
  versions: PackageVersion[];
};

type Preset = {
  id: string;
  title: string;
  description: string;
  workflowName: string;
  timeoutMinutes: number;
  stepName: string;
  command: string;
  defaultDirectory: string;
};

const presets: Preset[] = [
  {
    id: "capacitor",
    title: "Capacitor / Android",
    description: "Sync the web app into Capacitor Android, then create release APK and AAB packages with Gradle.",
    workflowName: "Android Capacitor APK AAB",
    timeoutMinutes: 120,
    stepName: "Build Capacitor Android release",
    command: "npm install && npx cap sync android && cd android && call gradlew.bat clean assembleRelease bundleRelease",
    defaultDirectory: "."
  },
  {
    id: "flutter",
    title: "Flutter Android",
    description: "Resolve Flutter packages, then generate both release APK and Play Store AAB outputs.",
    workflowName: "Android Flutter APK AAB",
    timeoutMinutes: 120,
    stepName: "Build Flutter Android release",
    command: "flutter pub get && flutter build apk --release && flutter build appbundle --release",
    defaultDirectory: "."
  },
  {
    id: "gradle",
    title: "Native Gradle",
    description: "Use the repository Gradle wrapper to build Android release APK and app bundle outputs.",
    workflowName: "Android Gradle APK AAB",
    timeoutMinutes: 120,
    stepName: "Build Gradle Android release",
    command: "if exist gradlew.bat (call gradlew.bat clean assembleRelease bundleRelease) else (gradle clean assembleRelease bundleRelease)",
    defaultDirectory: "."
  },
  {
    id: "react-native",
    title: "React Native",
    description: "Install JavaScript dependencies and build the Android release application through Gradle.",
    workflowName: "Android React Native APK AAB",
    timeoutMinutes: 150,
    stepName: "Build React Native Android release",
    command: "npm install && cd android && call gradlew.bat clean assembleRelease bundleRelease",
    defaultDirectory: "."
  },
  {
    id: "kosh-mobile",
    title: "Kosh Mobile",
    description: "Build the Tamishra Workspace web client, sync Kosh Capacitor Android, and package APK/AAB releases.",
    workflowName: "Kosh Mobile APK AAB",
    timeoutMinutes: 180,
    stepName: "Build Kosh Mobile Android release",
    command: "npm install && npm run build:web:native && npm --workspace @tamishra/kosh-mobile run sync && cd apps\\kosh-mobile\\android && call gradlew.bat clean assembleRelease bundleRelease",
    defaultDirectory: "."
  }
];

const signingSecrets = [
  "ANDROID_KEYSTORE_BASE64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD"
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

function cleanDirectory(value: string) {
  const next = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return next || ".";
}

function workflowSuffix(directory: string, signed: boolean) {
  const value = cleanDirectory(directory)
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/[/.]+/g, "-")
    .replace(/^-+|-+$/g, "") || "root";
  return `${value}${signed ? "-signed" : ""}`;
}

function collectCommand() {
  return "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$ErrorActionPreference='Stop'; $out='.kosh-android-build'; Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $out | Out-Null; $files=Get-ChildItem -Path . -Recurse -File | Where-Object { ($_.Extension -eq '.apk' -or $_.Extension -eq '.aab') -and $_.FullName -notmatch '\\\\intermediates\\\\' -and ($_.FullName -match '\\\\release\\\\' -or $_.FullName -match '\\\\outputs\\\\' -or $_.Name -match 'release') } | Select-Object -First 20; if(-not $files){ throw 'No APK or AAB output was produced.' }; foreach($file in $files){ $name=$file.Name; $target=Join-Path $out $name; if(Test-Path $target){ $name=([IO.Path]::GetFileNameWithoutExtension($file.Name) + '-' + ([guid]::NewGuid().ToString('N').Substring(0,6)) + $file.Extension); $target=Join-Path $out $name }; Copy-Item $file.FullName $target -Force }; Write-Host ('Collected ' + $files.Count + ' Android package(s).')\"";
}

function signCommand() {
  return "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$ErrorActionPreference='Stop'; $dir='.kosh-android-build'; $ks=Join-Path $dir 'kosh-release.jks'; [IO.File]::WriteAllBytes($ks,[Convert]::FromBase64String($env:ANDROID_KEYSTORE_BASE64)); try { $buildTools=Join-Path $env:ANDROID_HOME 'build-tools'; $apksigner=Get-ChildItem $buildTools -Directory | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'apksigner.bat' } | Where-Object { Test-Path $_ } | Select-Object -First 1; if(-not $apksigner){ throw 'Android apksigner was not found.' }; Get-ChildItem $dir -Filter *.apk -File | ForEach-Object { $signed=$_.FullName + '.signed.apk'; & $apksigner sign --ks $ks --ks-pass env:ANDROID_KEYSTORE_PASSWORD --ks-key-alias $env:ANDROID_KEY_ALIAS --key-pass env:ANDROID_KEY_PASSWORD --out $signed $_.FullName; if($LASTEXITCODE -ne 0){ throw 'APK signing failed.' }; Move-Item $signed $_.FullName -Force; & $apksigner verify --verbose $_.FullName; if($LASTEXITCODE -ne 0){ throw 'APK signature verification failed.' } }; Get-ChildItem $dir -Filter *.aab -File | ForEach-Object { & jarsigner -keystore $ks -storepass:env ANDROID_KEYSTORE_PASSWORD -keypass:env ANDROID_KEY_PASSWORD $_.FullName $env:ANDROID_KEY_ALIAS; if($LASTEXITCODE -ne 0){ throw 'AAB signing failed.' }; & jarsigner -verify $_.FullName; if($LASTEXITCODE -ne 0){ throw 'AAB signature verification failed.' } } } finally { Remove-Item $ks -Force -ErrorAction SilentlyContinue }\"";
}

function manifestCommand(signed: boolean, preset: Preset) {
  const signedValue = signed ? "$true" : "$false";
  const presetId = preset.id.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $source='.kosh-android-build'; $manifestDir='.kosh-packages'; New-Item -ItemType Directory -Force $manifestDir | Out-Null; $sha=[string]$env:KOSH_COMMIT_SHA; if([string]::IsNullOrWhiteSpace($sha)){ $sha='manual' }; $short=$sha.Substring(0,[Math]::Min(12,$sha.Length)); $version='build-' + $short; $packages=@(); Get-ChildItem $source -File | Where-Object { $_.Extension -eq '.apk' -or $_.Extension -eq '.aab' } | ForEach-Object { $ext=$_.Extension.TrimStart('.').ToLowerInvariant(); $stem=([IO.Path]::GetFileNameWithoutExtension($_.Name).ToLowerInvariant() -replace '[^a-z0-9._-]+','-').Trim('-'); if(-not $stem){$stem='app'}; $key=('android-' + $ext + '-' + $stem).Substring(0,[Math]::Min(120,('android-' + $ext + '-' + $stem).Length)); $relative=$_.FullName.Substring((Get-Location).Path.Length + 1).Replace('\\','/'); $media=if($ext -eq 'apk'){'application/vnd.android.package-archive'}else{'application/octet-stream'}; $packages += [ordered]@{ path=$relative; key=$key; name=('Android ' + $ext.ToUpperInvariant()); version=$version; format=$ext; mediaType=$media; channel='latest'; metadata=[ordered]@{ platform='android'; signed=${signedValue}; preset='${presetId}'; commit=$sha } } }; if(-not $packages.Count){ throw 'No Android package is available for publishing.' }; [ordered]@{packages=$packages} | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $manifestDir 'manifest.json'); Write-Host ('Prepared ' + $packages.Count + ' Kosh Android package(s).')"`;
}

function workflowDefinition(
  preset: Preset,
  directory: string,
  signed: boolean
) {
  const projectDirectory = cleanDirectory(directory);
  const suffix = workflowSuffix(projectDirectory, signed);
  const name = `${preset.workflowName} ${suffix}`;
  const steps: Array<{
    name: string;
    run: string;
    workingDirectory?: string;
  }> = [
    {
      name: preset.stepName,
      run: preset.command,
      workingDirectory: projectDirectory
    },
    { name: "Collect APK and AAB", run: collectCommand() }
  ];

  if (signed) {
    steps.push({ name: "Sign and verify Android packages", run: signCommand() });
  }
  steps.push({
    name: "Prepare Kosh Android packages",
    run: manifestCommand(signed, preset)
  });

  return {
    name,
    path: `.kosh/workflows/android-${preset.id}-${suffix}.kosh.json`,
    definition: {
      version: 1,
      name,
      triggers: { manual: true, push: { branches: ["main"] } },
      jobs: [
        {
          id: "android-package",
          name: `${preset.title} APK/AAB`,
          timeoutMinutes: preset.timeoutMinutes,
          network: "egress",
          runsOn: ["os:win32", "executor:host", "android-build"],
          publishPackages: true,
          ...(signed ? { secrets: signingSecrets } : {}),
          steps
        }
      ]
    }
  };
}

export function KoshAndroidBuildWorkspace() {
  const gateway = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("capacitor");
  const [projectDirectory, setProjectDirectory] = useState(".");
  const [signed, setSigned] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [packages, setPackages] = useState<PackageVersion[]>([]);
  const [runId, setRunId] = useState("");
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() || "tamishra");
    setSlug(params.get("slug")?.trim() || "kosh-mobile");
  }, []);

  const resourceBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return `${gateway}/v1/kosh/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`;
  }, [gateway, namespace, slug]);
  const automationBase = resourceBase ? `${resourceBase}/automation` : "";
  const currentPreset = presets.find((item) => item.id === selectedPreset) || presets[0];
  const query = `namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(slug)}`;
  const repositoryHref = `/apps/kosh/repository?${query}`;
  const packagesHref = `/apps/kosh/packages?${query}`;
  const windowsHref = `/apps/kosh/build/windows?${query}`;

  const fetchJson = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || `Kosh request failed (${response.status}).`);
    }
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
    if (!response.ok) {
      throw new Error(payload.error || `Kosh request failed (${response.status}).`);
    }
    return payload;
  }, []);

  const load = useCallback(async () => {
    if (!resourceBase || !automationBase) return;
    setLoading(true);
    try {
      const [repoPayload, automationPayload, runnerPayload, packagePayload] = await Promise.all([
        fetchJson<RepoSummary>(resourceBase),
        fetchJson<Summary>(`${automationBase}/summary`),
        fetchJson<{ runners: Runner[] }>(`${gateway}/v1/kosh/automation/runners`).catch(() => ({ runners: [] })),
        fetchJson<PackagePayload>(`${resourceBase}/packages`).catch(() => ({ versions: [] }))
      ]);
      setRepo(repoPayload);
      setSummary(automationPayload);
      setRunners(runnerPayload.runners || []);
      setPackages(
        (packagePayload.versions || [])
          .filter((item) => /\.(apk|aab)$/i.test(item.filename))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 20)
      );
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh Android Builds.");
    } finally {
      setLoading(false);
    }
  }, [automationBase, fetchJson, gateway, resourceBase]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    setProjectDirectory(currentPreset.defaultDirectory);
  }, [currentPreset.id]);

  useEffect(() => {
    if (!runId || !automationBase) return;
    let cancelled = false;
    async function refreshRun() {
      try {
        const detail = await fetchJson<RunDetail>(`${automationBase}/runs/${encodeURIComponent(runId)}`);
        if (!cancelled) {
          setRunDetail(detail);
          if (["success", "failure", "cancelled"].includes(detail.run.status)) {
            void load();
          }
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not refresh Android build.");
        }
      }
    }
    void refreshRun();
    const timer = window.setInterval(() => void refreshRun(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [automationBase, fetchJson, load, runId]);

  async function startBuild() {
    if (!automationBase || !repo?.headSha || !summary) return;
    setBuilding(true);
    setError("");
    try {
      const requested = workflowDefinition(currentPreset, projectDirectory, signed);
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
      setError(reason instanceof Error ? reason.message : "Android build could not be started.");
    } finally {
      setBuilding(false);
    }
  }

  const androidRunners = runners.filter(
    (runner) =>
      runner.status === "online" &&
      runner.executor === "host" &&
      (runner.os === "win32" || runner.labels.includes("os:win32")) &&
      runner.labels.includes("android-build")
  );
  const activeRun = runDetail?.run || summary?.runs.find((run) => run.id === runId) || null;
  const buildReady = androidRunners.length > 0 && Boolean(repo?.headSha);
  const logText =
    runDetail?.jobs
      .flatMap((job) =>
        job.logs.map(
          (log) =>
            `${log.stream === "system" ? "[kosh] " : log.stream === "stderr" ? "[stderr] " : ""}${log.text}`
        )
      )
      .join("") || "";

  return (
    <main className={base.page}>
      <header className={base.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH BUILD</p>
          <h1>Android Builds</h1>
          <span>Generate APK and AAB packages on your own Kosh Android runners, with optional Kosh-managed signing.</span>
          <div className={styles.headerLinks}>
            <Link href={windowsHref}>Windows EXE</Link>
            <Link href={packagesHref}>Kosh Packages</Link>
          </div>
        </div>
        <div className={base.statusCard}>
          <span>Android build capacity</span>
          <strong>{androidRunners.length} runner{androidRunners.length === 1 ? "" : "s"} online</strong>
          <em>{androidRunners.reduce((sum, runner) => sum + Math.max(0, runner.capacity - runner.activeJobs), 0)} free slots</em>
        </div>
      </header>

      {error ? <div className={base.error}>{error}</div> : null}

      <section className={base.grid}>
        <article className={base.panel}>
          <div className={base.panelTitle}>
            <div><strong>Android target</strong><span>Choose the application toolchain.</span></div>
          </div>
          <div className={base.presets}>
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={selectedPreset === preset.id ? base.presetActive : base.preset}
                onClick={() => setSelectedPreset(preset.id)}
              >
                <strong>{preset.title}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
        </article>

        <article className={base.panel}>
          <div className={base.panelTitle}>
            <div><strong>Build configuration</strong><span>{namespace}/{slug}</span></div>
          </div>
          <label className={styles.field}>
            <span>Project directory</span>
            <input
              value={projectDirectory}
              onChange={(event) => setProjectDirectory(event.target.value)}
              placeholder=". or apps/mobile"
            />
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={signed}
              onChange={(event) => setSigned(event.target.checked)}
            />
            <span>
              <strong>Sign release with Kosh Secrets</strong>
              <small>Uses ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD.</small>
            </span>
          </label>
          <div className={base.buildSummary}>
            <div><span>Preset</span><strong>{currentPreset.title}</strong></div>
            <div><span>Branch</span><strong>{repo?.repository.defaultBranch || "main"}</strong></div>
            <div><span>Commit</span><strong className={base.mono}>{repo?.headSha?.slice(0, 12) || "—"}</strong></div>
            <div><span>Runner</span><strong>{androidRunners.length ? "Ready" : "Android runner required"}</strong></div>
          </div>
          <button className={base.primary} type="button" disabled={building || !buildReady} onClick={() => void startBuild()}>
            {building ? "Queueing build…" : `Build ${currentPreset.title} APK + AAB`}
          </button>
          {!androidRunners.length ? (
            <p className={base.hint}>Start a Kosh Android Builder with labels <code>os:win32</code>, <code>executor:host</code> and <code>android-build</code>.</p>
          ) : null}
        </article>
      </section>

      <section className={base.panel}>
        <div className={base.panelTitle}>
          <div><strong>Current Android build</strong><span>Live build, signing and package publishing output.</span></div>
          {activeRun ? <span className={`${base.badge} ${base[activeRun.status] || ""}`}>{activeRun.status}</span> : null}
        </div>
        {activeRun ? (
          <>
            <div className={base.runMeta}>
              <span>{activeRun.workflowName}</span>
              <span className={base.mono}>{activeRun.commitSha.slice(0, 12)}</span>
              <span>{activeRun.refName}</span>
            </div>
            <pre className={base.logs}>{logText || "Waiting for Android runner…"}</pre>
          </>
        ) : (
          <div className={base.empty}>{loading ? "Loading Android build state…" : "No Android build started in this session."}</div>
        )}
      </section>

      <section className={base.panel}>
        <div className={base.panelTitle}>
          <div><strong>APK & AAB packages</strong><span>Versioned, checksummed Android outputs stored in Kosh Packages.</span></div>
          <Link href={packagesHref}>Open Packages</Link>
        </div>
        <div className={base.artifacts}>
          {packages.map((item) => (
            <a
              key={item.id}
              href={`${resourceBase}/packages/${encodeURIComponent(item.packageKey)}/versions/${encodeURIComponent(item.version)}/download`}
            >
              <div>
                <strong>{item.filename}</strong>
                <span className={base.mono}>{item.version} · {item.sha256.slice(0, 16)}…</span>
              </div>
              <em>{sizeLabel(item.sizeBytes)} · Download</em>
            </a>
          ))}
          {!packages.length ? <div className={base.empty}>Generated APK and AAB packages will appear here after a successful Kosh Android build.</div> : null}
        </div>
      </section>
    </main>
  );
}
