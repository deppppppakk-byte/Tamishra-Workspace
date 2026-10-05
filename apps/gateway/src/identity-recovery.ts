import { createHash, randomBytes, randomUUID, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createIdentityStore } from "./identity-store.js";

const store = createIdentityStore();
const MAX_BODY_BYTES = 16_384;
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const RESET_TOKEN_TTL_MS = 20 * 60 * 1000;

type JsonObject = Record<string, unknown>;

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

function safeSecretMatches(request: IncomingMessage) {
  const expected = process.env.WORKSPACE_RECOVERY_ADMIN_SECRET?.trim() ?? "";
  const supplied = String(request.headers["x-workspace-recovery-secret"] ?? "").trim();
  if (!expected || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
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

export async function handleIdentityRecoveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/auth/recovery/")) return false;

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

      const token = randomBytes(32).toString("base64url");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS).toISOString();
      await store.createIdentityToken({
        id: randomUUID(),
        userId: user.id,
        purpose: "reset-password",
        tokenHash: tokenHash(token),
        createdAt: now.toISOString(),
        expiresAt,
        consumedAt: null
      });

      sendJson(response, 201, { token, expiresAt }, origin, allowedOrigins);
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
