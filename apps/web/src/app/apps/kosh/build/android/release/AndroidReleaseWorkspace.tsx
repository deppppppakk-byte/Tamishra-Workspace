"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./release.module.css";

type RepoSummary = {
  repository: { defaultBranch: string; name?: string };
  headSha: string | null;
};

type PackageVersion = {
  id: string;
  packageKey: string;
  name: string;
  version: string;
  filename: string;
  format: string;
  sizeBytes: number;
  sha256: string;
  state: "published" | "yanked";
  createdAt: string;
};

type Release = {
  id: string;
  tag: string;
  name: string;
  notes: string;
  commitSha: string;
  state: "draft" | "published" | "archived";
  prerelease: boolean;
  createdAt: string;
  publishedAt: string | null;
  packages: Array<{
    packageVersionId: string;
    packageKey: string;
    version: string;
    sha256: string;
  }>;
  channels: Array<{ channel: string }>;
};

type AccessPayload = { permissions: string[] };

type ReleasePayload = { releases: Release[] };
type PackagePayload = { versions: PackageVersion[] };

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

function age(value: string | null) {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function AndroidReleaseWorkspace() {
  const gateway = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [repo, setRepo] = useState<RepoSummary | null>(null);
  const [packages, setPackages] = useState<PackageVersion[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [access, setAccess] = useState<AccessPayload | null>(null);
  const [selectedVersion, setSelectedVersion] = useState("");
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [channel, setChannel] = useState("stable");
  const [prerelease, setPrerelease] = useState(false);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() || "tamishra");
    setSlug(params.get("slug")?.trim() || "kosh-mobile");
  }, []);

  const resourceBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return `${gateway}/v1/kosh/repos/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`;
  }, [gateway, namespace, slug]);

  const query = `namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(slug)}`;
  const androidHref = `/apps/kosh/build/android?${query}`;
  const releasesHref = `/apps/kosh/releases?${query}`;
  const repositoryHref = `/apps/kosh/repository?${query}`;

  const fetchJson = useCallback(async <T,>(url: string): Promise<T> => {
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(payload.error || `Kosh request failed (${response.status}).`);
    return payload;
  }, []);

  const load = useCallback(async () => {
    if (!resourceBase) return;
    setLoading(true);
    try {
      const [repoPayload, packagePayload, releasePayload, accessPayload] = await Promise.all([
        fetchJson<RepoSummary>(resourceBase),
        fetchJson<PackagePayload>(`${resourceBase}/packages`),
        fetchJson<ReleasePayload>(`${resourceBase}/releases`),
        fetchJson<AccessPayload>(`${resourceBase}/access`)
      ]);

      const androidPackages = (packagePayload.versions || [])
        .filter((item) => item.state === "published" && /\.(apk|aab)$/i.test(item.filename))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

      setRepo(repoPayload);
      setPackages(androidPackages);
      setReleases(releasePayload.releases || []);
      setAccess(accessPayload);
      setSelectedVersion((current) => current || androidPackages[0]?.version || "");
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Android releases.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, resourceBase]);

  useEffect(() => void load(), [load]);

  const versions = useMemo(() => {
    const groups = new Map<string, PackageVersion[]>();
    for (const item of packages) {
      const list = groups.get(item.version) || [];
      list.push(item);
      groups.set(item.version, list);
    }
    return [...groups.entries()].map(([version, items]) => ({ version, items }));
  }, [packages]);

  const selectedPackages = useMemo(
    () => packages.filter((item) => item.version === selectedVersion),
    [packages, selectedVersion]
  );

  useEffect(() => {
    if (!selectedVersion) return;
    setTag((current) => current || `android-${selectedVersion}`);
    setName((current) => current || `Android ${selectedVersion}`);
  }, [selectedVersion]);

  const canManage = Boolean(access?.permissions.includes("releases.manage"));

  async function publishRelease() {
    if (!resourceBase || !repo?.headSha || !tag.trim() || !name.trim() || !selectedPackages.length) return;
    setPublishing(true);
    setError("");
    setNotice("");

    try {
      const createResponse = await fetch(`${resourceBase}/releases`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tag: tag.trim(),
          name: name.trim(),
          notes: notes.trim(),
          ref: repo.headSha,
          prerelease,
          packageVersionIds: selectedPackages.map((item) => item.id)
        })
      });
      const created = (await createResponse.json()) as Release & { error?: string };
      if (!createResponse.ok) throw new Error(created.error || "Android release creation failed.");

      const publishResponse = await fetch(
        `${resourceBase}/releases/${encodeURIComponent(created.tag)}/publish`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ channel: channel.trim() || null })
        }
      );
      const published = (await publishResponse.json()) as { error?: string };
      if (!publishResponse.ok) throw new Error(published.error || "Android release publish failed.");

      setNotice(`Published ${created.tag}${channel.trim() ? ` to ${channel.trim()}` : ""} with ${selectedPackages.length} Android package(s).`);
      setTag("");
      setName("");
      setNotes("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Android release publish failed.");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH ANDROID RELEASES</p>
          <h1>Android Release Center</h1>
          <span>Promote checksummed APK and AAB packages into Git-anchored Kosh Releases and release channels.</span>
          <div className={styles.links}>
            <Link href={androidHref}>Android Builds</Link>
            <Link href={releasesHref}>Full Releases</Link>
          </div>
        </div>
        <div className={styles.status}>
          <span>Repository</span>
          <strong>{namespace}/{slug}</strong>
          <em>{repo?.headSha ? repo.headSha.slice(0, 12) : "No commit"}</em>
        </div>
      </header>

      {error ? <div className={styles.error}>{error}</div> : null}
      {notice ? <div className={styles.notice}>{notice}</div> : null}

      <section className={styles.grid}>
        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Android package set</strong><span>Select one APK/AAB build version.</span></div>
          </div>
          <div className={styles.versionList}>
            {versions.map(({ version, items }) => (
              <button
                key={version}
                className={selectedVersion === version ? styles.versionActive : styles.version}
                onClick={() => setSelectedVersion(version)}
                type="button"
              >
                <strong>{version}</strong>
                <span>{items.map((item) => item.format.toUpperCase()).join(" + ")} · {items.length} package{items.length === 1 ? "" : "s"}</span>
                <em>{age(items[0]?.createdAt || null)}</em>
              </button>
            ))}
            {!versions.length ? <div className={styles.empty}>{loading ? "Loading packages…" : "No published APK/AAB packages yet. Build Android first."}</div> : null}
          </div>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Publish release</strong><span>Creates an immutable Git tag and moves the selected channel.</span></div>
          </div>
          <label><span>Tag</span><input value={tag} onChange={(event) => setTag(event.target.value)} placeholder="android-build-abc123" /></label>
          <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Android release" /></label>
          <label><span>Channel</span><input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="stable" /></label>
          <label><span>Release notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="What changed in this Android release?" rows={4} /></label>
          <label className={styles.check}>
            <input type="checkbox" checked={prerelease} onChange={(event) => setPrerelease(event.target.checked)} />
            <span>Mark as prerelease</span>
          </label>
          <button
            className={styles.primary}
            type="button"
            disabled={!canManage || publishing || !repo?.headSha || !selectedPackages.length || !tag.trim() || !name.trim()}
            onClick={() => void publishRelease()}
          >
            {publishing ? "Publishing…" : `Publish ${selectedPackages.length || 0} Android package${selectedPackages.length === 1 ? "" : "s"}`}
          </button>
          {!canManage ? <p className={styles.hint}>Release management permission is required.</p> : null}
        </article>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Selected package integrity</strong><span>Every release keeps the Kosh package checksum.</span></div>
        </div>
        <div className={styles.packageList}>
          {selectedPackages.map((item) => (
            <a key={item.id} href={`${resourceBase}/packages/${encodeURIComponent(item.packageKey)}/versions/${encodeURIComponent(item.version)}/download`}>
              <div><strong>{item.filename}</strong><span>{item.format.toUpperCase()} · {sizeLabel(item.sizeBytes)}</span></div>
              <code>{item.sha256}</code>
            </a>
          ))}
          {!selectedPackages.length ? <div className={styles.empty}>Choose an Android package version.</div> : null}
        </div>
      </section>

      <section className={styles.panel}>
        <div className={styles.panelTitle}>
          <div><strong>Recent Android releases</strong><span>Published and draft Kosh releases that contain Android packages.</span></div>
          <Link href={releasesHref}>Manage all releases</Link>
        </div>
        <div className={styles.releaseList}>
          {releases
            .filter((item) => item.packages.some((linked) => packages.some((pkg) => pkg.id === linked.packageVersionId)))
            .slice(0, 10)
            .map((item) => (
              <Link key={item.id} href={`${releasesHref}&tag=${encodeURIComponent(item.tag)}`}>
                <div><strong>{item.tag}</strong><span>{item.name}</span></div>
                <div><em className={styles[item.state]}>{item.state}</em><span>{item.channels.map((entry) => entry.channel).join(", ") || "no channel"}</span></div>
                <code>{item.commitSha.slice(0, 12)}</code>
              </Link>
            ))}
          {!releases.length ? <div className={styles.empty}>No Kosh releases yet.</div> : null}
        </div>
      </section>
    </main>
  );
}
