import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  getKoshOpsFleetRecommendation,
  reconcileKoshOpsFleet
} from "./kosh-ops-fleet-scaling.js";

type Identity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function platformAdministrator(identity: Identity) {
  const ids = new Set(
    (process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  return ids.size > 0
    ? ids.has(identity.user.id)
    : process.env.NODE_ENV !== "production" &&
        identity.memberships.some((item) => ["owner", "admin"].includes(item.membership.role));
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin: string | undefined,
  allowed: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowed.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage) {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString();
    if (text.length > 16 * 1024) {
      throw Object.assign(new Error("request_body_too_large"), { status: 413 });
    }
  }
  if (!text.trim()) return {} as Record<string, unknown>;
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("invalid_json_body"), { status: 400 });
  }
  return parsed as Record<string, unknown>;
}

export async function handleKoshOpsFleetControllerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (url.pathname !== "/v1/kosh/systems/workers/capacity") return false;
  if (!new Set(["GET", "POST"]).has(request.method ?? "")) return false;

  const identity = await resolveKoshIdentity(request);
  if (!identity || !platformAdministrator(identity)) {
    json(response, identity ? 403 : 401, {
      error: identity ? "platform_admin_required" : "authentication_required"
    }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "GET") {
    json(response, 200, await getKoshOpsFleetRecommendation(), origin, allowedOrigins);
    return true;
  }

  if (origin && !allowedOrigins.has(origin)) {
    json(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  try {
    const body = await readJson(request);
    if (body.apply !== true) {
      json(response, 400, {
        error: "explicit_apply_required",
        recommendation: await getKoshOpsFleetRecommendation()
      }, origin, allowedOrigins);
      return true;
    }
    const result = await reconcileKoshOpsFleet({ apply: true, automatic: false });
    json(response, result.applied ? 202 : 200, result, origin, allowedOrigins);
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status) || 500;
    json(response, status, {
      error: error instanceof Error ? error.message : "fleet_reconcile_failed",
      upstreamStatus: Number((error as { upstreamStatus?: unknown })?.upstreamStatus) || undefined
    }, origin, allowedOrigins);
  }
  return true;
}
