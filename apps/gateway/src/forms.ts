import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveWorkspaceIdentity } from "./identity.js";
import { createFormsStore } from "./forms-store.js";

type JsonObject = Record<string, unknown>;

const store = createFormsStore();
const MAX_BODY_BYTES = 2 * 1024 * 1024;

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

function mutationOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>
) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

function ownerFormId(pathname: string) {
  const match = pathname.match(/^\/v1\/forms\/([^/]+)(?:\/responses)?$/);
  if (!match || match[1] === "public") return null;
  return decodeURIComponent(match[1]);
}

function publicFormId(pathname: string) {
  const match = pathname.match(/^\/v1\/forms\/public\/([^/]+)(?:\/responses)?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}

function ruleMatches(
  rule: Record<string, unknown>,
  answers: Record<string, unknown>
) {
  const sourceId = String(rule.fieldId ?? rule.sourceFieldId ?? "");
  const raw = answers[sourceId];
  const value = Array.isArray(raw) ? raw.map(String).join(", ") : String(raw ?? "");
  const expected = String(rule.value ?? "");

  switch (String(rule.operator ?? "equals")) {
    case "not-equals":
      return value !== expected;
    case "contains":
      return value.toLowerCase().includes(expected.toLowerCase());
    case "is-empty":
      return value.trim() === "";
    case "is-not-empty":
      return value.trim() !== "";
    default:
      return value === expected;
  }
}

function reachableFieldIds(
  form: Record<string, unknown>,
  answers: Record<string, unknown>
) {
  const rawPages = Array.isArray(form.pages)
    ? form.pages.filter((page) => page && typeof page === "object") as Record<string, unknown>[]
    : [];
  if (!rawPages.length) return null;

  const pages = rawPages.map((page) => ({
    id: String(page.id ?? ""),
    fieldIds: stringArray(page.fieldIds),
    branchRules: Array.isArray(page.branchRules)
      ? page.branchRules.filter((rule) => rule && typeof rule === "object") as Record<string, unknown>[]
      : [],
    defaultNextPageId:
      typeof page.defaultNextPageId === "string" ? page.defaultNextPageId : null
  }));

  const byId = new Map(pages.map((page) => [page.id, page]));
  const reachable = new Set<string>();
  const visited = new Set<string>();
  let current = pages[0]?.id ?? "";
  let guard = 0;

  while (current && !visited.has(current) && guard <= pages.length) {
    guard += 1;
    visited.add(current);
    const page = byId.get(current);
    if (!page) break;
    page.fieldIds.forEach((fieldId) => reachable.add(fieldId));

    let next: string | null = null;
    for (const rule of page.branchRules) {
      if (ruleMatches(rule, answers)) {
        const target = String(rule.targetPageId ?? "");
        if (target && byId.has(target)) {
          next = target;
          break;
        }
      }
    }

    if (!next && page.defaultNextPageId && byId.has(page.defaultNextPageId)) {
      next = page.defaultNextPageId;
    }

    if (!next) {
      const index = pages.findIndex((candidate) => candidate.id === current);
      next = pages[index + 1]?.id ?? null;
    }

    current = next ?? "";
  }

  return reachable;
}

function validateSubmission(
  form: Record<string, unknown>,
  answers: Record<string, unknown>
) {
  const errors: Record<string, string> = {};
  const allowedFieldIds = reachableFieldIds(form, answers);
  const settings =
    form.settings && typeof form.settings === "object"
      ? form.settings as Record<string, unknown>
      : {};

  if (settings.collectEmail) {
    const email = String(answers.__respondentEmail ?? "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.__respondentEmail = "invalid_email";
    }
  }

  const fields = Array.isArray(form.fields)
    ? form.fields.filter((field) => field && typeof field === "object") as Record<string, unknown>[]
    : [];

  for (const field of fields) {
    const id = String(field.id ?? "");
    if (!id) continue;
    if (allowedFieldIds && !allowedFieldIds.has(id)) continue;

    const visibility =
      field.visibility && typeof field.visibility === "object"
        ? field.visibility as Record<string, unknown>
        : null;
    if (visibility && !ruleMatches(visibility, answers)) continue;

    const value = answers[id];
    const empty =
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0);

    if (Boolean(field.required) && empty) {
      errors[id] = "required";
      continue;
    }
    if (empty) continue;

    const type = String(field.type ?? "short-text");

    if (type === "email") {
      const email = String(value);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        errors[id] = "invalid_email";
        continue;
      }
    }

    if (type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        errors[id] = "invalid_number";
        continue;
      }
      const validation =
        field.validation && typeof field.validation === "object"
          ? field.validation as Record<string, unknown>
          : {};
      const min = validation.min ?? field.min;
      const max = validation.max ?? field.max;
      if (typeof min === "number" && number < min) errors[id] = "below_minimum";
      if (typeof max === "number" && number > max) errors[id] = "above_maximum";
    }

    if (type === "short-text" || type === "paragraph") {
      const validation =
        field.validation && typeof field.validation === "object"
          ? field.validation as Record<string, unknown>
          : {};
      const text = String(value);
      const minLength = validation.minLength;
      const maxLength = validation.maxLength;
      if (typeof minLength === "number" && text.length < minLength) {
        errors[id] = "below_minimum_length";
      }
      if (typeof maxLength === "number" && text.length > maxLength) {
        errors[id] = "above_maximum_length";
      }
    }

    if (type === "multiple-choice" || type === "dropdown" || type === "yes-no") {
      const options = stringArray(field.options);
      if (options.length && !options.includes(String(value))) {
        errors[id] = "invalid_option";
      }
    }

    if (type === "checkboxes") {
      const options = stringArray(field.options);
      const values = stringArray(value);
      if (values.some((item) => !options.includes(item))) {
        errors[id] = "invalid_option";
      }
    }
  }

  return errors;
}

