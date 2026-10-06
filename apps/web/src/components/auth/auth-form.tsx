"use client";

import Link from "next/link";
import { FormEvent, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { workspaceApi, type WorkspaceSessionResponse } from "../../lib/workspace-api";
import styles from "./auth.module.css";

type Mode = "signin" | "register";

type PatraAvailability = {
  username: string;
  address: string;
  available: boolean;
};

type PatraMailbox = {
  id: string;
  address: string;
};

const errorText: Record<string, string> = {
  invalid_credentials: "The email or password is incorrect.",
  invalid_email: "Enter a valid email address.",
  invalid_display_name: "Enter your name.",
  invalid_mailbox_username: "Use 3–64 letters, numbers, dots, underscores or hyphens.",
  mailbox_username_reserved: "That Patra username is reserved.",
  mailbox_address_taken: "That Patra address is already taken.",
  public_mailbox_already_exists: "A Patra mailbox already exists for this account.",
  password_too_short: "Use at least 10 characters for your password.",
  password_too_long: "The password is too long.",
  email_already_registered: "An account already exists for this email.",
  too_many_attempts: "Too many attempts. Try again later.",
  identity_store_unavailable: "The account service is currently unavailable.",
  patra_store_unavailable: "The Patra mailbox service is currently unavailable.",
  origin_not_allowed: "This sign-in request was rejected by the Workspace security policy."
};

export function AuthForm() {
  const router = useRouter();
  const isPatraSurface = process.env.NEXT_PUBLIC_WORKSPACE_SURFACE === "patra";
  const [mode, setMode] = useState<Mode>("signin");
  const [displayName, setDisplayName] = useState("");
  const [patraUsername, setPatraUsername] = useState("");
  const [availability, setAvailability] = useState<PatraAvailability | null>(null);
  const [checkingUsername, setCheckingUsername] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [recoveryOpen, setRecoveryOpen] = useState(true);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const proposedPatraAddress = useMemo(() => {
    const username = patraUsername.trim().toLowerCase();
    return username ? username + "@patra.tamishra.in" : "";
  }, [patraUsername]);

  async function checkPatraAvailability() {
    const username = patraUsername.trim().toLowerCase();
    if (!username) {
      setAvailability(null);
      setStatus("Choose your Patra username.");
      return false;
    }

    setCheckingUsername(true);
    setStatus("");

    try {
      const result = await workspaceApi<PatraAvailability>(
        `/v1/patra/availability?username=${encodeURIComponent(username)}`
      );
      setAvailability(result);
      if (!result.available) {
        setStatus("That Patra address is already taken.");
      }
      return result.available;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "invalid_mailbox_username";
      setAvailability(null);
      setStatus(errorText[code] ?? "Unable to check Patra username availability.");
      return false;
    } finally {
      setCheckingUsername(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setStatus("");

    try {
      if (mode === "register" && isPatraSurface) {
        const normalized = patraUsername.trim().toLowerCase();
        const stillValid =
          availability?.username === normalized && availability.available;
        if (!stillValid && !(await checkPatraAvailability())) {
          return;
        }
      }

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

      if (mode === "register" && isPatraSurface) {
        const mailbox = await workspaceApi<{ mailbox: PatraMailbox }>(
          "/v1/patra/mailboxes",
          {
            method: "POST",
            body: JSON.stringify({ username: patraUsername.trim().toLowerCase() })
          }
        );
        setStatus(mailbox.mailbox.address + " is ready.");
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
    setAvailability(null);
    setRecoveryOpen(next === "signin");
  }

  return (
    <main className={styles.page}>
      <section className={styles.brandPanel}>
        <Link className={styles.mark} href="/" aria-label={isPatraSurface ? "Tamishra Patra home" : "Tamishra Workspace home"}>
          {isPatraSurface ? "P" : "T"}
        </Link>
        <div>
          <p className={styles.eyebrow}>
            {isPatraSurface ? "TAMISHRA PATRA" : "TAMISHRA WORKSPACE"}
          </p>
          <h1>
            {isPatraSurface
              ? "Your Patra inbox starts with your own address."
              : "Your work belongs in one secure workspace."}
          </h1>
          <p className={styles.intro}>
            {isPatraSurface
              ? "Create a Tamishra identity and choose your personal @patra.tamishra.in address in one registration flow."
              : "Tamishra-native identity for Patra, Meet, Docs, Sheets, Slides, Notes, Forms, Chat and Files."}
          </p>
        </div>
        <div className={styles.securityNote}>
          <strong>First-party account</strong>
          <span>
            {isPatraSurface
              ? "Your Patra mailbox and Tamishra account are provisioned together."
              : "Password credentials and sessions are handled by the Tamishra Workspace gateway."}
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
            <span>
              {mode === "signin"
                ? "WELCOME BACK"
                : isPatraSurface
                  ? "NEW PATRA ACCOUNT"
                  : "NEW WORKSPACE ACCOUNT"}
            </span>
            <h2>
              {mode === "signin"
                ? isPatraSurface
                  ? "Sign in to Patra"
                  : "Sign in to Workspace"
                : isPatraSurface
                  ? "Create your Patra account"
                  : "Create your Tamishra account"}
            </h2>
            <p>
              {mode === "signin"
                ? isPatraSurface
                  ? "Continue to your Patra inbox."
                  : "Continue to your Workspace apps and files."
                : isPatraSurface
                  ? "Choose your Patra address and create your Tamishra identity together."
                  : "A personal Workspace organization will be created automatically."}
            </p>
          </div>

          <form className={styles.form} onSubmit={submit}>
            {mode === "signin" && !isPatraSurface && (
              <>
                <a
                  href="/api/kosh/google/login?return_to=/workspace/apps/kosh"
                  style={{
                    minHeight: 44,
                    border: "1px solid rgba(23, 32, 51, 0.14)",
                    borderRadius: 12,
                    color: "#26344a",
                    background: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    textDecoration: "none",
                    fontSize: 10,
                    fontWeight: 850,
                    boxShadow: "0 6px 18px rgba(23, 32, 51, 0.06)"
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 22,
                      height: 22,
                      border: "1px solid #e1e5ec",
                      borderRadius: "50%",
                      display: "grid",
                      placeItems: "center",
                      color: "#4285f4",
                      fontSize: 12,
                      fontWeight: 900,
                      background: "#fff"
                    }}
                  >
                    G
                  </span>
                  Continue with Google
                </a>
                <div
                  aria-hidden="true"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    color: "#98a2b3",
                    fontSize: 8,
                    fontWeight: 700
                  }}
                >
                  <span style={{ height: 1, background: "#e7ebf1", flex: 1 }} />
                  OR CONTINUE WITH EMAIL
                  <span style={{ height: 1, background: "#e7ebf1", flex: 1 }} />
                </div>
              </>
            )}

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

            {mode === "register" && isPatraSurface && (
              <label>
                <span>Patra address</span>
                <div className={styles.addressField}>
                  <input
                    value={patraUsername}
                    onChange={(event) => {
                      setPatraUsername(event.target.value.toLowerCase());
                      setAvailability(null);
                    }}
                    onBlur={() => {
                      if (patraUsername.trim()) void checkPatraAvailability();
                    }}
                    autoComplete="username"
                    minLength={3}
                    maxLength={64}
                    placeholder="yourname"
                    required
                  />
                  <b>@patra.tamishra.in</b>
                  <button
                    type="button"
                    disabled={checkingUsername || !patraUsername.trim()}
                    onClick={() => void checkPatraAvailability()}
                  >
                    {checkingUsername ? "Checking…" : "Check"}
                  </button>
                </div>
                {availability && (
                  <small
                    className={
                      availability.available
                        ? styles.available
                        : styles.unavailable
                    }
                  >
                    {availability.available
                      ? availability.address + " is available."
                      : availability.address + " is already taken."}
                  </small>
                )}
              </label>
            )}

            <label>
              <span>
                {mode === "signin" && isPatraSurface
                  ? "Patra address or recovery email"
                  : mode === "register" && isPatraSurface
                    ? "Recovery email"
                    : "Email"}
              </span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                maxLength={254}
                placeholder={
                  mode === "signin" && isPatraSurface
                    ? "you@patra.tamishra.in"
                    : "you@domain.com"
                }
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
              <>
                <div className={styles.signInOptions}>
                  <label className={styles.remember}>
                    <input
                      type="checkbox"
                      checked={remember}
                      onChange={(event) => setRemember(event.target.checked)}
                    />
                    <span>Keep me signed in on this device</span>
                  </label>
                  <button
                    className={styles.forgotButton}
                    type="button"
                    aria-expanded={recoveryOpen}
                    onClick={() => {
                      setRecoveryOpen((value) => !value);
                      setStatus("");
                    }}
                  >
                    {recoveryOpen ? "Hide reset" : "Forgot password?"}
                  </button>
                </div>

                {recoveryOpen && (
                  <div className={styles.recoveryPanel}>
                    <div>
                      <strong>Reset your password</strong>
                      <p>
                        Use the secure one-time recovery link sent to your account email. Your old password is not required.
                      </p>
                    </div>
                    <Link className={styles.recoveryLink} href="/reset-password">
                      Open reset password
                    </Link>
                    <small>
                      For security, reset tokens are never displayed on the sign-in page.
                    </small>
                  </div>
                )}
              </>
            )}

            {status && <div className={styles.error} role="alert">{status}</div>}

            <button className={styles.submit} type="submit" disabled={busy || checkingUsername}>
              {busy
                ? "Working…"
                : mode === "signin"
                  ? "Sign in"
                  : isPatraSurface
                    ? `Create ${proposedPatraAddress || "Patra account"}`
                    : "Create Workspace account"}
            </button>
          </form>

          <p className={styles.footerText}>
            {isPatraSurface
              ? "Public Patra mailboxes use the @patra.tamishra.in namespace."
              : "Tamishra Workspace supports native password sessions and verified Google sign-in."}
          </p>
        </div>
      </section>
    </main>
  );
}
