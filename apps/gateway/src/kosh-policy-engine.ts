import type { IncomingMessage, ServerResponse } from "node:http";
import { authorizeKoshRepositoryRequest } from "./kosh-access.js";
import { resolveKoshIdentity } from "./kosh-auth.js";
import {
  getKoshPlatformStore,
  type StoredKoshPlatformResource
} from "./kosh-platform-store.js";
import { getKoshStore, type StoredKoshRepository } from "./kosh-store.js";

const repositoryStore = getKoshStore();
const platformStore = getKoshPlatformStore();
const POLICY_TYPE = "policy" as never;

export const koshPolicyTargets = [
  "merge",
  "automation",
  "deployment",
  "package",
  "storage",
  "extension",
  "repository"
] as const;

export const koshPolicyEffects = ["allow", "require", "deny"] as const;
export const koshPolicyOperators = [
  "equals",
  "not_equals",
  "in",
  "not_in",
  "exists",
  "contains"
] as const;

export type KoshPolicyTarget = typeof koshPolicyTargets[number];
export type KoshPolicyEffect = typeof koshPolicyEffects[number];
export type KoshPolicyOperator = typeof koshPolicyOperators[number];

export type KoshPolicyCondition = {
  field: string;
  operator: KoshPolicyOperator;
  value?: unknown;
};

export type KoshPolicyRule = {
  key: string;
  target: KoshPolicyTarget;
  action: string;
  effect: KoshPolicyEffect;
  message: string;
  conditions: KoshPolicyCondition[];
};

export type KoshPolicyDefinition = {
  mode: "enforce" | "observe";
  priority: number;
  description: string;
  rules: KoshPolicyRule[];
  revision: number;
};

export type KoshPolicyDecision = {
  decision: "allow" | "require" | "deny" | "neutral";
  target: KoshPolicyTarget;
  action: string;
  matched: Array<{
    policyId: string;
    policyKey: string;
    policyName: string;
    policyMode: "enforce" | "observe";
    ruleKey: string;
    effect: KoshPolicyEffect;
    message: string;
  }>;
  blocking: Array<{
    policyId: string;
    ruleKey: string;
    effect: "deny" | "require";
    message: string;
  }>;
};

type JsonBody = Record<string, unknown>;
type Identity = NonNullable<Awaited<ReturnType<typeof resolveKoshIdentity>>>;

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
  allowedOrigins?: ReadonlySet<string>
) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  if (origin && allowedOrigins?.has(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("vary", "origin");
  }
  response.end(JSON.stringify(body));
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 256 * 1024
): Promise<JsonBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("payload_too_large"), { status: 413 });
    }
    chunks.push(bytes);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_json");
    }
    return parsed as JsonBody;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

function clean(value: unknown, maxLength: number) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > 3) {
    throw Object.assign(new Error("policy_value_too_deep"), { status: 400 });
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return typeof value === "string" ? value.slice(0, 1000) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw Object.assign(new Error("invalid_policy_value"), { status: 400 });
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => safeValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([key, item]) => [clean(key, 120), safeValue(item, depth + 1)])
        .filter(([key]) => Boolean(key))
    );
  }
  throw Object.assign(new Error("invalid_policy_value"), { status: 400 });
}

function requireAllowedOrigin(
  request: IncomingMessage,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (
    request.method &&
    !["GET", "HEAD"].includes(request.method) &&
    origin &&
    !allowedOrigins.has(origin)
  ) {
    throw Object.assign(new Error("origin_not_allowed"), { status: 403 });
  }
}

function validateCondition(value: unknown): KoshPolicyCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("invalid_policy_condition"), { status: 400 });
  }
  const input = value as Record<string, unknown>;
  const field = clean(input.field, 160);
  const operator = clean(input.operator, 32) as KoshPolicyOperator;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/.test(field)) {
    throw Object.assign(new Error("invalid_policy_condition_field"), {
      status: 400
    });
  }
  if (!(koshPolicyOperators as readonly string[]).includes(operator)) {
    throw Object.assign(new Error("invalid_policy_condition_operator"), {
      status: 400
    });
  }
  return operator === "exists"
    ? { field, operator }
    : { field, operator, value: safeValue(input.value) };
}

