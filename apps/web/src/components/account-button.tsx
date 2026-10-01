"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  workspaceApi,
  type WorkspaceSessionResponse
} from "../lib/workspace-api";
import styles from "./account-button.module.css";

export function AccountButton() {
  const [session, setSession] = useState<WorkspaceSessionResponse | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    workspaceApi<WorkspaceSessionResponse>("/v1/auth/session")
      .then((value) => {
        if (alive) setSession(value);
      })
      .catch(() => {
        if (alive) setSession({ authenticated: false });
      });

    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("mousedown", onPointer);
    return () => {
      alive = false;
      window.removeEventListener("mousedown", onPointer);
    };
  }, []);

  if (!session?.authenticated) {
    return (
      <Link className={styles.signIn} href="/sign-in">
        Sign in
      </Link>
    );
  }

  const initials = session.user.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "T";

  async function signOut() {
    try {
      await workspaceApi("/v1/auth/sign-out", { method: "POST" });
    } finally {
      setSession({ authenticated: false });
      setOpen(false);
    }
  }

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        className={styles.avatar}
        type="button"
        aria-label="Workspace account"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {initials}
      </button>

      {open && (
        <div className={styles.menu}>
          <div className={styles.identity}>
            <strong>{session.user.displayName}</strong>
            <span>{session.user.email}</span>
          </div>
          <div className={styles.workspaceInfo}>
            <span>
              {session.memberships[0]?.organization.name ?? "Personal Workspace"}
            </span>
            <b>{session.memberships[0]?.membership.role ?? "member"}</b>
          </div>
          <button type="button" onClick={signOut}>Sign out</button>
        </div>
      )}
    </div>
  );
}
