import {
  createHash,
  createHmac,
  timingSafeEqual
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  authenticateKoshOAuthAccessToken,
  consumeKoshOAuthCode,
  getKoshOAuthClient,
  issueKoshOAuthCode,
  issueKoshOAuthTokens,
  readyKoshOAuthStore,
  registerKoshOAuthClient,
  rotateKoshOAuthRefreshToken
} from "./kosh-oauth-store.js";

const OAUTH_SCOPE = "repo:read";
const MAX_BODY_BYTES = 64 * 1024;

type JsonBody = Record<string, unknown>;

type AuthorizationInput = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  resource: string;
  scope: string;
};

function issuer() {
  const raw = process.env.KOSH_OAUTH_ISSUER?.trim() || process.env.KOSH_PUBLIC_ORIGIN?.trim() || "http://localhost:4100";
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("invalid_kosh_oauth_issuer");
  }
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("kosh_oauth_issuer_requires_https");
  }
  return url.toString().replace(/\/$/, "");
}

function allowedResources() {
  const configured = (process.env.KOSH_OAUTH_RESOURCES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).toString().replace(/\/$/, ""));
  if (configured.length) return new Set(configured);
  if (process.env.NODE_ENV === "production") return new Set<string>();
  return new Set(["http://localhost:4310/mcp"]);
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(JSON.stringify(body));
}

function oauthError(response: ServerResponse, status: number, error: string, description?: string) {
  json(response, status, {
    error,
    ...(description ? { error_description: description } : {})
  });
}

async function readRaw(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request: IncomingMessage): Promise<JsonBody> {
  const raw = await readRaw(request);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonBody
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

async function readForm(request: IncomingMessage) {
  return new URLSearchParams(await readRaw(request));
}

function safeRedirectUri(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new Error("invalid_redirect_uri");
  if (url.protocol === "https:") return url.toString();
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  if (url.protocol === "http:" && loopback) return url.toString();
  throw new Error("redirect_uri_must_use_https_or_loopback");
}

function safeResource(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("invalid_resource");
  }
  const normalized = url.toString().replace(/\/$/, "");
  if (!allowedResources().has(normalized)) throw new Error("resource_not_allowed");
  return normalized;
}

function requestedScopes(value: string) {
  const scopes = [...new Set(value.split(/\s+/).map((item) => item.trim()).filter(Boolean))];
  if (!scopes.length) return [OAUTH_SCOPE];
  if (scopes.some((scope) => scope !== OAUTH_SCOPE)) throw new Error("invalid_scope");
  return scopes;
}

function authorizationInput(params: URLSearchParams): AuthorizationInput {
  if (params.get("response_type") !== "code") throw new Error("unsupported_response_type");
  const clientId = params.get("client_id")?.trim() ?? "";
  const redirectUri = safeRedirectUri(params.get("redirect_uri")?.trim() ?? "");
  const codeChallenge = params.get("code_challenge")?.trim() ?? "";
  if (!clientId) throw new Error("invalid_client");
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)) {
    throw new Error("invalid_code_challenge");
  }
  const state = params.get("state")?.slice(0, 1024) ?? "";
  const scope = requestedScopes(params.get("scope") ?? OAUTH_SCOPE).join(" ");
  const resource = safeResource(params.get("resource")?.trim() ?? "");
  return { clientId, redirectUri, codeChallenge, state, resource, scope };
}

function consentSecret() {
  const value = process.env.KOSH_OAUTH_CONSENT_SECRET?.trim() || process.env.KOSH_MASTER_KEY?.trim() || "";
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error("kosh_oauth_consent_secret_required");
  }
  return value || "development-kosh-oauth-consent-secret";
}

function consentToken(input: AuthorizationInput, userId: string) {
  const payload = Buffer.from(JSON.stringify({
    ...input,
    userId,
    exp: Date.now() + 10 * 60_000
  })).toString("base64url");
  const signature = createHmac("sha256", consentSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyConsentToken(raw: string, input: AuthorizationInput, userId: string) {
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", consentSecret()).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return decoded.userId === userId && decoded.clientId === input.clientId &&
      decoded.redirectUri === input.redirectUri && decoded.codeChallenge === input.codeChallenge &&
      decoded.state === input.state && decoded.resource === input.resource && decoded.scope === input.scope &&
      Number(decoded.exp) > Date.now();
  } catch {
    return false;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[character] ?? character));
}