export async function handleFormsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/forms")) return false;

  try {
    await store.ready();
  } catch (error) {
    console.error("Forms store initialization failed", error);
    sendJson(response, 503, { error: "forms_store_unavailable" }, origin, allowedOrigins);
    return true;
  }

  const publicId = publicFormId(url.pathname);

  if (url.pathname.startsWith("/v1/forms/public/") && publicId) {
    const publicBase = "/v1/forms/public/" + encodeURIComponent(publicId);

    if (request.method === "GET" && url.pathname === publicBase) {
      const stored = await store.getPublicForm(publicId);
      if (!stored) {
        sendJson(response, 404, { error: "form_not_found" }, origin, allowedOrigins);
        return true;
      }

      sendJson(
        response,
        200,
        {
          persistence: store.kind,
          revision: stored.revision,
          form: stored.payload,
          responseCount: await store.countResponses(publicId)
        },
        origin,
        allowedOrigins
      );
      return true;
    }

    if (request.method === "POST" && url.pathname === publicBase + "/responses") {
      if (!mutationOriginAllowed(request, allowedOrigins)) {
        sendJson(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
        return true;
      }

      const stored = await store.getPublicForm(publicId);
      if (!stored) {
        sendJson(response, 404, { error: "form_not_found" }, origin, allowedOrigins);
        return true;
      }
      if (stored.status !== "published") {
        sendJson(response, 409, { error: "form_closed" }, origin, allowedOrigins);
        return true;
      }

      try {
        const body = await readJson(request);
        const answers =
          body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
            ? body.answers as Record<string, unknown>
            : null;
        if (!answers) {
          throw Object.assign(new Error("invalid_answers"), { status: 400 });
        }

        const errors = validateSubmission(stored.payload, answers);
        if (Object.keys(errors).length) {
          sendJson(
            response,
            400,
            { error: "validation_failed", fields: errors },
            origin,
            allowedOrigins
          );
          return true;
        }

        const settings =
          stored.payload.settings && typeof stored.payload.settings === "object"
            ? stored.payload.settings as Record<string, unknown>
            : {};
        const configuredLimit = settings.responseLimit;
        const responseLimit =
          typeof configuredLimit === "number" && Number.isFinite(configuredLimit)
            ? Math.max(1, Math.floor(configuredLimit))
            : null;

        if (responseLimit !== null && (await store.countResponses(publicId)) >= responseLimit) {
          sendJson(response, 409, { error: "response_limit_reached" }, origin, allowedOrigins);
          return true;
        }

        const saved = await store.addResponse(publicId, answers);
        sendJson(
          response,
          201,
          { persistence: store.kind, response: saved },
          origin,
          allowedOrigins
        );
        return true;
      } catch (error) {
        const status = Number((error as { status?: number }).status ?? 500);
        sendJson(
          response,
          status,
          { error: error instanceof Error ? error.message : "submission_failed" },
          origin,
          allowedOrigins
        );
        return true;
      }
    }

    sendJson(response, 404, { error: "not_found" }, origin, allowedOrigins);
    return true;
  }

  const identity = await resolveWorkspaceIdentity(request);
  if (!identity) {
    sendJson(response, 401, { error: "authentication_required" }, origin, allowedOrigins);
    return true;
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    !mutationOriginAllowed(request, allowedOrigins)
  ) {
    sendJson(response, 403, { error: "origin_not_allowed" }, origin, allowedOrigins);
    return true;
  }

  const formId = ownerFormId(url.pathname);
  if (!formId) {
    sendJson(response, 404, { error: "not_found" }, origin, allowedOrigins);
    return true;
  }

  const ownerBase = "/v1/forms/" + encodeURIComponent(formId);

  if (request.method === "GET" && url.pathname === ownerBase) {
    const stored = await store.getOwnerForm(identity.user.id, formId);
    if (!stored) {
      sendJson(response, 404, { error: "form_not_found" }, origin, allowedOrigins);
      return true;
    }

    sendJson(
      response,
      200,
      {
        persistence: store.kind,
        revision: stored.revision,
        updatedAt: stored.updatedAt,
        form: stored.payload
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "PUT" && url.pathname === ownerBase) {
    try {
      const body = await readJson(request);
      const form =
        body.form && typeof body.form === "object" && !Array.isArray(body.form)
          ? body.form as Record<string, unknown>
          : null;
      if (!form) throw Object.assign(new Error("invalid_form"), { status: 400 });
      if (String(form.id ?? "") !== formId) {
        throw Object.assign(new Error("form_id_mismatch"), { status: 400 });
      }

      const revision =
        body.revision === undefined || body.revision === null
          ? undefined
          : Number(body.revision);
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
        throw Object.assign(new Error("invalid_revision"), { status: 400 });
      }

      const saved = await store.putOwnerForm(identity.user.id, formId, form, revision);
      sendJson(
        response,
        200,
        {
          persistence: store.kind,
          revision: saved.revision,
          updatedAt: saved.updatedAt,
          form: saved.payload
        },
        origin,
        allowedOrigins
      );
      return true;
    } catch (error) {
      const status = Number((error as { status?: number }).status ?? 500);
      sendJson(
        response,
        status,
        {
          error: error instanceof Error ? error.message : "form_save_failed",
          currentRevision: Number((error as { currentRevision?: number }).currentRevision ?? 0)
        },
        origin,
        allowedOrigins
      );
      return true;
    }
  }

  if (request.method === "GET" && url.pathname === ownerBase + "/responses") {
    const stored = await store.getOwnerForm(identity.user.id, formId);
    if (!stored) {
      sendJson(response, 404, { error: "form_not_found" }, origin, allowedOrigins);
      return true;
    }

    sendJson(
      response,
      200,
      {
        persistence: store.kind,
        responses: await store.listResponses(identity.user.id, formId)
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  sendJson(response, 404, { error: "not_found" }, origin, allowedOrigins);
  return true;
}