function validateRule(value: unknown, index: number): KoshPolicyRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("invalid_policy_rule"), { status: 400 });
  }
  const input = value as Record<string, unknown>;
  const key = clean(input.key || `rule-${index + 1}`, 80);
  const target = clean(input.target, 40) as KoshPolicyTarget;
  const effect = clean(input.effect, 24) as KoshPolicyEffect;
  const action = clean(input.action || "*", 120);
  const message = clean(input.message, 500);

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(key)) {
    throw Object.assign(new Error("invalid_policy_rule_key"), { status: 400 });
  }
  if (!(koshPolicyTargets as readonly string[]).includes(target)) {
    throw Object.assign(new Error("invalid_policy_target"), { status: 400 });
  }
  if (!(koshPolicyEffects as readonly string[]).includes(effect)) {
    throw Object.assign(new Error("invalid_policy_effect"), { status: 400 });
  }
  if (!action || !/^[a-zA-Z0-9*][a-zA-Z0-9._:*\/-]{0,119}$/.test(action)) {
    throw Object.assign(new Error("invalid_policy_action"), { status: 400 });
  }

  const rawConditions = Array.isArray(input.conditions) ? input.conditions : [];
  if (rawConditions.length > 32) {
    throw Object.assign(new Error("policy_rule_too_many_conditions"), {
      status: 400
    });
  }
  return {
    key,
    target,
    action,
    effect,
    message,
    conditions: rawConditions.map(validateCondition)
  };
}

function validateDefinition(
  value: unknown,
  previousRevision = 0
): KoshPolicyDefinition {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawRules = Array.isArray(input.rules) ? input.rules : [];
  if (rawRules.length < 1 || rawRules.length > 200) {
    throw Object.assign(new Error("policy_rules_required"), { status: 400 });
  }
  const rules = rawRules.map(validateRule);
  const keys = new Set<string>();
  for (const rule of rules) {
    if (keys.has(rule.key)) {
      throw Object.assign(new Error("duplicate_policy_rule_key"), { status: 400 });
    }
    keys.add(rule.key);
  }
  const rawPriority = Number(input.priority ?? 0);
  return {
    mode: input.mode === "observe" ? "observe" : "enforce",
    priority: Number.isFinite(rawPriority)
      ? Math.max(-1000, Math.min(1000, Math.floor(rawPriority)))
      : 0,
    description: clean(input.description, 1000),
    rules,
    revision: previousRevision + 1
  };
}

function definition(resource: StoredKoshPlatformResource): KoshPolicyDefinition {
  const payload = resource.payload;
  return {
    mode: payload.mode === "observe" ? "observe" : "enforce",
    priority: Number(payload.priority) || 0,
    description: String(payload.description ?? ""),
    rules: Array.isArray(payload.rules)
      ? payload.rules as unknown as KoshPolicyRule[]
      : [],
    revision: Math.max(1, Number(payload.revision) || 1)
  };
}

function payload(value: KoshPolicyDefinition) {
  return {
    mode: value.mode,
    priority: value.priority,
    description: value.description,
    rules: value.rules,
    revision: value.revision
  };
}

function publicPolicy(resource: StoredKoshPlatformResource) {
  return {
    id: resource.id,
    repositoryId: resource.repositoryId,
    namespace: resource.namespace,
    key: resource.key,
    name: resource.name,
    state: resource.state,
    ...definition(resource),
    createdByUserId: resource.createdByUserId,
    createdByName: resource.createdByName,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt
  };
}