function redirectWithOAuthResult(response: ServerResponse, redirectUri: string, values: Record<string, string>) {
  const target = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value) target.searchParams.set(key, value);
  }
  response.statusCode = 302;
  response.setHeader("location", target.toString());
  response.setHeader("cache-control", "no-store");
  response.end();
}

async function interactiveIdentity(request: IncomingMessage) {
  const identity = await resolveKoshIdentity(request);
  return identity?.authType === "session" ? identity : null;
}

async function handleAuthorizeGet(request: IncomingMessage, response: ServerResponse, url: URL) {
  let input: AuthorizationInput;
  try {
    input = authorizationInput(url.searchParams);
  } catch (error) {
    oauthError(response, 400, error instanceof Error ? error.message : "invalid_request");
    return;
  }
  const client = await getKoshOAuthClient(input.clientId);
  if (!client || !client.redirectUris.includes(input.redirectUri)) {
    oauthError(response, 400, "invalid_client");
    return;
  }
  const identity = await interactiveIdentity(request);
  if (!identity) {
    const login = process.env.KOSH_OAUTH_LOGIN_URL?.trim();
    if (!login) {
      oauthError(response, 401, "login_required", "Sign in to Kosh in this browser before authorizing the MCP client.");
      return;
    }
    const target = new URL(login);
    target.searchParams.set("return_to", `${issuer()}${url.pathname}${url.search}`);
    response.statusCode = 302;
    response.setHeader("location", target.toString());
    response.end();
    return;
  }
  const token = consentToken(input, identity.user.id);
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Kosh</title></head><body><main><h1>Authorize ${escapeHtml(client.clientName)}</h1><p>This client is requesting read-only access to repositories you can already access in Kosh.</p><p><strong>Scope:</strong> ${OAUTH_SCOPE}</p><form method="post" action="/v1/kosh/oauth/authorize">${hidden("response_type", "code")}${hidden("client_id", input.clientId)}${hidden("redirect_uri", input.redirectUri)}${hidden("code_challenge", input.codeChallenge)}${hidden("code_challenge_method", "S256")}${hidden("scope", input.scope)}${hidden("resource", input.resource)}${hidden("state", input.state)}${hidden("consent_token", token)}<button name="decision" value="allow" type="submit">Allow</button><button name="decision" value="deny" type="submit">Deny</button></form></main></body></html>`;
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("x-frame-options", "DENY");
  response.end(body);
}

async function handleAuthorizePost(request: IncomingMessage, response: ServerResponse) {
  const form = await readForm(request);
  let input: AuthorizationInput;
  try {
    input = authorizationInput(form);
  } catch (error) {
    oauthError(response, 400, error instanceof Error ? error.message : "invalid_request");
    return;
  }
  const client = await getKoshOAuthClient(input.clientId);
  if (!client || !client.redirectUris.includes(input.redirectUri)) {
    oauthError(response, 400, "invalid_client");
    return;
  }
  const identity = await interactiveIdentity(request);
  if (!identity) {
    oauthError(response, 401, "login_required");
    return;
  }
  if (!verifyConsentToken(form.get("consent_token") ?? "", input, identity.user.id)) {
    oauthError(response, 400, "invalid_consent");
    return;
  }
  if (form.get("decision") !== "allow") {
    redirectWithOAuthResult(response, input.redirectUri, {
      error: "access_denied",
      state: input.state,
      iss: issuer()
    });
    return;
  }
  const code = await issueKoshOAuthCode({
    clientId: input.clientId,
    userId: identity.user.id,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scopes: requestedScopes(input.scope),
    resource: input.resource
  });
  redirectWithOAuthResult(response, input.redirectUri, {
    code,
    state: input.state,
    iss: issuer()
  });
}

async function handleRegister(request: IncomingMessage, response: ServerResponse) {
  const body = await readJson(request);
  const redirects = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.map(String).map(safeRedirectUri)
    : [];
  if (!redirects.length || redirects.length > 10) {
    oauthError(response, 400, "invalid_redirect_uris");
    return;
  }
  const grantTypes = Array.isArray(body.grant_types)
    ? body.grant_types.map(String)
    : ["authorization_code", "refresh_token"];
  if (grantTypes.some((value) => !["authorization_code", "refresh_token"].includes(value))) {
    oauthError(response, 400, "invalid_grant_types");
    return;
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== "none") {
    oauthError(response, 400, "unsupported_token_endpoint_auth_method");
    return;
  }
  const client = await registerKoshOAuthClient({
    clientName: String(body.client_name ?? "Kosh MCP client"),
    redirectUris: redirects,
    grantTypes
  });
  json(response, 201, {
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  });
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function handleToken(request: IncomingMessage, response: ServerResponse) {
  const form = await readForm(request);
  const grantType = form.get("grant_type") ?? "";
  const clientId = form.get("client_id")?.trim() ?? "";
  const client = clientId ? await getKoshOAuthClient(clientId) : null;
  if (!client) {
    oauthError(response, 401, "invalid_client");
    return;
  }

  if (grantType === "authorization_code") {
    const code = form.get("code") ?? "";
    const redirectUri = safeRedirectUri(form.get("redirect_uri") ?? "");
    const verifier = form.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
      oauthError(response, 400, "invalid_grant");
      return;
    }
    const grant = await consumeKoshOAuthCode(code, { clientId, redirectUri });
    if (!grant || grant.codeChallenge !== pkceChallenge(verifier)) {
      oauthError(response, 400, "invalid_grant");
      return;
    }
    const pair = await issueKoshOAuthTokens({
      clientId,
      userId: grant.userId,
      scopes: grant.scopes,
      resource: grant.resource
    });
    json(response, 200, {
      access_token: pair.accessToken,
      token_type: "Bearer",
      expires_in: pair.expiresIn,
      refresh_token: pair.refreshToken,
      scope: pair.scope
    });
    return;
  }

  if (grantType === "refresh_token") {
    const rotated = await rotateKoshOAuthRefreshToken(form.get("refresh_token") ?? "", clientId);
    if (!rotated) {
      oauthError(response, 400, "invalid_grant");
      return;
    }
    json(response, 200, {
      access_token: rotated.accessToken,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.floor((new Date(rotated.access.accessExpiresAt).getTime() - Date.now()) / 1000)),
      refresh_token: rotated.refreshToken,
      scope: rotated.access.scopes.join(" ")
    });
    return;
  }

  oauthError(response, 400, "unsupported_grant_type");
}

function safeEqualText(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleIntrospect(request: IncomingMessage, response: ServerResponse) {
  const expectedAssertion = process.env.KOSH_PLUGIN_ASSERTION_SECRET?.trim() ?? "";
  const actualAssertion = String(request.headers["x-kosh-plugin-assertion"] ?? "");
  if (!expectedAssertion || !safeEqualText(actualAssertion, expectedAssertion)) {
    oauthError(response, 401, "invalid_client");
    return;
  }
  const resource = safeResource(String(request.headers["x-kosh-oauth-resource"] ?? ""));
  const header = String(request.headers.authorization ?? "");
  const token = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
  const access = await authenticateKoshOAuthAccessToken(token);
  if (!access || access.resource !== resource) {
    json(response, 200, { active: false });
    return;
  }
  json(response, 200, {
    active: true,
    client_id: access.clientId,
    sub: access.userId,
    scope: access.scopes.join(" "),
    exp: Math.floor(new Date(access.accessExpiresAt).getTime() / 1000),
    resource: access.resource
  });
}

export async function handleKoshOAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
) {
  const base = issuer();
  if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    json(response, 200, {
      issuer: base,
      authorization_endpoint: `${base}/v1/kosh/oauth/authorize`,
      token_endpoint: `${base}/v1/kosh/oauth/token`,
      registration_endpoint: `${base}/v1/kosh/oauth/register`,
      scopes_supported: [OAUTH_SCOPE],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true
    });
    return true;
  }

  if (!url.pathname.startsWith("/v1/kosh/oauth/")) return false;
  await readyKoshOAuthStore();
  try {
    if (url.pathname === "/v1/kosh/oauth/register" && request.method === "POST") {
      await handleRegister(request, response);
      return true;
    }
    if (url.pathname === "/v1/kosh/oauth/authorize" && request.method === "GET") {
      await handleAuthorizeGet(request, response, url);
      return true;
    }
    if (url.pathname === "/v1/kosh/oauth/authorize" && request.method === "POST") {
      await handleAuthorizePost(request, response);
      return true;
    }
    if (url.pathname === "/v1/kosh/oauth/token" && request.method === "POST") {
      await handleToken(request, response);
      return true;
    }
    if (url.pathname === "/v1/kosh/oauth/introspect" && request.method === "POST") {
      await handleIntrospect(request, response);
      return true;
    }
  } catch (error) {
    const status = Number((error as { status?: number })?.status) || 400;
    oauthError(response, status, error instanceof Error ? error.message : "invalid_request");
    return true;
  }

  response.statusCode = 405;
  response.setHeader("allow", "GET,POST");
  response.end();
  return true;
}
