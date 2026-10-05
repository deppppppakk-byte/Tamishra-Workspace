import { createHash, createHmac, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createIdentityIds,
  createIdentityStore,
  type StoredIdentityUser
} from "./identity-store.js";

const store = createIdentityStore();
const MAX_BODY_BYTES = 16_384;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const RESET_TOKEN_TTL_MS = 20 * 60 * 1000;
const SIGNED_LINK_MAX_FUTURE_MS = 30 * 60 * 1000;
const GOOGLE_HANDOFF_COOKIE = "kosh_google_identity_handoff";
const GOOGLE_HANDOFF_MAX_FUTURE_MS = 5 * 60 * 1000;
const SESSION_COOKIE =
  process.env.WORKSPACE_SESSION_COOKIE_NAME?.trim() ||
  "tamishra_workspace_session";
const SESSION_COOKIE_PATH =
  process.env.WORKSPACE_SESSION_COOKIE_PATH?.trim() ||
  (process.env.NODE_ENV === "production" ? "/api/workspace" : "/");
const SECURE_COOKIE =
  process.env.WORKSPACE_SESSION_COOKIE_SECURE === "true" ||
  process.env.NODE_ENV === "production";
const REMEMBER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

type JsonObject = Record<string, unknown>;

type GoogleHandoffPayload = {
  v: 1;
  provider: "google";
  sub: string;
  email: string;
  name: string;
  emailVerified: true;
  handoffHash: string;
  exp: number;
};

function sendJson(
  response: ServerResponse,
  status: number,
  body: JsonObject,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  if (origin && allowedOrigins.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request_too_large"), { status: 413 });
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase().slice(0, 254);
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanDisplayName(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
}

function validatePassword(value: unknown) {
  const password = String(value ?? "");
  if (password.length < 10) {
    throw Object.assign(new Error("password_too_short"), { status: 400 });
  }
  if (password.length > 256) {
    throw Object.assign(new Error("password_too_long"), { status: 400 });
  }
  return password;
}

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number }
) {
  return new Promise<Buffer>((resolve, reject) => {
    nodeScrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

async function hashPassword(password: string) {
  const salt = randomBytes(24);
  const hash = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  });
  return {
    passwordHash: hash.toString("base64"),
    passwordSalt: salt.toString("base64"),
    scryptN: SCRYPT_N,
    scryptR: SCRYPT_R,
    scryptP: SCRYPT_P,
    keyLength: SCRYPT_KEY_LENGTH
  };
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function recoverySecret() {
  return process.env.WORKSPACE_RECOVERY_ADMIN_SECRET?.trim() ?? "";
}

function googleHandoffSecret() {
  return process.env.KOSH_IDENTITY_HANDOFF_SECRET?.trim() ?? "";
}

function safeTextEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeSecretMatches(request: IncomingMessage) {
  const expected = recoverySecret();
  const supplied = String(request.headers["x-workspace-recovery-secret"] ?? "").trim();
  return Boolean(expected && supplied && safeTextEqual(expected, supplied));
}

function signedLinkSignature(email: string, expiresAtMs: number) {
  const secret = recoverySecret();
  if (!secret) return "";
  return createHmac("sha256", secret)
    .update(email + "\n" + String(expiresAtMs))
    .digest("hex");
}

async function createResetToken(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS).toISOString();
  await store.createIdentityToken({
    id: randomUUID(),
    userId,
    purpose: "reset-password",
    tokenHash: tokenHash(token),
    createdAt: now.toISOString(),
    expiresAt,
    consumedAt: null
  });
  return { token, expiresAt };
}

function mutationOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>
) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

function errorStatus(error: unknown) {
  return Number((error as { status?: number }).status ?? 500);
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.message : "recovery_error";
}

function parseCookies(request: IncomingMessage) {
  const raw = request.headers.cookie ?? "";
  const result = new Map<string, string>();
  for (const item of raw.split(";")) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) result.set(key, value);
  }
  return result;
}

function sessionCookieValue(token: string, maxAgeSeconds: number) {
  const parts = [
    SESSION_COOKIE + "=" + token,
    "HttpOnly",
    "SameSite=Lax",
    "Path=" + SESSION_COOKIE_PATH,
    "Max-Age=" + Math.max(0, Math.floor(maxAgeSeconds)),
    "Priority=High"
  ];
  if (SECURE_COOKIE) parts.push("Secure");
  return parts.join("; ");
}

function clearGoogleHandoffCookieValue() {
  const parts = [
    GOOGLE_HANDOFF_COOKIE + "=",
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
    "Priority=High"
  ];
  if (SECURE_COOKIE) parts.push("Secure");
  return parts.join("; ");
}

function userAgent(request: IncomingMessage) {
  return String(request.headers["user-agent"] ?? "").slice(0, 512) || null;
}

