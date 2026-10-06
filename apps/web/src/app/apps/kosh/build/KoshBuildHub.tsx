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
          <span>Compile native desktop and Android release packages using Kosh-owned runners, then promote verified builds through Kosh Releases.</span>
        </div>
      </header>

      <section className={styles.grid}>
        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Windows</strong><span>EXE, DLL and Windows release packages.</span></div>
          </div>
          <p className={styles.hint}>CMake/MSVC, .NET, Go, Rust, Flutter Windows, Electron and the dedicated kavYN 2D packaging pipeline.</p>
          <Link className={styles.primary} href={query ? `/apps/kosh/build/windows?${query}` : "/apps/kosh/build/windows"}>Open Windows Builds</Link>
        </article>

        <article className={styles.panel}>
          <div className={styles.panelTitle}>
            <div><strong>Android</strong><span>APK and AAB release packages.</span></div>
          </div>
          <p className={styles.hint}>Capacitor, Flutter, native Gradle and React Native, with optional Kosh-managed release signing.</p>
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
