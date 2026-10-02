import {
  createHash,
  randomBytes,
  scrypt as nodeScrypt,
  timingSafeEqual
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createIdentityIds,
  createIdentityStore,
  type StoredIdentitySession,
  type StoredIdentityUser
} from "./identity-store.js";
import { getPatraStore } from "./patra-store.js";

type JsonObject = Record<string, unknown>;

const store = createIdentityStore();
const patraStore = getPatraStore();
const MAX_BODY_BYTES = 16_384;
const SESSION_COOKIE =
  process.env.WORKSPACE_SESSION_COOKIE_NAME?.trim() ||
  "tamishra_workspace_session";
const SESSION_COOKIE_PATH =
  process.env.WORKSPACE_SESSION_COOKIE_PATH?.trim() ||
  (process.env.NODE_ENV === "production" ? "/api/workspace" : "/");
const SECURE_COOKIE =
  process.env.WORKSPACE_SESSION_COOKIE_SECURE === "true" ||
  process.env.NODE_ENV === "production";
const DEFAULT_SESSION_MS = 12 * 60 * 60 * 1000;
const REMEMBER_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const attempts = new Map<string, { count: number; resetAt: number }>();

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

function validEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

async function verifyPassword(
  password: string,
  credential: {
    passwordHash: string;
    passwordSalt: string;
    scryptN: number;
    scryptR: number;
    scryptP: number;
    keyLength: number;
  }
) {
  const salt = Buffer.from(credential.passwordSalt, "base64");
  const expected = Buffer.from(credential.passwordHash, "base64");
  const actual = await scrypt(password, salt, credential.keyLength, {
    N: credential.scryptN,
    r: credential.scryptR,
    p: credential.scryptP,
    maxmem: Math.max(
      SCRYPT_MAXMEM,
      128 * credential.scryptN * credential.scryptR + 1024 * 1024
    )
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function fakePasswordWork(password: string) {
  const salt = Buffer.from("tamishra-workspace-auth-fake-salt");
  await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  });
}

function sessionToken() {
  return randomBytes(32).toString("base64url");
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function cookieValue(token: string, maxAgeSeconds: number) {
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

function clearCookieValue() {
  const parts = [
    SESSION_COOKIE + "=",
    "HttpOnly",
    "SameSite=Lax",
    "Path=" + SESSION_COOKIE_PATH,
    "Max-Age=0",
    "Priority=High"
  ];
  if (SECURE_COOKIE) parts.push("Secure");
  return parts.join("; ");
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

function publicUser(user: StoredIdentityUser) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    emailVerified: user.emailVerified,
    disabled: user.disabled,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function publicSession(session: StoredIdentitySession, currentId?: string) {
  return {
    id: session.id,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    userAgent: session.userAgent,
    revokedAt: session.revokedAt,
    current: session.id === currentId
  };
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

function rateKey(request: IncomingMessage, bucket: string, subject = "") {
  return bucket + ":" + requestIp(request) + ":" + subject;
}

function checkRateLimit(
  request: IncomingMessage,
  bucket: string,
  subject: string,
  limit: number,
  windowMs: number
) {
  const key = rateKey(request, bucket, subject);
  const now = Date.now();
  const existing = attempts.get(key);
  if (!existing || existing.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  existing.count += 1;
  if (existing.count > limit) {
    throw Object.assign(new Error("too_many_attempts"), { status: 429 });
  }
}

function mutationOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>
) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

async function createSession(
  request: IncomingMessage,
  userId: string,
  remember: boolean
) {
  const ids = createIdentityIds();
  const token = sessionToken();
  const now = new Date();
  const ttl = remember ? REMEMBER_SESSION_MS : DEFAULT_SESSION_MS;
  const session: StoredIdentitySession = {
    id: ids.sessionId,
    userId,
    tokenHash: tokenHash(token),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    lastSeenAt: now.toISOString(),
    userAgent: userAgent(request),
    ipHash: privacyIpHash(request),
    revokedAt: null
  };
  await store.createSession(session);
  return { session, token, maxAgeSeconds: ttl / 1000 };
}

async function currentIdentity(request: IncomingMessage) {
  const token = parseCookies(request).get(SESSION_COOKIE);
  if (!token) return null;
  const session = await store.findSessionByTokenHash(tokenHash(token));
  if (!session) return null;
  const user = await store.getUser(session.userId);
  if (!user || user.disabled) return null;
  await store.touchSession(session.id);
  return { user, session };
}

export async function resolveWorkspaceIdentity(request: IncomingMessage) {
  await store.ready();
  return currentIdentity(request);
}

export async function resolveWorkspaceAuthorization(request: IncomingMessage) {
  await store.ready();
  const identity = await currentIdentity(request);
  if (!identity) return null;
  const memberships = await store.listMemberships(identity.user.id);
  return { ...identity, memberships };
}

export async function getWorkspaceIdentityUser(userId: string) {
  await store.ready();
  const user = await store.getUser(userId);
  return user && !user.disabled ? user : null;
}

export async function getWorkspaceIdentityAuthorization(userId: string) {
  await store.ready();
  const user = await store.getUser(userId);
  if (!user || user.disabled) return null;
  const memberships = await store.listMemberships(userId);
  return { user, memberships };
}

export async function listWorkspaceOrganizationMembers(organizationId: string) {
  await store.ready();
  return store.listOrganizationMembers(organizationId);
}

function errorStatus(error: unknown) {
  return Number((error as { status?: number }).status ?? 500);
}

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code === "23505") return "email_already_registered";
  }
  return error instanceof Error ? error.message : "identity_error";
}

export async function handleIdentityRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/auth")) return false;

  try {
    await store.ready();
  } catch (error) {
    console.error("Workspace identity store initialization failed", error);
    sendJson(
      response,
      503,
      { error: "identity_store_unavailable" },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/auth/capabilities") {
    sendJson(
      response,
      200,
      {
        product: "Tamishra Workspace Identity",
        native: true,
        persistence: store.kind,
        capabilities: {
          password: true,
          passkey: false,
          recoveryCodes: false,
          emailVerification: false,
          externalIdentityProviders: false
        }
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    !mutationOriginAllowed(request, allowedOrigins)
  ) {
    sendJson(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/auth/register") {
    try {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      const displayName = cleanDisplayName(body.displayName);
      const password = validatePassword(body.password);

      checkRateLimit(request, "register", email, 5, 15 * 60 * 1000);

      if (!validEmail(email)) {
        throw Object.assign(new Error("invalid_email"), { status: 400 });
      }
      if (displayName.length < 2) {
        throw Object.assign(new Error("invalid_display_name"), { status: 400 });
      }

      const existing = await store.findUserByEmail(email);
      if (existing) {
        throw Object.assign(new Error("email_already_registered"), { status: 409 });
      }

      const ids = createIdentityIds();
      const now = new Date().toISOString();
      const credential = await hashPassword(password);
      const organizationName = displayName + " Workspace";
      const organizationSlug =
        slugBase(displayName) + "-" + ids.userId.replace(/[^a-z0-9]/gi, "").slice(-8).toLowerCase();

      const user: StoredIdentityUser = {
        id: ids.userId,
        email,
        displayName,
        emailVerified: false,
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

      const created = await createSession(request, user.id, false);
      const memberships = await store.listMemberships(user.id);
      response.setHeader(
        "set-cookie",
        cookieValue(created.token, created.maxAgeSeconds)
      );

      sendJson(
        response,
        201,
        {
          authenticated: true,
          user: publicUser(user),
          session: publicSession(created.session, created.session.id),
          memberships,
          persistence: store.kind
        },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      const code = errorCode(error);
      sendJson(
        response,
        code === "email_already_registered" ? 409 : errorStatus(error),
        { error: code },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && url.pathname === "/v1/auth/sign-in") {
    try {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password ?? "");
      const remember = body.remember === true;

      checkRateLimit(request, "signin", email, 8, 15 * 60 * 1000);

      if (!validEmail(email) || !password || password.length > 256) {
        throw Object.assign(new Error("invalid_credentials"), { status: 401 });
      }

      let user = await store.findUserByEmail(email);

      if (!user && email.includes("@")) {
        const mailbox = await patraStore.getMailboxByAddress(email).catch(() => null);
        if (mailbox) {
          user = await store.getUser(mailbox.userId);
        }
      }

      if (!user) {
        await fakePasswordWork(password);
        throw Object.assign(new Error("invalid_credentials"), { status: 401 });
      }

      const credential = await store.getPasswordCredential(user.id);
      if (!credential || !(await verifyPassword(password, credential))) {
        throw Object.assign(new Error("invalid_credentials"), { status: 401 });
      }

      if (user.disabled) {
        throw Object.assign(new Error("account_disabled"), { status: 403 });
      }

      const created = await createSession(request, user.id, remember);
      const memberships = await store.listMemberships(user.id);
      response.setHeader(
        "set-cookie",
        cookieValue(created.token, created.maxAgeSeconds)
      );

      sendJson(
        response,
        200,
        {
          authenticated: true,
          user: publicUser(user),
          session: publicSession(created.session, created.session.id),
          memberships,
          persistence: store.kind
        },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      sendJson(
        response,
        errorStatus(error),
        { error: errorCode(error) },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "POST" && url.pathname === "/v1/auth/sign-out") {
    const identity = await currentIdentity(request);
    if (identity) await store.revokeSession(identity.session.id);
    response.setHeader("set-cookie", clearCookieValue());
    sendJson(response, 200, { authenticated: false }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/auth/session") {
    const identity = await currentIdentity(request);
    if (!identity) {
      sendJson(response, 200, { authenticated: false }, origin, allowedOrigins);
      return true;
    }

    const memberships = await store.listMemberships(identity.user.id);
    sendJson(
      response,
      200,
      {
        authenticated: true,
        user: publicUser(identity.user),
        session: publicSession(identity.session, identity.session.id),
        memberships,
        persistence: store.kind
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/auth/sessions") {
    const identity = await currentIdentity(request);
    if (!identity) {
      sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
      return true;
    }

    const sessions = await store.listSessions(identity.user.id);
    sendJson(
      response,
      200,
      {
        sessions: sessions.map((session) =>
          publicSession(session, identity.session.id)
        )
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  const sessionMatch = url.pathname.match(/^\/v1\/auth\/sessions\/([^/]+)$/);
  if (request.method === "DELETE" && sessionMatch) {
    const identity = await currentIdentity(request);
    if (!identity) {
      sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
      return true;
    }

    const sessionId = decodeURIComponent(sessionMatch[1]);
    const sessions = await store.listSessions(identity.user.id);
    if (!sessions.some((session) => session.id === sessionId)) {
      sendJson(response, 404, { error: "session_not_found" }, origin, allowedOrigins);
      return true;
    }

    await store.revokeSession(sessionId);
    if (sessionId === identity.session.id) {
      response.setHeader("set-cookie", clearCookieValue());
    }
    sendJson(response, 200, { revoked: true }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "PATCH" && url.pathname === "/v1/auth/profile") {
    const identity = await currentIdentity(request);
    if (!identity) {
      sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
      return true;
    }

    try {
      const body = await readJson(request);
      const displayName = cleanDisplayName(body.displayName);
      if (displayName.length < 2) {
        throw Object.assign(new Error("invalid_display_name"), { status: 400 });
      }
      const user = await store.updateDisplayName(identity.user.id, displayName);
      if (!user) {
        sendJson(response, 404, { error: "user_not_found" }, origin, allowedOrigins);
        return true;
      }
      sendJson(response, 200, { user: publicUser(user) }, origin, allowedOrigins);
      return true;
    } catch (error) {
      sendJson(
        response,
        errorStatus(error),
        { error: errorCode(error) },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  const organizationMembersMatch = url.pathname.match(
    /^\/v1\/auth\/organizations\/([^/]+)\/members$/
  );
  if (request.method === "GET" && organizationMembersMatch) {
    const identity = await currentIdentity(request);
    if (!identity) {
      sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
      return true;
    }

    const organizationId = decodeURIComponent(organizationMembersMatch[1]);
    const memberships = await store.listMemberships(identity.user.id);
    const membership = memberships.find(
      (item) =>
        item.membership.organizationId === organizationId &&
        !item.membership.disabled
    );
    if (!membership || membership.membership.role === "guest") {
      sendJson(response, 403, { error: "organization_access_denied" }, origin, allowedOrigins);
      return true;
    }

    const members = await store.listOrganizationMembers(organizationId);
    sendJson(
      response,
      200,
      {
        members: members.map(({ membership: memberMembership, user }) => ({
          membership: memberMembership,
          user: publicUser(user)
        }))
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  return false;
}
