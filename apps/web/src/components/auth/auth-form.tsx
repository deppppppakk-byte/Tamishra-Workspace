"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { workspaceApi, type WorkspaceSessionResponse } from "../../lib/workspace-api";
import styles from "./auth.module.css";

type Mode = "signin" | "register";

const errorText: Record<string, string> = {
  invalid_credentials: "The email or password is incorrect.",
  invalid_email: "Enter a valid email address.",
  invalid_display_name: "Enter your name.",
  password_too_short: "Use at least 10 characters for your password.",
  password_too_long: "The password is too long.",
  email_already_registered: "An account already exists for this email.",
  too_many_attempts: "Too many attempts. Try again later.",
  identity_store_unavailable: "The account service is currently unavailable.",
  origin_not_allowed: "This sign-in request was rejected by the Workspace security policy."
};

export function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setStatus("");

    try {
      const result = await workspaceApi<WorkspaceSessionResponse>(
        mode === "signin" ? "/v1/auth/sign-in" : "/v1/auth/register",
        {
          method: "POST",
          body: JSON.stringify(
            mode === "signin"
              ? { email, password, remember }
              : { email, password, displayName }
          )
        }
      );

      if (!result.authenticated) {
        throw new Error("authentication_failed");
      }

      router.push("/");
      router.refresh();
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : error instanceof Error
            ? error.message
            : "authentication_failed";
      setStatus(errorText[code] ?? "Unable to complete the request.");
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setStatus("");
  }

  return (
    <main className={styles.page}>
      <section className={styles.brandPanel}>
        <Link className={styles.mark} href="/" aria-label="Tamishra Workspace home">
          T
        </Link>
        <div>
          <p className={styles.eyebrow}>TAMISHRA WORKSPACE</p>
          <h1>Your work belongs in one secure workspace.</h1>
          <p className={styles.intro}>
            Tamishra-native identity for Mail, Meet, Docs, Sheets, Slides,
            Notes, Forms, Chat and Files. No Google or Microsoft account is required.
          </p>
        </div>
        <div className={styles.securityNote}>
          <strong>First-party account</strong>
          <span>
            Password credentials and sessions are handled by the Tamishra Workspace gateway.
          </span>
        </div>
      </section>

      <section className={styles.formPanel}>
        <div className={styles.formCard}>
          <div className={styles.tabs} role="tablist" aria-label="Account mode">
            <button
              className={mode === "signin" ? styles.tabActive : ""}
              type="button"
              onClick={() => switchMode("signin")}
            >
              Sign in
            </button>
            <button
              className={mode === "register" ? styles.tabActive : ""}
              type="button"
              onClick={() => switchMode("register")}
            >
              Create account
            </button>
          </div>

          <div className={styles.heading}>
            <span>{mode === "signin" ? "WELCOME BACK" : "NEW WORKSPACE ACCOUNT"}</span>
            <h2>{mode === "signin" ? "Sign in to Workspace" : "Create your Tamishra account"}</h2>
            <p>
              {mode === "signin"
                ? "Continue to your Workspace apps and files."
                : "A personal Workspace organization will be created automatically."}
            </p>
          </div>

          <form className={styles.form} onSubmit={submit}>
            {mode === "register" && (
              <label>
                <span>Name</span>
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  autoComplete="name"
                  maxLength={100}
                  placeholder="Your name"
                  required
                />
              </label>
            )}

            <label>
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                maxLength={254}
                placeholder="you@domain.com"
                required
              />
            </label>

            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                minLength={10}
                maxLength={256}
                placeholder={mode === "signin" ? "Your password" : "At least 10 characters"}
                required
              />
            </label>

            {mode === "signin" && (
              <label className={styles.remember}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span>Keep me signed in on this device</span>
              </label>
            )}

            {status && <div className={styles.error} role="alert">{status}</div>}

            <button className={styles.submit} type="submit" disabled={busy}>
              {busy
                ? "Working…"
                : mode === "signin"
                  ? "Sign in"
                  : "Create Workspace account"}
            </button>
          </form>

          <p className={styles.footerText}>
            Tamishra Workspace uses its own account and session system.
          </p>
        </div>
      </section>
    </main>
  );
}
