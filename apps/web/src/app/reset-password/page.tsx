"use client";

import Link from "next/link";
import { FormEvent, Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { workspaceApi } from "../../lib/workspace-api";

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const queryToken = useMemo(() => searchParams.get("token")?.trim() ?? "", [searchParams]);
  const [recoveryLink, setRecoveryLink] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [done, setDone] = useState(false);

  function tokenFromInput(value: string) {
    const normalized = value.trim();
    if (!normalized) return "";
    try {
      const parsed = new URL(normalized);
      return parsed.searchParams.get("token")?.trim() ?? "";
    } catch {
      return normalized;
    }
  }

  function continueRecovery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = recoveryLink.trim();
    if (!value) {
      setStatus("Paste the password-reset link from your recovery email.");
      return;
    }

    try {
      const parsed = new URL(value);
      if (parsed.pathname.includes("/v1/auth/recovery/link")) {
        window.location.assign(value);
        return;
      }
      const pastedToken = parsed.searchParams.get("token")?.trim() ?? "";
      if (pastedToken) {
        window.location.assign(`/kosh/reset-password?token=${encodeURIComponent(pastedToken)}`);
        return;
      }
    } catch {
      if (value.length >= 32) {
        window.location.assign(`/kosh/reset-password?token=${encodeURIComponent(value)}`);
        return;
      }
    }

    setStatus("That recovery link is not valid. Open the latest Kosh reset email and paste its full link here.");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const token = queryToken || tokenFromInput(recoveryLink);
    if (!token) {
      setStatus("A valid recovery token is required. Open the reset link from your email first.");
      return;
    }
    if (password.length < 10) {
      setStatus("Use at least 10 characters for the new password.");
      return;
    }
    if (password !== confirm) {
      setStatus("The passwords do not match.");
      return;
    }

    setBusy(true);
    setStatus("");
    try {
      await workspaceApi<{ reset: true }>("/v1/auth/recovery/reset", {
        method: "POST",
        body: JSON.stringify({ token, password })
      });
      setDone(true);
      setPassword("");
      setConfirm("");
      setStatus("Password changed. All older sessions have been signed out.");
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code ?? "")
          : "";
      setStatus(
        code === "invalid_or_expired_reset_token"
          ? "This reset link has expired or has already been used. Use the latest recovery email."
          : code === "password_too_short"
            ? "Use at least 10 characters for the new password."
            : "Unable to reset the password. Please use a fresh recovery link."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, background: "#f7f9fc", color: "#172033" }}>
      <section style={{ width: "min(460px, 100%)", background: "white", border: "1px solid #e6eaf0", borderRadius: 20, padding: 28, boxShadow: "0 18px 50px rgba(20,35,70,.08)" }}>
        <p style={{ margin: 0, fontSize: 12, letterSpacing: 1.6, fontWeight: 700 }}>KOSH BY TAMISHRA</p>
        <h1 style={{ margin: "10px 0 8px", fontSize: 30 }}>Reset your password</h1>
        <p style={{ margin: "0 0 24px", color: "#5d6678", lineHeight: 1.5 }}>
          Choose a new password for your Tamishra Workspace and Kosh account.
        </p>

        {done ? (
          <div>
            <div style={{ padding: 14, borderRadius: 12, background: "#f0f7f3", marginBottom: 18 }}>{status}</div>
            <Link href="/sign-in" style={{ display: "inline-block", textDecoration: "none", padding: "12px 16px", borderRadius: 12, background: "#172033", color: "white", fontWeight: 700 }}>
              Continue to sign in
            </Link>
          </div>
        ) : !queryToken ? (
          <form onSubmit={continueRecovery} style={{ display: "grid", gap: 16 }}>
            <div style={{ padding: 13, borderRadius: 12, background: "#f3f6ff", color: "#44506a", lineHeight: 1.5 }}>
              For security, Kosh needs the one-time reset link sent to your account email before it can change your password.
            </div>
            <label style={{ display: "grid", gap: 7 }}>
              <span style={{ fontWeight: 650 }}>Recovery link</span>
              <input
                type="text"
                value={recoveryLink}
                onChange={(event) => setRecoveryLink(event.target.value)}
                placeholder="Paste the full reset link from your email"
                autoComplete="off"
                required
                style={{ width: "100%", boxSizing: "border-box", padding: "12px 13px", border: "1px solid #cfd6e2", borderRadius: 11, fontSize: 14 }}
              />
            </label>
            {status && <div role="alert" style={{ padding: 12, borderRadius: 10, background: "#fff3f3", color: "#9b2525" }}>{status}</div>}
            <button type="submit" style={{ border: 0, borderRadius: 12, padding: "13px 16px", background: "#172033", color: "white", fontWeight: 750, fontSize: 15, cursor: "pointer" }}>
              Continue from recovery link
            </button>
            <Link href="/sign-in" style={{ textAlign: "center", color: "#315cf4", fontWeight: 700, textDecoration: "none" }}>
              Back to sign in
            </Link>
          </form>
        ) : (
          <form onSubmit={submit} style={{ display: "grid", gap: 16 }}>
            <div style={{ padding: 12, borderRadius: 10, background: "#f0f7f3", color: "#295a3d" }}>
              Recovery link verified. Enter your new password below.
            </div>
            <label style={{ display: "grid", gap: 7 }}>
              <span style={{ fontWeight: 650 }}>New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                minLength={10}
                maxLength={256}
                required
                style={{ width: "100%", boxSizing: "border-box", padding: "12px 13px", border: "1px solid #cfd6e2", borderRadius: 11, fontSize: 16 }}
              />
            </label>
            <label style={{ display: "grid", gap: 7 }}>
              <span style={{ fontWeight: 650 }}>Confirm new password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                minLength={10}
                maxLength={256}
                required
                style={{ width: "100%", boxSizing: "border-box", padding: "12px 13px", border: "1px solid #cfd6e2", borderRadius: 11, fontSize: 16 }}
              />
            </label>

            {status && <div role="alert" style={{ padding: 12, borderRadius: 10, background: "#fff3f3", color: "#9b2525" }}>{status}</div>}

            <button type="submit" disabled={busy} style={{ border: 0, borderRadius: 12, padding: "13px 16px", background: "#172033", color: "white", fontWeight: 750, fontSize: 15, cursor: busy ? "wait" : "pointer" }}>
              {busy ? "Resetting…" : "Reset password"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
          Loading password reset…
        </main>
      }
    >
      <ResetPasswordForm />
    </Suspense>
  );
}
