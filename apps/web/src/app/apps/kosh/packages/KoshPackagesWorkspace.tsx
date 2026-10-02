"use client";

import Link from "next/link";
import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./packages.module.css";

type PackageVersion = {
  id: string;
  repositoryId: string;
  packageKey: string;
  name: string;
  version: string;
  filename: string;
  format: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  state: "published" | "yanked";
  commitSha: string | null;
  runId: string | null;
  provenance: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
};

type PackageChannel = {
  id: string;
  packageKey: string;
  channel: string;
  versionId: string;
  version: string;
  updatedByName: string;
  updatedAt: string;
};

type PackageGroup = {
  key: string;
  name: string;
  versions: PackageVersion[];
  channels: PackageChannel[];
};

type RegistryPayload = {
  packages: PackageGroup[];
  versions: PackageVersion[];
  channels: PackageChannel[];
  persistence: string;
  maxPackageBytes: number;
};

type AccessPayload = {
  permissions: string[];
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function age(value: string) {
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";
  return Math.floor(hours / 24) + "d";
}

function bytes(value: number) {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  if (value < 1024 * 1024 * 1024) {
    return (value / (1024 * 1024)).toFixed(1) + " MB";
  }
  return (value / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

export function KoshPackagesWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [payload, setPayload] = useState<RegistryPayload | null>(null);
  const [access, setAccess] = useState<AccessPayload | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [packageKey, setPackageKey] = useState("");
  const [packageName, setPackageName] = useState("");
  const [version, setVersion] = useState("");
  const [format, setFormat] = useState("generic");
  const [channel, setChannel] = useState("latest");
  const [promoteChannel, setPromoteChannel] = useState("latest");
  const [promoteVersion, setPromoteVersion] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setNamespace(params.get("namespace")?.trim() ?? "");
    setSlug(params.get("slug")?.trim() ?? "");
  }, []);

  const resourceBase = useMemo(() => {
    if (!namespace || !slug) return "";
    return (
      base +
      "/v1/kosh/repos/" +
      encodeURIComponent(namespace) +
      "/" +
      encodeURIComponent(slug)
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
    const body = (await response.json()) as T & { error?: string };
    if (!response.ok) throw new Error(body.error || "Kosh request failed.");
    return body;
  }, []);

  const load = useCallback(async () => {
    if (!resourceBase) return;
    setLoading(true);
    setError("");
    try {
      const [registry, accessPayload] = await Promise.all([
        fetchJson<RegistryPayload>(resourceBase + "/packages"),
        fetchJson<AccessPayload>(resourceBase + "/access")
      ]);
      setPayload(registry);
      setAccess(accessPayload);

      const params = new URLSearchParams(window.location.search);
      const requested = params.get("package")?.trim() ?? "";
      const next =
        requested && registry.packages.some((item) => item.key === requested)
          ? requested
          : selectedKey && registry.packages.some((item) => item.key === selectedKey)
            ? selectedKey
            : registry.packages[0]?.key ?? "";
      setSelectedKey(next);
      if (!packageKey && slug) {
        setPackageKey(slug);
        setPackageName(slug);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Packages.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson, packageKey, resourceBase, selectedKey, slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const canPublish = Boolean(access?.permissions.includes("packages.publish"));
  const selected = payload?.packages.find((item) => item.key === selectedKey) ?? null;

  async function publish() {
    if (!resourceBase || !file || !packageKey.trim() || !version.trim()) return;
    setMutating(true);
    setError("");
    setNotice("");

    try {
      if (payload && file.size > payload.maxPackageBytes) {
        throw new Error("Package exceeds registry size limit.");
      }

      const params = new URLSearchParams({
        key: packageKey.trim(),
        name: packageName.trim() || packageKey.trim(),
        version: version.trim(),
        filename: file.name,
        format: format.trim() || "generic"
      });
      if (channel.trim()) params.set("channel", channel.trim());

      const response = await fetch(resourceBase + "/packages/publish?" + params, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": file.type || "application/octet-stream"
        },
        body: file
      });
      const body = (await response.json()) as {
        error?: string;
        version?: PackageVersion;
      };
      if (!response.ok) throw new Error(body.error || "Package publish failed.");

      setNotice(
        "Published " + packageKey.trim() + "@" + version.trim() + "."
      );
      setFile(null);
      setVersion("");
      setSelectedKey(packageKey.trim());
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Package publish failed.");
    } finally {
      setMutating(false);
    }
  }

  async function promote() {
    if (!resourceBase || !selected || !promoteChannel.trim() || !promoteVersion) return;
    setMutating(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(
        resourceBase +
          "/packages/" +
          encodeURIComponent(selected.key) +
          "/channels/" +
          encodeURIComponent(promoteChannel.trim()),
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ version: promoteVersion })
        }
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Channel promotion failed.");
      setNotice(
        "Channel " + promoteChannel.trim() + " now points to " + promoteVersion + "."
      );
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Channel promotion failed.");
    } finally {
      setMutating(false);
    }
  }

  async function yank(item: PackageVersion, nextYanked: boolean) {
    if (!resourceBase) return;
    setMutating(true);
    setError("");
    try {
      const response = await fetch(
        resourceBase +
          "/packages/" +
          encodeURIComponent(item.packageKey) +
          "/versions/" +
          encodeURIComponent(item.version) +
          "/yank",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ yanked: nextYanked })
        }
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Package state update failed.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Package state update failed.");
    } finally {
      setMutating(false);
    }
  }

  async function verify(item: PackageVersion) {
    if (!resourceBase) return;
    setMutating(true);
    setError("");
    setNotice("");
    try {
      const result = await fetchJson<{
        valid: boolean;
        sha256: string;
        sizeBytes: number;
      }>(
        resourceBase +
          "/packages/" +
          encodeURIComponent(item.packageKey) +
          "/versions/" +
          encodeURIComponent(item.version) +
          "/verify"
      );
      setNotice(
        result.valid
          ? "Integrity verified: " + result.sha256.slice(0, 16) + "…"
          : "Integrity verification failed."
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Integrity check failed.");
    } finally {
      setMutating(false);
    }
  }

  async function download(item: PackageVersion) {
    if (!resourceBase) return;
    setError("");
    try {
      const response = await fetch(
        resourceBase +
          "/packages/" +
          encodeURIComponent(item.packageKey) +
          "/versions/" +
          encodeURIComponent(item.version) +
          "/download",
        { credentials: "include" }
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error || "Package download failed.");
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = item.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Package download failed.");
    }
  }

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
  }

  if (loading && !payload) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Packages</strong>
        <span>Loading registry…</span>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className={styles.loading}>
        <strong>Registry unavailable</strong>
        <span>{error || "Kosh Packages could not be loaded."}</span>
        <Link href={repositoryHref}>Back to repository</Link>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH PACKAGES</p>
          <h1>{namespace}/{slug}</h1>
          <span>
            Immutable package versions, verified artifacts, provenance and mutable delivery channels.
          </span>
        </div>
        <div className={styles.headerStats}>
          <div>
            <strong>{payload.packages.length}</strong>
            <span>packages</span>
          </div>
          <div>
            <strong>{payload.versions.length}</strong>
            <span>versions</span>
          </div>
          <div>
            <strong>{payload.channels.length}</strong>
            <span>channels</span>
          </div>
        </div>
      </header>

      <section className={styles.content}>
        {error && <div className={styles.error}>{error}</div>}
        {notice && <div className={styles.notice}>{notice}</div>}

        <div className={styles.grid}>
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Registry</strong>
                <span>Choose a package to inspect its immutable history</span>
              </div>
            </div>
            <div className={styles.packageList}>
              {payload.packages.map((item) => (
                <button
                  key={item.key}
                  className={selectedKey === item.key ? styles.selectedPackage : ""}
                  onClick={() => {
                    setSelectedKey(item.key);
                    setPromoteVersion(item.versions.find((v) => v.state === "published")?.version ?? "");
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>{item.key}</span>
                  <em>
                    {item.versions.length} versions · {item.channels.length} channels
                  </em>
                </button>
              ))}
              {!payload.packages.length && (
                <div className={styles.empty}>No packages published yet.</div>
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Publish</strong>
                <span>Versions are immutable after successful publish</span>
              </div>
            </div>
            {canPublish ? (
              <div className={styles.form}>
                <label>
                  <span>Package key</span>
                  <input value={packageKey} onChange={(e) => setPackageKey(e.target.value)} />
                </label>
                <label>
                  <span>Display name</span>
                  <input value={packageName} onChange={(e) => setPackageName(e.target.value)} />
                </label>
                <label>
                  <span>Version</span>
                  <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" />
                </label>
                <label>
                  <span>Format</span>
                  <input value={format} onChange={(e) => setFormat(e.target.value)} placeholder="generic" />
                </label>
                <label>
                  <span>Channel</span>
                  <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="latest" />
                </label>
                <label className={styles.wide}>
                  <span>Artifact</span>
                  <input type="file" onChange={selectFile} />
                </label>
                {file && (
                  <small>
                    {file.name} · {bytes(file.size)} · limit {bytes(payload.maxPackageBytes)}
                  </small>
                )}
                <button
                  disabled={mutating || !file || !packageKey.trim() || !version.trim()}
                  onClick={() => void publish()}
                >
                  Publish version
                </button>
              </div>
            ) : (
              <div className={styles.empty}>
                Your repository role does not include package publishing.
              </div>
            )}
          </section>
        </div>

        {selected && (
          <>
            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <strong>{selected.name}</strong>
                  <span>{selected.key}</span>
                </div>
              </div>
              <div className={styles.channelBar}>
                {selected.channels.map((item) => (
                  <div key={item.id}>
                    <strong>{item.channel}</strong>
                    <span>→ {item.version}</span>
                    <em>{item.updatedByName} · {age(item.updatedAt)}</em>
                  </div>
                ))}
                {!selected.channels.length && <span>No channels yet.</span>}
              </div>
              {canPublish && (
                <div className={styles.promote}>
                  <input
                    value={promoteChannel}
                    onChange={(e) => setPromoteChannel(e.target.value)}
                    placeholder="channel"
                  />
                  <select
                    value={promoteVersion}
                    onChange={(e) => setPromoteVersion(e.target.value)}
                  >
                    <option value="">Choose version</option>
                    {selected.versions
                      .filter((item) => item.state === "published")
                      .map((item) => (
                        <option key={item.id} value={item.version}>
                          {item.version}
                        </option>
                      ))}
                  </select>
                  <button disabled={mutating || !promoteVersion} onClick={() => void promote()}>
                    Promote channel
                  </button>
                </div>
              )}
            </section>

            <section className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <strong>Versions</strong>
                  <span>Artifact bytes are checksum-verified before download</span>
                </div>
              </div>
              <div className={styles.versions}>
                {selected.versions.map((item) => (
                  <article key={item.id}>
                    <div className={styles.versionIdentity}>
                      <span className={item.state === "yanked" ? styles.yanked : styles.published}>
                        {item.state}
                      </span>
                      <strong>{item.version}</strong>
                      <small>{item.filename} · {bytes(item.sizeBytes)} · {item.format}</small>
                    </div>
                    <div className={styles.provenance}>
                      <code>sha256:{item.sha256.slice(0, 20)}…</code>
                      <span>
                        {item.commitSha ? item.commitSha.slice(0, 12) : "manual"} · {item.createdByName} · {age(item.createdAt)}
                      </span>
                    </div>
                    <div className={styles.actions}>
                      <button disabled={mutating || item.state === "yanked"} onClick={() => void download(item)}>
                        Download
                      </button>
                      <button disabled={mutating} onClick={() => void verify(item)}>
                        Verify
                      </button>
                      {canPublish && (
                        <button
                          disabled={mutating}
                          onClick={() => void yank(item, item.state !== "yanked")}
                        >
                          {item.state === "yanked" ? "Restore" : "Yank"}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </section>
    </main>
  );
}
