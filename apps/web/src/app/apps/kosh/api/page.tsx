"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./api.module.css";

type Scope = {
  id: string;
  name: string;
  description: string;
};

type TokenRecord = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

type TokenList = {
  tokens: TokenRecord[];
  scopes: Scope[];
};

type Discovery = {
  product: string;
  apiVersion: string;
  contractDate: string;
  endpoints: Record<string, string>;
};

function apiBase() {
  return (
    process.env.NEXT_PUBLIC_WORKSPACE_API_BASE?.trim() ||
    process.env.NEXT_PUBLIC_WORKSPACE_GATEWAY_ORIGIN?.trim() ||
    "http://localhost:4100"
  ).replace(/\/$/, "");
}

function stamp(value: string | null) {
  if (!value) return "Never";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function expiryIso(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export default function KoshApiWorkspace() {
  const base = useMemo(apiBase, []);
  const [data, setData] = useState<TokenList | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [name, setName] = useState("Kosh CLI");
  const [scopes, setScopes] = useState<string[]>(["repo:read"]);
  const [expiryDays, setExpiryDays] = useState(90);
  const [revealedToken, setRevealedToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [tokensResponse, discoveryResponse] = await Promise.all([
        fetch(base + "/v1/kosh/api/tokens", {
          credentials: "include",
          cache: "no-store"
        }),
        fetch(base + "/v1/kosh/api", { cache: "no-store" })
      ]);
      const tokensPayload = (await tokensResponse.json()) as TokenList & { error?: string };
      const discoveryPayload = (await discoveryResponse.json()) as Discovery & { error?: string };
      if (!tokensResponse.ok) {
        throw new Error(tokensPayload.error || "Could not load API tokens.");
      }
      if (!discoveryResponse.ok) {
        throw new Error(discoveryPayload.error || "Could not load API discovery.");
      }
      setData(tokensPayload);
      setDiscovery(discoveryPayload);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load Kosh API settings.");
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleScope(scope: string) {
    setScopes((current) => {
      if (scope === "*") return current.includes("*") ? ["repo:read"] : ["*"];
      const withoutWildcard = current.filter((item) => item !== "*");
      const next = withoutWildcard.includes(scope)
        ? withoutWildcard.filter((item) => item !== scope)
        : [...withoutWildcard, scope];
      if (scope === "repo:write" && !next.includes("repo:read")) next.unshift("repo:read");
      if (!next.length) return ["repo:read"];
      return [...new Set(next)];
    });
  }

  async function createToken(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setRevealedToken("");
    try {
      const response = await fetch(base + "/v1/kosh/api/tokens", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scopes,
          expiresAt: expiryIso(expiryDays)
        })
      });
      const payload = (await response.json()) as {
        token?: string;
        record?: TokenRecord;
        error?: string;
      };
      if (!response.ok || !payload.token) {
        throw new Error(payload.error || "Token creation failed.");
      }
      setRevealedToken(payload.token);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Token creation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(base + "/v1/kosh/api/tokens/" + id, {
        method: "DELETE",
        credentials: "include"
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Token revocation failed.");
      setRevealedToken("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Token revocation failed.");
    } finally {
      setBusy(false);
    }
  }

  async function rotateToken(id: string) {
    setBusy(true);
    setError("");
    setRevealedToken("");
    try {
      const response = await fetch(base + "/v1/kosh/api/tokens/" + id + "/rotate", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expiresAt: expiryIso(expiryDays) })
      });
      const payload = (await response.json()) as { token?: string; error?: string };
      if (!response.ok || !payload.token) {
        throw new Error(payload.error || "Token rotation failed.");
      }
      setRevealedToken(payload.token);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Token rotation failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <Link href="/apps/kosh">← Kosh</Link>
          <p>KOSH DEVELOPER PLATFORM</p>
          <h1>Public API & CLI</h1>
          <span>Scoped automation credentials and a native command-line client for Kosh.</span>
        </div>
        <button onClick={() => void load()} disabled={busy}>Refresh</button>
      </header>

      {error && <div className={styles.error}>{error}</div>}

      <section className={styles.summary}>
        <div><span>API version</span><strong>{discovery?.apiVersion || "1"}</strong></div>
        <div><span>Contract</span><strong>{discovery?.contractDate || "—"}</strong></div>
        <div><span>Tokens</span><strong>{data?.tokens.length ?? 0}</strong></div>
        <div><span>CLI</span><strong>kosh 0.2</strong></div>
      </section>

      {revealedToken && (
        <section className={styles.secret}>
          <div>
            <strong>Token value — copy it now</strong>
            <p>Kosh stores only its hash and will not reveal this value again.</p>
          </div>
          <code>{revealedToken}</code>
          <div className={styles.commands}>
            <code>kosh auth login --token {revealedToken}</code>
            <button onClick={() => setRevealedToken("")}>Hide</button>
          </div>
        </section>
      )}

      <section className={styles.grid}>
        <form className={styles.panel} onSubmit={createToken}>
          <div className={styles.panelHeading}>
            <div><span>Credentials</span><h2>Create API token</h2></div>
          </div>
          <label>
            Token name
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
          </label>
          <fieldset>
            <legend>Scopes</legend>
            <div className={styles.scopeList}>
              {data?.scopes.map((scope) => (
                <label key={scope.id} className={styles.scope}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope.id)}
                    onChange={() => toggleScope(scope.id)}
                  />
                  <span><strong>{scope.name}</strong><small>{scope.description}</small></span>
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            Expires in
            <select value={expiryDays} onChange={(event) => setExpiryDays(Number(event.target.value))}>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
              <option value={365}>365 days</option>
            </select>
          </label>
          <button type="submit" disabled={busy || !scopes.length}>Create token</button>
        </form>

        <section className={styles.panel}>
          <div className={styles.panelHeading}>
            <div><span>Native client</span><h2>Kosh CLI</h2></div>
          </div>
          <div className={styles.cliBlock}>
            <code>npm run build:kosh-cli</code>
            <code>kosh auth login --token kosh_pat_...</code>
            <code>kosh auth status</code>
            <code>kosh repo list</code>
            <code>kosh search org/repo query code</code>
            <code>kosh api discover</code>
          </div>
          <p className={styles.muted}>
            The CLI only sends credentials to the configured Kosh origin. Generic API commands accept relative paths, not arbitrary external URLs.
          </p>
          <div className={styles.contractLinks}>
            <a href={base + "/v1/kosh/api"}>API discovery</a>
            <a href={base + "/v1/kosh/api/openapi.json"}>OpenAPI JSON</a>
          </div>
        </section>
      </section>

      <section className={styles.tokens}>
        <div className={styles.panelHeading}>
          <div><span>Lifecycle</span><h2>Personal API tokens</h2></div>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th>Expires</th><th /></tr>
            </thead>
            <tbody>
              {data?.tokens.map((token) => (
                <tr key={token.id}>
                  <td><strong>{token.name}</strong><small>Created {stamp(token.createdAt)}</small></td>
                  <td><code>{token.tokenPrefix}…</code></td>
                  <td>{token.scopes.join(", ")}</td>
                  <td>{stamp(token.lastUsedAt)}</td>
                  <td>{stamp(token.expiresAt)}</td>
                  <td className={styles.actions}>
                    <button disabled={busy} onClick={() => void rotateToken(token.id)}>Rotate</button>
                    <button disabled={busy} className={styles.danger} onClick={() => void revokeToken(token.id)}>Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data?.tokens.length && <p className={styles.empty}>No personal API tokens yet.</p>}
        </div>
      </section>
    </main>
  );
}
