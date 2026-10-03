import type { IncomingMessage, ServerResponse } from "node:http";
import postgres from "postgres";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  koshOpsFairSharePolicy,
  koshOpsPoolJobTypes,
  type KoshOpsWorkerPool
} from "./kosh-ops-pool-claim.js";

let sql: ReturnType<typeof postgres> | null = null;

type Identity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

type ScopeEvidence = {
  repositoryId: string | null;
  queued: number;
  leased: number;
  oldestQueuedAgeMs: number;
  highestQueuedPriority: number;
  pools: Record<string, { queued: number; leased: number; oldestQueuedAgeMs: number; highestQueuedPriority: number }>;
};

function database() {
  if (sql) return sql;
  const value = process.env.WORKSPACE_DATABASE_URL?.trim();
  if (!value) return null;
  sql = postgres(value, { max: 2, prepare: false });
  return sql;
}

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

function poolForType(type: string): Exclude<KoshOpsWorkerPool, "all"> | "unknown" {
  for (const pool of ["general", "storage", "recovery", "database", "isolated"] as const) {
    if ((koshOpsPoolJobTypes[pool] as readonly string[]).includes(type)) return pool;
  }
  return "unknown";
}

function emptyPoolEvidence() {
  return { queued: 0, leased: 0, oldestQueuedAgeMs: 0, highestQueuedPriority: 0 };
}

export async function getKoshOpsFairnessEvidence() {
  const db = database();
  const policy = koshOpsFairSharePolicy();
  if (!db) {
    return {
      checkedAt: new Date().toISOString(),
      persistence: "ephemeral-memory" as const,
      policy,
      scopes: [] as ScopeEvidence[]
    };
  }

  const rows = await db`
    SELECT repository_id, type, state, COUNT(*)::int AS count,
      MIN(GREATEST(created_at, available_at)) FILTER (WHERE state = 'queued') AS oldest_queued_at,
      MAX(priority) FILTER (WHERE state = 'queued') AS highest_queued_priority
    FROM kosh_ops_jobs
    WHERE state IN ('queued', 'leased')
    GROUP BY repository_id, type, state
  `;

  const now = Date.now();
  const scopes = new Map<string, ScopeEvidence>();
  for (const row of rows) {
    const repositoryId = row.repository_id == null ? null : String(row.repository_id);
    const key = repositoryId ?? "__platform__";
    const item = scopes.get(key) ?? {
      repositoryId,
      queued: 0,
      leased: 0,
      oldestQueuedAgeMs: 0,
      highestQueuedPriority: 0,
      pools: {}
    };
    const pool = poolForType(String(row.type));
    const poolEvidence = item.pools[pool] ?? emptyPoolEvidence();
    const count = Math.max(0, Number(row.count) || 0);
    const queued = String(row.state) === "queued";
    if (queued) {
      item.queued += count;
      poolEvidence.queued += count;
      item.highestQueuedPriority = Math.max(item.highestQueuedPriority, Number(row.highest_queued_priority) || 0);
      poolEvidence.highestQueuedPriority = Math.max(
        poolEvidence.highestQueuedPriority,
        Number(row.highest_queued_priority) || 0
      );
      if (row.oldest_queued_at) {
        const age = Math.max(0, now - new Date(String(row.oldest_queued_at)).getTime());
        item.oldestQueuedAgeMs = Math.max(item.oldestQueuedAgeMs, age);
        poolEvidence.oldestQueuedAgeMs = Math.max(poolEvidence.oldestQueuedAgeMs, age);
      }
    } else {
      item.leased += count;
      poolEvidence.leased += count;
    }
    item.pools[pool] = poolEvidence;
    scopes.set(key, item);
  }

  return {
    checkedAt: new Date().toISOString(),
    persistence: "postgres" as const,
    policy,
    scopes: [...scopes.values()]
      .sort((a, b) => b.queued - a.queued || b.leased - a.leased || b.oldestQueuedAgeMs - a.oldestQueuedAgeMs)
      .slice(0, 200)
  };
}

export async function handleKoshOpsFairnessRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (request.method !== "GET" || url.pathname !== "/v1/kosh/systems/operations/fairness") return false;

  const identity = await resolveKoshIdentity(request);
  if (!identity || !platformAdministrator(identity)) {
    json(response, identity ? 403 : 401, {
      error: identity ? "platform_admin_required" : "authentication_required"
    }, origin, allowedOrigins);
    return true;
  }

  try {
    json(response, 200, await getKoshOpsFairnessEvidence(), origin, allowedOrigins);
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : "operations_fairness_evidence_failed"
    }, origin, allowedOrigins);
  }
  return true;
}