function valueAtPath(context: Record<string, unknown>, field: string): unknown {
  let current: unknown = context;
  for (const segment of field.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function equal(left: unknown, right: unknown) {
  if (
    (left === null || ["string", "number", "boolean"].includes(typeof left)) &&
    (right === null || ["string", "number", "boolean"].includes(typeof right))
  ) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function conditionMatches(
  context: Record<string, unknown>,
  condition: KoshPolicyCondition
) {
  const actual = valueAtPath(context, condition.field);
  switch (condition.operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "equals":
      return equal(actual, condition.value);
    case "not_equals":
      return !equal(actual, condition.value);
    case "in":
      return Array.isArray(condition.value) &&
        condition.value.some((item) => equal(actual, item));
    case "not_in":
      return Array.isArray(condition.value) &&
        !condition.value.some((item) => equal(actual, item));
    case "contains":
      if (Array.isArray(actual)) {
        return actual.some((item) => equal(item, condition.value));
      }
      return typeof actual === "string" && typeof condition.value === "string"
        ? actual.includes(condition.value)
        : false;
  }
}

function actionMatches(pattern: string, action: string) {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === action;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(action);
}

async function policiesFor(repositoryId: string | null, includeGlobal: boolean) {
  const local = await platformStore.listResources(POLICY_TYPE, repositoryId);
  if (!includeGlobal || repositoryId === null) return local;
  const global = await platformStore.listResources(POLICY_TYPE, null);
  return [...global, ...local];
}

export async function evaluateKoshPolicy(input: {
  repositoryId: string | null;
  target: KoshPolicyTarget;
  action: string;
  context?: Record<string, unknown>;
  includeGlobal?: boolean;
}): Promise<KoshPolicyDecision> {
  await platformStore.ready();
  const policies = (await policiesFor(
    input.repositoryId,
    input.includeGlobal !== false
  ))
    .filter((item) => item.state === "active")
    .sort((left, right) =>
      definition(right).priority - definition(left).priority ||
      left.createdAt.localeCompare(right.createdAt)
    );
  const matched: KoshPolicyDecision["matched"] = [];
  const context = input.context ?? {};

  for (const policy of policies) {
    const policyDefinition = definition(policy);
    for (const rule of policyDefinition.rules) {
      if (rule.target !== input.target) continue;
      if (!actionMatches(rule.action, input.action)) continue;
      if (!rule.conditions.every((condition) => conditionMatches(context, condition))) {
        continue;
      }
      matched.push({
        policyId: policy.id,
        policyKey: policy.key,
        policyName: policy.name,
        policyMode: policyDefinition.mode,
        ruleKey: rule.key,
        effect: rule.effect,
        message: rule.message
      });
    }
  }

  const enforcing = matched.filter((item) => item.policyMode === "enforce");
  const decision: KoshPolicyDecision["decision"] =
    enforcing.some((item) => item.effect === "deny")
      ? "deny"
      : enforcing.some((item) => item.effect === "require")
        ? "require"
        : enforcing.some((item) => item.effect === "allow")
          ? "allow"
          : "neutral";

  return {
    decision,
    target: input.target,
    action: input.action,
    matched,
    blocking: enforcing
      .filter((item) => item.effect === "deny" || item.effect === "require")
      .map((item) => ({
        policyId: item.policyId,
        ruleKey: item.ruleKey,
        effect: item.effect as "deny" | "require",
        message: item.message
      }))
  };
}

function requirePlatformAdministrator(identity: Identity) {
  const configured = new Set(
    (process.env.KOSH_PLATFORM_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const allowed = configured.size > 0
    ? configured.has(identity.user.id)
    : process.env.NODE_ENV !== "production" &&
      identity.memberships.some((item) =>
        item.membership.role === "owner" || item.membership.role === "admin"
      );
  if (!allowed) {
    throw Object.assign(new Error("platform_admin_required"), { status: 403 });
  }
}

async function audit(
  repositoryId: string | null,
  identity: Identity,
  eventType: string,
  resourceId: string | null,
  metadata: Record<string, unknown>
) {
  await platformStore.appendAudit({
    repositoryId,
    actorUserId: identity.user.id,
    actorName: identity.user.displayName,
    eventType,
    resourceType: "policy",
    resourceId,
    metadata
  });
}

async function authorizeRepository(
  request: IncomingMessage,
  repository: StoredKoshRepository,
  write: boolean
) {
  const authorization = await authorizeKoshRepositoryRequest(
    request,
    repository,
    write ? "repository.manage" : "repository.read"
  );
  if (!authorization.decision.allowed || !authorization.identity) {
    throw Object.assign(
      new Error(
        authorization.identity
          ? "repository_permission_denied"
          : "authentication_required"
      ),
      { status: authorization.identity ? 403 : 401 }
    );
  }
  return authorization.identity;
}

async function globalIdentity(request: IncomingMessage) {
  const identity = await resolveKoshIdentity(request, "repo:write");
  if (!identity) {
    throw Object.assign(new Error("authentication_required"), { status: 401 });
  }
  requirePlatformAdministrator(identity);
  return identity;
}

async function createPolicy(
  repositoryId: string | null,
  namespace: string,
  identity: Identity,
  body: JsonBody
) {
  const key = clean(body.key, 100).toLowerCase();
  const name = clean(body.name, 160);
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(key) || !name) {
    throw Object.assign(new Error("valid_policy_identity_required"), {
      status: 400
    });
  }
  const policyDefinition = validateDefinition(body);
  const resource = await platformStore.createResource({
    repositoryId,
    namespace,
    type: POLICY_TYPE,
    key,
    name,
    state: body.enabled === false ? "disabled" : "active",
    payload: payload(policyDefinition),
    createdByUserId: identity.user.id,
    createdByName: identity.user.displayName
  });
  await audit(repositoryId, identity, "policy_created", resource.id, {
    key,
    mode: policyDefinition.mode,
    priority: policyDefinition.priority
  });
  return resource;
}

async function updatePolicy(
  resource: StoredKoshPlatformResource,
  identity: Identity,
  body: JsonBody
) {
  const current = definition(resource);
  const next = validateDefinition({
    mode: body.mode ?? current.mode,
    priority: body.priority ?? current.priority,
    description: body.description ?? current.description,
    rules: body.rules ?? current.rules
  }, current.revision);
  const name = body.name === undefined ? resource.name : clean(body.name, 160);
  if (!name) {
    throw Object.assign(new Error("policy_name_required"), { status: 400 });
  }
  const state = body.enabled === undefined
    ? resource.state
    : body.enabled === true ? "active" : "disabled";
  const updated = await platformStore.updateResource(resource.id, {
    name,
    state,
    payload: payload(next)
  });
  if (!updated) {
    throw Object.assign(new Error("policy_not_found"), { status: 404 });
  }
  await audit(resource.repositoryId, identity, "policy_updated", resource.id, {
    key: resource.key,
    revision: next.revision,
    state
  });
  return updated;
}

async function handleCollection(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  repositoryId: string | null,
  namespace: string,
  identity: Identity,
  tail: string
) {
  if (tail === "" && request.method === "GET") {
    const policies = (await platformStore.listResources(POLICY_TYPE, repositoryId))
      .filter((item) => item.state !== "archived")
      .map(publicPolicy);
    json(response, 200, { policies }, origin, allowedOrigins);
    return true;
  }

  if (tail === "" && request.method === "POST") {
    const resource = await createPolicy(
      repositoryId,
      namespace,
      identity,
      await readJson(request)
    );
    json(response, 201, publicPolicy(resource), origin, allowedOrigins);
    return true;
  }

  if (tail === "/evaluate" && request.method === "POST") {
    const body = await readJson(request);
    const target = clean(body.target, 40) as KoshPolicyTarget;
    const action = clean(body.action, 120);
    if (!(koshPolicyTargets as readonly string[]).includes(target) || !action) {
      throw Object.assign(new Error("valid_policy_evaluation_required"), {
        status: 400
      });
    }
    const context = safeValue(body.context ?? {});
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw Object.assign(new Error("policy_context_must_be_object"), {
        status: 400
      });
    }
    const result = await evaluateKoshPolicy({
      repositoryId,
      target,
      action,
      context: context as Record<string, unknown>
    });
    await audit(repositoryId, identity, "policy_evaluated", null, {
      target,
      action,
      decision: result.decision,
      matched: result.matched.map((item) => ({
        policyId: item.policyId,
        ruleKey: item.ruleKey,
        effect: item.effect,
        mode: item.policyMode
      }))
    });
    json(response, 200, result, origin, allowedOrigins);
    return true;
  }

  const match = tail.match(/^\/([0-9a-f-]{36})$/i);
  if (!match) return false;
  const resource = await platformStore.getResource(match[1]);
  if (
    !resource ||
    String(resource.type) !== "policy" ||
    resource.repositoryId !== repositoryId
  ) {
    throw Object.assign(new Error("policy_not_found"), { status: 404 });
  }

  if (request.method === "GET") {
    json(response, 200, publicPolicy(resource), origin, allowedOrigins);
    return true;
  }
  if (request.method === "PATCH") {
    const updated = await updatePolicy(resource, identity, await readJson(request));
    json(response, 200, publicPolicy(updated), origin, allowedOrigins);
    return true;
  }
  if (request.method === "DELETE") {
    const updated = await platformStore.updateResource(resource.id, {
      state: "archived"
    });
    if (!updated) {
      throw Object.assign(new Error("policy_not_found"), { status: 404 });
    }
    await audit(repositoryId, identity, "policy_archived", resource.id, {
      key: resource.key
    });
    json(response, 200, publicPolicy(updated), origin, allowedOrigins);
    return true;
  }
  return false;
}

function routeError(
  response: ServerResponse,
  error: unknown,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const status =
    typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
  json(
    response,
    status,
    { error: error instanceof Error ? error.message : "kosh_policy_error" },
    origin,
    allowedOrigins
  );
}

export async function handleKoshPolicyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const repositoryMatch = url.pathname.match(
    /^\/v1\/kosh\/repos\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})\/policies(\/.*)?$/
  );
  const globalMatch = url.pathname.match(
    /^\/v1\/kosh\/systems\/policies(\/.*)?$/
  );
  if (!repositoryMatch && !globalMatch) return false;

  try {
    requireAllowedOrigin(request, origin, allowedOrigins);
    await platformStore.ready();

    if (repositoryMatch) {
      const repository = await repositoryStore.get(
        repositoryMatch[1],
        repositoryMatch[2]
      );
      if (!repository) {
        throw Object.assign(new Error("repository_not_found"), { status: 404 });
      }
      const write = !["GET", "HEAD"].includes(request.method ?? "GET");
      const identity = await authorizeRepository(request, repository, write);
      return await handleCollection(
        request,
        response,
        origin,
        allowedOrigins,
        repository.id,
        repository.namespace,
        identity,
        repositoryMatch[3] ?? ""
      );
    }

    const identity = await globalIdentity(request);
    return await handleCollection(
      request,
      response,
      origin,
      allowedOrigins,
      null,
      "global",
      identity,
      globalMatch?.[1] ?? ""
    );
  } catch (error) {
    routeError(response, error, origin, allowedOrigins);
    return true;
  }
}