function requestIp(request: IncomingMessage) {
  const trustedProxy = process.env.WORKSPACE_TRUST_PROXY === "true";
  if (trustedProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    if (first?.trim()) return first.trim();
  }
  return request.socket.remoteAddress ?? "";
}

function privacyIpHash(request: IncomingMessage) {
  const secret = process.env.WORKSPACE_IP_HASH_SECRET?.trim();
  const ip = requestIp(request);
  if (!secret || !ip) return null;
  return createHash("sha256").update(secret + ":" + ip).digest("hex");
}

function slugBase(displayName: string) {
  const cleaned = displayName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return cleaned || "workspace";
}

function safeReturnTo(value: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/kosh";
  return raw;
}

function decodeGoogleHandoff(payloadEncoded: string, signature: string): GoogleHandoffPayload {
  const secret = googleHandoffSecret();
  if (!secret || !payloadEncoded || !signature) {
    throw Object.assign(new Error("google_login_not_configured"), { status: 503 });
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(payloadEncoded)
    .digest("base64url");
  if (!safeTextEqual(signature, expectedSignature)) {
    throw Object.assign(new Error("invalid_google_handoff"), { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadEncoded, "base64url").toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid_google_handoff"), { status: 400 });
  }

  const value = parsed as Partial<GoogleHandoffPayload>;
  const now = Date.now();
  if (
    value.v !== 1 ||
    value.provider !== "google" ||
    value.emailVerified !== true ||
    typeof value.sub !== "string" || value.sub.length < 3 || value.sub.length > 255 ||
    typeof value.email !== "string" || !validEmail(normalizeEmail(value.email)) ||
    typeof value.name !== "string" || value.name.length > 100 ||
    typeof value.handoffHash !== "string" || value.handoffHash.length !== 64 ||
    typeof value.exp !== "number" ||
    value.exp <= now ||
    value.exp > now + GOOGLE_HANDOFF_MAX_FUTURE_MS
  ) {
    throw Object.assign(new Error("invalid_google_handoff"), { status: 400 });
  }

  return value as GoogleHandoffPayload;
}

async function createGoogleSession(
  request: IncomingMessage,
  userId: string
) {
  const ids = createIdentityIds();
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const session = {
    id: ids.sessionId,
    userId,
    tokenHash: tokenHash(token),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + REMEMBER_SESSION_MS).toISOString(),
    lastSeenAt: now.toISOString(),
    userAgent: userAgent(request),
    ipHash: privacyIpHash(request),
    revokedAt: null
  };
  await store.createSession(session);
  return { token, maxAgeSeconds: REMEMBER_SESSION_MS / 1000 };
}

async function resolveOrCreateGoogleUser(payload: GoogleHandoffPayload) {
  const email = normalizeEmail(payload.email);
  const existing = await store.findUserByEmail(email);
  if (existing) {
    if (existing.disabled) {
      throw Object.assign(new Error("account_disabled"), { status: 403 });
    }
    if (!existing.emailVerified) {
      const verified = await store.markEmailVerified(existing.id);
      return verified ?? existing;
    }
    return existing;
  }

  const ids = createIdentityIds();
  const now = new Date().toISOString();
  const displayName = cleanDisplayName(payload.name) || email.split("@")[0].slice(0, 100) || "Google User";
  const credential = await hashPassword(randomBytes(48).toString("base64url"));
  const organizationName = displayName + " Workspace";
  const organizationSlug =
    slugBase(displayName) + "-" + ids.userId.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase();

  const user: StoredIdentityUser = {
    id: ids.userId,
    email,
    displayName,
    emailVerified: true,
    disabled: false,
    createdAt: now,
    updatedAt: now
  };

  await store.createUserBundle({
    user,
    credential,
    organization: {
      id: ids.organizationId,
      name: organizationName,
      slug: organizationSlug,
      createdAt: now,
      updatedAt: now
    },
    membership: {
      id: ids.membershipId,
      userId: ids.userId,
      organizationId: ids.organizationId,
      role: "owner",
      joinedAt: now,
      disabled: false
    }
  });

  return user;
}

export async function handleIdentityRecoveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const isRecovery = url.pathname.startsWith("/v1/auth/recovery/");
  const isGoogleHandoff = url.pathname === "/v1/auth/google/handoff";
  if (!isRecovery && !isGoogleHandoff) return false;

  try {
    await store.ready();
  } catch (error) {
    console.error("Identity recovery store initialization failed", error);
    sendJson(response, 503, { error: "identity_store_unavailable" }, origin, allowedOrigins);
    return true;
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    !mutationOriginAllowed(request, allowedOrigins)
  ) {
    sendJson(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET" && isGoogleHandoff) {
    try {
      const payloadEncoded = String(url.searchParams.get("payload") ?? "").trim();
      const signature = String(url.searchParams.get("sig") ?? "").trim();
      if (payloadEncoded.length > 4096 || signature.length > 256) {
        throw Object.assign(new Error("invalid_google_handoff"), { status: 400 });
      }

      const payload = decodeGoogleHandoff(payloadEncoded, signature);
      const handoffCookie = parseCookies(request).get(GOOGLE_HANDOFF_COOKIE) ?? "";
      if (!handoffCookie || !safeTextEqual(tokenHash(handoffCookie), payload.handoffHash)) {
        throw Object.assign(new Error("invalid_google_handoff"), { status: 400 });
      }

      const user = await resolveOrCreateGoogleUser(payload);
      const session = await createGoogleSession(request, user.id);
      const destination = safeReturnTo(url.searchParams.get("return_to"));

      response.statusCode = 302;
      response.setHeader("location", destination);
      response.setHeader("cache-control", "no-store");
      response.setHeader("set-cookie", [
        sessionCookieValue(session.token, session.maxAgeSeconds),
        clearGoogleHandoffCookieValue()
      ]);
      response.end();
    } catch (error) {
      console.error("Google identity handoff failed", {
        error: errorCode(error),
        status: errorStatus(error)
      });
      response.statusCode = 302;
      response.setHeader(
        "location",
        "/kosh/sign-in?google_error=" + encodeURIComponent(errorCode(error))
      );
      response.setHeader("cache-control", "no-store");
      response.setHeader("set-cookie", clearGoogleHandoffCookieValue());
      response.end();
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/auth/recovery/link") {
    try {
      const email = normalizeEmail(url.searchParams.get("email"));
      const expiresAtMs = Number(url.searchParams.get("exp") ?? 0);
      const signature = String(url.searchParams.get("sig") ?? "").trim();
      const now = Date.now();
      if (
        !validEmail(email) ||
        !Number.isFinite(expiresAtMs) ||
        expiresAtMs <= now ||
        expiresAtMs > now + SIGNED_LINK_MAX_FUTURE_MS ||
        !signature
      ) {
        throw Object.assign(new Error("invalid_or_expired_recovery_link"), { status: 400 });
      }
      const expected = signedLinkSignature(email, expiresAtMs);
      if (!expected || !safeTextEqual(signature, expected)) {
        throw Object.assign(new Error("invalid_or_expired_recovery_link"), { status: 400 });
      }

      const user = await store.findUserByEmail(email);
      if (!user || user.disabled) {
        throw Object.assign(new Error("invalid_or_expired_recovery_link"), { status: 400 });
      }

      const reset = await createResetToken(user.id);
      const publicOrigin = (
        process.env.WORKSPACE_RECOVERY_PUBLIC_ORIGIN?.trim() ||
        "https://tamishra.in/kosh"
      ).replace(/\/$/, "");
      const destination = publicOrigin + "/reset-password?token=" + encodeURIComponent(reset.token);
      response.statusCode = 302;
      response.setHeader("location", destination);
      response.setHeader("cache-control", "no-store");
      response.end();
    } catch (error) {
      sendJson(response, errorStatus(error), { error: errorCode(error) }, origin, allowedOrigins);
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/auth/recovery/issue") {
    if (!safeSecretMatches(request)) {
      sendJson(response, 404, { error: "not_found" }, origin, allowedOrigins);
      return true;
    }

    try {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      if (!validEmail(email)) {
        throw Object.assign(new Error("invalid_email"), { status: 400 });
      }
      const user = await store.findUserByEmail(email);
      if (!user || user.disabled) {
        throw Object.assign(new Error("account_not_found"), { status: 404 });
      }

      const reset = await createResetToken(user.id);
      sendJson(response, 201, reset, origin, allowedOrigins);
    } catch (error) {
      sendJson(response, errorStatus(error), { error: errorCode(error) }, origin, allowedOrigins);
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/auth/recovery/reset") {
    try {
      const body = await readJson(request);
      const token = String(body.token ?? "").trim();
      if (token.length < 32 || token.length > 256) {
        throw Object.assign(new Error("invalid_or_expired_reset_token"), { status: 400 });
      }
      const password = validatePassword(body.password);
      const reset = await store.consumeIdentityToken(tokenHash(token), "reset-password");
      if (!reset) {
        throw Object.assign(new Error("invalid_or_expired_reset_token"), { status: 400 });
      }

      const credential = await hashPassword(password);
      await store.replacePasswordCredential(reset.userId, credential);
      await store.revokeAllUserSessions(reset.userId);

      sendJson(response, 200, { reset: true }, origin, allowedOrigins);
    } catch (error) {
      sendJson(response, errorStatus(error), { error: errorCode(error) }, origin, allowedOrigins);
    }
    return true;
  }

  return false;
}
