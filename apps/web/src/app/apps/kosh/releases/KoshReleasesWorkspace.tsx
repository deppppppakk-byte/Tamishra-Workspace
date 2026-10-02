"use client";

import Link from "next/link";
import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./releases.module.css";

type ReleaseAsset = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

type ReleasePackage = {
  id: string;
  packageVersionId: string;
  packageKey: string;
  version: string;
  sha256: string;
  createdAt: string;
};

type ReleaseChannel = {
  id: string;
  channel: string;
  releaseId: string;
  tag: string;
  updatedByName: string;
  updatedAt: string;
};

type Release = {
  id: string;
  tag: string;
  name: string;
  notes: string;
  commitSha: string;
  state: "draft" | "published" | "archived";
  prerelease: boolean;
  provenance: Record<string, unknown>;
  createdByName: string;
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
  assets: ReleaseAsset[];
  packages: ReleasePackage[];
  channels: ReleaseChannel[];
};

type ReleasesPayload = {
  releases: Release[];
  channels: ReleaseChannel[];
  persistence: string;
  maxAssetBytes: number;
};

type PackageVersion = {
  id: string;
  packageKey: string;
  name: string;
  version: string;
  filename: string;
  state: "published" | "yanked";
  sha256: string;
  createdAt: string;
};

type PackagesPayload = {
  versions: PackageVersion[];
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

function age(value: string | null) {
  if (!value) return "—";
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return value;
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h";
  return Math.floor(hours / 24) + "d";
}

function sizeLabel(value: number) {
  if (value < 1024) return value + " B";
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
  if (value < 1024 * 1024 * 1024) {
    return (value / (1024 * 1024)).toFixed(1) + " MB";
  }
  return (value / (1024 * 1024 * 1024)).toFixed(1) + " GB";
}

export function KoshReleasesWorkspace() {
  const base = useMemo(apiBase, []);
  const [namespace, setNamespace] = useState("");
  const [slug, setSlug] = useState("");
  const [payload, setPayload] = useState<ReleasesPayload | null>(null);
  const [packages, setPackages] = useState<PackageVersion[]>([]);
  const [access, setAccess] = useState<AccessPayload | null>(null);
  const [selectedTag, setSelectedTag] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);

  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [refName, setRefName] = useState("");
  const [prerelease, setPrerelease] = useState(false);
  const [selectedPackages, setSelectedPackages] = useState<string[]>([]);

  const [assetFile, setAssetFile] = useState<File | null>(null);
  const [publishChannel, setPublishChannel] = useState("stable");
  const [promoteChannel, setPromoteChannel] = useState("stable");
  const [promoteTag, setPromoteTag] = useState("");

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
      const [releasePayload, packagePayload, accessPayload] =
        await Promise.all([
          fetchJson<ReleasesPayload>(resourceBase + "/releases"),
          fetchJson<PackagesPayload>(resourceBase + "/packages"),
          fetchJson<AccessPayload>(resourceBase + "/access")
        ]);

      setPayload(releasePayload);
      setPackages(
        packagePayload.versions.filter((item) => item.state === "published")
      );
      setAccess(accessPayload);

      const params = new URLSearchParams(window.location.search);
      const requested = params.get("tag")?.trim() ?? "";
      const next =
        requested &&
        releasePayload.releases.some((item) => item.tag === requested)
          ? requested
          : selectedTag &&
              releasePayload.releases.some((item) => item.tag === selectedTag)
            ? selectedTag
            : releasePayload.releases[0]?.tag ?? "";
      setSelectedTag(next);
      if (!promoteTag && releasePayload.releases.length) {
        setPromoteTag(
          releasePayload.releases.find((item) => item.state === "published")
            ?.tag ?? ""
        );
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load Releases."
      );
    } finally {
      setLoading(false);
    }
  }, [fetchJson, promoteTag, resourceBase, selectedTag]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected =
    payload?.releases.find((item) => item.tag === selectedTag) ?? null;
  const canManage = Boolean(
    access?.permissions.includes("releases.manage")
  );

  async function createDraft() {
    if (!resourceBase || !tag.trim() || !name.trim()) return;
    setMutating(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(resourceBase + "/releases", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tag: tag.trim(),
          name: name.trim(),
          notes,
          ref: refName.trim(),
          prerelease,
          packageVersionIds: selectedPackages
        })
      });
      const body = (await response.json()) as Release & { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Release creation failed.");
      }

      setSelectedTag(body.tag);
      setTag("");
      setName("");
      setNotes("");
      setRefName("");
      setPrerelease(false);
      setSelectedPackages([]);
      setNotice("Draft release " + body.tag + " created and Git tag anchored.");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Release creation failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function uploadAsset() {
    if (!resourceBase || !selected || !assetFile) return;
    setMutating(true);
    setError("");
    setNotice("");

    try {
      if (payload && assetFile.size > payload.maxAssetBytes) {
        throw new Error("Release asset exceeds configured size limit.");
      }

      const params = new URLSearchParams({
        filename: assetFile.name,
        mediaType: assetFile.type || "application/octet-stream"
      });
      const response = await fetch(
        resourceBase +
          "/releases/" +
          encodeURIComponent(selected.tag) +
          "/assets?" +
          params,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": assetFile.type || "application/octet-stream"
          },
          body: assetFile
        }
      );
      const body = (await response.json()) as ReleaseAsset & { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Release asset upload failed.");
      }

      setAssetFile(null);
      setNotice("Added immutable asset " + body.filename + ".");
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Release asset upload failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function linkPackage(packageVersionId: string) {
    if (!resourceBase || !selected) return;
    setMutating(true);
    setError("");
    try {
      const response = await fetch(
        resourceBase +
          "/releases/" +
          encodeURIComponent(selected.tag) +
          "/packages",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ packageVersionId })
        }
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Could not link package.");
      }
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not link package."
      );
    } finally {
      setMutating(false);
    }
  }

  async function publish() {
    if (!resourceBase || !selected) return;
    setMutating(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(
        resourceBase +
          "/releases/" +
          encodeURIComponent(selected.tag) +
          "/publish",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: publishChannel.trim() || null
          })
        }
      );
      const body = (await response.json()) as {
        release?: Release;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error || "Release publish failed.");
      }
      setNotice(
        "Published " +
          selected.tag +
          (publishChannel.trim()
            ? " to channel " + publishChannel.trim() + "."
            : ".")
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Release publish failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function archive() {
    if (!resourceBase || !selected) return;
    setMutating(true);
    setError("");
    try {
      const response = await fetch(
        resourceBase +
          "/releases/" +
          encodeURIComponent(selected.tag) +
          "/archive",
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      );
      const body = (await response.json()) as Release & { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Release archive failed.");
      }
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Release archive failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function promote() {
    if (!resourceBase || !promoteChannel.trim() || !promoteTag) return;
    setMutating(true);
    setError("");
    setNotice("");

    try {
      const response = await fetch(
        resourceBase +
          "/releases/channels/" +
          encodeURIComponent(promoteChannel.trim()),
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tag: promoteTag })
        }
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || "Release channel promotion failed.");
      }
      setNotice(
        "Channel " + promoteChannel.trim() + " now points to " + promoteTag + "."
      );
      await load();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Release channel promotion failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function verifyAsset(asset: ReleaseAsset) {
    if (!resourceBase || !selected) return;
    setMutating(true);
    setError("");
    setNotice("");
    try {
      const result = await fetchJson<{ valid: boolean; sha256: string }>(
        resourceBase +
          "/releases/" +
          encodeURIComponent(selected.tag) +
          "/assets/" +
          encodeURIComponent(asset.id) +
          "/verify"
      );
      setNotice(
        result.valid
          ? "Asset integrity verified: " + result.sha256.slice(0, 16) + "…"
          : "Asset integrity check failed."
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Asset verification failed."
      );
    } finally {
      setMutating(false);
    }
  }

  async function downloadAsset(asset: ReleaseAsset) {
    if (!resourceBase || !selected) return;
    setError("");
    try {
      const response = await fetch(
        resourceBase +
          "/releases/" +
          encodeURIComponent(selected.tag) +
          "/assets/" +
          encodeURIComponent(asset.id),
        { credentials: "include" }
      );
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error || "Asset download failed.");
      }
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = asset.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Asset download failed."
      );
    }
  }

  function selectAsset(event: ChangeEvent<HTMLInputElement>) {
    setAssetFile(event.target.files?.[0] ?? null);
  }

  if (loading && !payload) {
    return (
      <main className={styles.loading}>
        <strong>Kosh Releases</strong>
        <span>Loading release history…</span>
      </main>
    );
  }

  if (!payload) {
    return (
      <main className={styles.loading}>
        <strong>Releases unavailable</strong>
        <span>{error || "Kosh Releases could not be loaded."}</span>
        <Link href={repositoryHref}>Back to repository</Link>
      </main>
    );
  }

  const linkedIds = new Set(selected?.packages.map((item) => item.packageVersionId) ?? []);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={repositoryHref}>← Repository</Link>
          <p>KOSH RELEASES</p>
          <h1>{namespace}/{slug}</h1>
          <span>
            Git-anchored releases with immutable packages, verified assets and promotion channels.
          </span>
        </div>
        <div className={styles.headerStats}>
          <div>
            <strong>{payload.releases.length}</strong>
            <span>releases</span>
          </div>
          <div>
            <strong>
              {payload.releases.filter((item) => item.state === "published").length}
            </strong>
            <span>published</span>
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
                <strong>Release history</strong>
                <span>Each release is anchored to a real Git tag and commit</span>
              </div>
            </div>
            <div className={styles.releaseList}>
              {payload.releases.map((item) => (
                <button
                  key={item.id}
                  className={selectedTag === item.tag ? styles.selectedRelease : ""}
                  onClick={() => setSelectedTag(item.tag)}
                >
                  <span className={styles[item.state]}>{item.state}</span>
                  <strong>{item.tag}</strong>
                  <small>{item.name}</small>
                  <em>{item.commitSha.slice(0, 12)} · {age(item.updatedAt)}</em>
                </button>
              ))}
              {!payload.releases.length && (
                <div className={styles.empty}>No releases yet.</div>
              )}
            </div>
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Create draft</strong>
                <span>The Git tag is created immediately; it locks on publish</span>
              </div>
            </div>
            {canManage ? (
              <div className={styles.form}>
                <label>
                  <span>Tag</span>
                  <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="v1.0.0" />
                </label>
                <label>
                  <span>Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Kosh 1.0" />
                </label>
                <label className={styles.wide}>
                  <span>Git ref</span>
                  <input value={refName} onChange={(e) => setRefName(e.target.value)} placeholder="blank = default branch" />
                </label>
                <label className={styles.wide}>
                  <span>Notes</span>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={5} />
                </label>
                <label className={styles.check}>
                  <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} />
                  <span>Prerelease</span>
                </label>
                <div className={styles.packageChooser}>
                  <strong>Initial package links</strong>
                  {packages.map((item) => (
                    <label key={item.id}>
                      <input
                        type="checkbox"
                        checked={selectedPackages.includes(item.id)}
                        onChange={(e) =>
                          setSelectedPackages((current) =>
                            e.target.checked
                              ? [...current, item.id]
                              : current.filter((id) => id !== item.id)
                          )
                        }
                      />
                      <span>{item.packageKey}@{item.version}</span>
                    </label>
                  ))}
                </div>
                <button
                  disabled={mutating || !tag.trim() || !name.trim()}
                  onClick={() => void createDraft()}
                >
                  Create draft release
                </button>
              </div>
            ) : (
              <div className={styles.empty}>Your repository role cannot manage releases.</div>
            )}
          </section>
        </div>

        {selected && (
          <>
            <section className={styles.panel}>
              <div className={styles.releaseHeader}>
                <div>
                  <span className={styles[selected.state]}>{selected.state}</span>
                  <h2>{selected.tag} · {selected.name}</h2>
                  <p>{selected.notes || "No release notes."}</p>
                  <code>{selected.commitSha}</code>
                </div>
                <div>
                  <span>{selected.prerelease ? "Prerelease" : "Release"}</span>
                  <strong>{selected.createdByName}</strong>
                  <em>
                    created {age(selected.createdAt)}
                    {selected.publishedAt ? " · published " + age(selected.publishedAt) : ""}
                  </em>
                </div>
              </div>

              <div className={styles.channelBar}>
                {selected.channels.map((item) => (
                  <div key={item.id}>
                    <strong>{item.channel}</strong>
                    <span>→ {item.tag}</span>
                    <em>{item.updatedByName} · {age(item.updatedAt)}</em>
                  </div>
                ))}
                {!selected.channels.length && <span>No channel points here.</span>}
              </div>

              {canManage && selected.state === "draft" && (
                <div className={styles.publishBar}>
                  <input
                    value={publishChannel}
                    onChange={(e) => setPublishChannel(e.target.value)}
                    placeholder="stable"
                  />
                  <button disabled={mutating} onClick={() => void publish()}>
                    Verify & publish
                  </button>
                </div>
              )}

              {canManage && selected.state === "published" && (
                <div className={styles.publishBar}>
                  <button disabled={mutating} onClick={() => void archive()}>
                    Archive release
                  </button>
                </div>
              )}
            </section>

            <div className={styles.grid}>
              <section className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <strong>Package evidence</strong>
                    <span>Linked versions are checksum-verified before publication</span>
                  </div>
                </div>
                <div className={styles.evidenceList}>
                  {selected.packages.map((item) => (
                    <article key={item.id}>
                      <strong>{item.packageKey}@{item.version}</strong>
                      <code>sha256:{item.sha256.slice(0, 20)}…</code>
                    </article>
                  ))}
                  {!selected.packages.length && (
                    <div className={styles.empty}>No linked package versions.</div>
                  )}
                </div>
                {canManage && selected.state === "draft" && (
                  <div className={styles.linkPackages}>
                    {packages
                      .filter((item) => !linkedIds.has(item.id))
                      .map((item) => (
                        <button
                          key={item.id}
                          disabled={mutating}
                          onClick={() => void linkPackage(item.id)}
                        >
                          + {item.packageKey}@{item.version}
                        </button>
                      ))}
                  </div>
                )}
              </section>

              <section className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div>
                    <strong>Release assets</strong>
                    <span>Immutable files with SHA-256 integrity</span>
                  </div>
                </div>
                {canManage && selected.state === "draft" && (
                  <div className={styles.assetUpload}>
                    <input type="file" onChange={selectAsset} />
                    <button disabled={mutating || !assetFile} onClick={() => void uploadAsset()}>
                      Add asset
                    </button>
                    {assetFile && (
                      <small>
                        {assetFile.name} · {sizeLabel(assetFile.size)} · limit {sizeLabel(payload.maxAssetBytes)}
                      </small>
                    )}
                  </div>
                )}
                <div className={styles.assetList}>
                  {selected.assets.map((asset) => (
                    <article key={asset.id}>
                      <div>
                        <strong>{asset.filename}</strong>
                        <span>{sizeLabel(asset.sizeBytes)} · {asset.mediaType}</span>
                        <code>sha256:{asset.sha256.slice(0, 20)}…</code>
                      </div>
                      <div>
                        <button disabled={mutating} onClick={() => void verifyAsset(asset)}>Verify</button>
                        <button disabled={mutating} onClick={() => void downloadAsset(asset)}>Download</button>
                      </div>
                    </article>
                  ))}
                  {!selected.assets.length && (
                    <div className={styles.empty}>No release assets.</div>
                  )}
                </div>
              </section>
            </div>
          </>
        )}

        {canManage && payload.releases.some((item) => item.state === "published") && (
          <section className={styles.panel}>
            <div className={styles.panelHeader}>
              <div>
                <strong>Release channels</strong>
                <span>Move a channel between already-published releases</span>
              </div>
            </div>
            <div className={styles.promote}>
              <input
                value={promoteChannel}
                onChange={(e) => setPromoteChannel(e.target.value)}
                placeholder="stable"
              />
              <select
                value={promoteTag}
                onChange={(e) => setPromoteTag(e.target.value)}
              >
                <option value="">Choose release</option>
                {payload.releases
                  .filter((item) => item.state === "published")
                  .map((item) => (
                    <option key={item.id} value={item.tag}>{item.tag}</option>
                  ))}
              </select>
              <button
                disabled={mutating || !promoteChannel.trim() || !promoteTag}
                onClick={() => void promote()}
              >
                Promote channel
              </button>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
