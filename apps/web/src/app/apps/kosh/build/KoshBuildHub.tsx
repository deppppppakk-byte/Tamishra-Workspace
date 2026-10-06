"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./build.module.css";

export function KoshBuildHub() {
  const [query, setQuery] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const namespace = params.get("namespace")?.trim() || "tamishra";
    const slug = params.get("slug")?.trim() || "kavyn-2d";
    setQuery(`namespace=${encodeURIComponent(namespace)}&slug=${encodeURIComponent(slug)}`);
  }, []);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href={query ? `/apps/kosh/repository?${query}` : "/apps/kosh"}>← Repository</Link>
          <p>KOSH BUILD</p>
          <h1>Build Center</h1>
          <span>Build Windows EXE, Android APK and AAB directly from the browser. Kosh manages the queue and assigns build capacity automatically.</span>
        </div>
      </header>

      <section className={styles.grid}>
        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Quick Build</strong><span>Recommended browser-only build flow.</span></div>
          </div>
          <p className={styles.hint}>Choose EXE or APK/AAB and press Build. Kosh detects the project toolchain, queues the work, assigns managed build capacity and returns downloadable files.</p>
          <Link className={styles.primary} href={query ? `/apps/kosh/build/quick?${query}` : "/apps/kosh/build/quick"}>Open Quick Build</Link>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Production Readiness</strong><span>Live blocker and certification checks.</span></div>
          </div>
          <p className={styles.hint}>Check managed build capacity, repository history, EXE/APK/AAB packages and stable releases. Kosh only shows READY when the real production requirements pass.</p>
          <Link className={styles.primary} href="/apps/kosh/build/readiness">Open Production Readiness</Link>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Import Repository</strong><span>Move Git history into Kosh from the browser.</span></div>
          </div>
          <p className={styles.hint}>Import an approved HTTPS Git source into the selected Kosh repository. Private source credentials are referenced from Kosh Secrets.</p>
          <Link className={styles.primary} href={query ? `/apps/kosh/migrate?${query}` : "/apps/kosh/migrate"}>Open Repository Import</Link>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Windows Advanced</strong><span>EXE, DLL and Windows release packages.</span></div>
          </div>
          <p className={styles.hint}>Choose a specific CMake/MSVC, .NET, Go, Rust, Flutter Windows, Electron or kavYN 2D build preset.</p>
          <Link className={styles.primary} href={query ? `/apps/kosh/build/windows?${query}` : "/apps/kosh/build/windows"}>Open Windows Builds</Link>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Android Advanced</strong><span>APK and AAB release packages.</span></div>
          </div>
          <p className={styles.hint}>Choose Capacitor, Flutter, native Gradle or React Native and optionally use Kosh-managed release signing.</p>
          <Link className={styles.primary} href={query ? `/apps/kosh/build/android?${query}` : "/apps/kosh/build/android"}>Open Android Builds</Link>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Android Releases</strong><span>Promote verified APK/AAB builds into versioned release channels.</span></div>
          </div>
          <p className={styles.hint}>Select a Kosh Android package set, create an immutable Git tag, attach checksummed APK/AAB files, and publish to stable, beta or another release channel.</p>
          <Link className={styles.primary} href={query ? `/apps/kosh/build/android/release?${query}` : "/apps/kosh/build/android/release"}>Open Android Release Center</Link>
        </article>
      </section>
    </main>
  );
}
