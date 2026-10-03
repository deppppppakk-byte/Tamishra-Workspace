"use client";

import { useEffect, useState } from "react";
import { KoshWorkspace } from "../apps/kosh/KoshWorkspace";
import styles from "./kosh-app.module.css";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function KoshStandalone() {
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/kosh-sw.js", { scope: "/" }).catch(() => undefined);
    }

    const handleInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
    };
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener("beforeinstallprompt", handleInstallPrompt);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleInstallPrompt);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
    setInstallPrompt(null);
  };

  return (
    <main className={styles.shell}>
      <div className={styles.appBar}>
        <div>
          <strong>Kosh</strong>
          <span className={styles.subtitle}>Developer platform by Tamishra</span>
        </div>
        <div className={styles.actions}>
          <span className={online ? styles.online : styles.offline}>
            {online ? "Online" : "Offline"}
          </span>
          {installPrompt ? (
            <button className={styles.installButton} type="button" onClick={() => void install()}>
              Install app
            </button>
          ) : null}
        </div>
      </div>
      <KoshWorkspace />
    </main>
  );
}
