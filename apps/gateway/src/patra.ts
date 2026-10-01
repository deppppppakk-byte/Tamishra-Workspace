import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveWorkspaceIdentity } from "./identity.js";
import {
  createPatraStore,
  type PatraAddress,
  type PatraFolderKind,
  type StoredPatraMailbox
} from "./patra-store.js";

type JsonObject = Record<string, unknown>;

const store = createPatraStore();
const MAX_BODY_BYTES = 128 * 1024;
const PUBLIC_DOMAIN = (
  process.env.PATRA_MAIL_DOMAIN?.trim().toLowerCase() || "patra.in"
);
const COMPANY_DOMAIN = (
  process.env.PATRA_COMPANY_MAIL_DOMAIN?.trim().toLowerCase() || "tamishra.in"
);

const RESERVED_PUBLIC_NAMES = new Set([
  "abuse",
  "admin",
  "administrator",
  "billing",
  "hostmaster",
  "mailer-daemon",
  "noreply",
  "no-reply",
  "patra",
  "postmaster",
  "root",
  "security",
  "support",
  "tamishra",
  "webmaster"
]);

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

function normalizeUsername(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
}

function validateUsername(value: unknown, publicSignup: boolean) {
  const username = normalizeUsername(value);
  if (username.length < 3 || username.length > 64) {
    throw Object.assign(new Error("invalid_mailbox_username"), { status: 400 });
  }
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(username)) {
    throw Object.assign(new Error("invalid_mailbox_username"), { status: 400 });
  }
  if (
    username.includes("..") ||
    username.includes("__") ||
    username.includes("--")
  ) {
    throw Object.assign(new Error("invalid_mailbox_username"), { status: 400 });
  }
  if (publicSignup && RESERVED_PUBLIC_NAMES.has(username)) {
    throw Object.assign(new Error("mailbox_username_reserved"), { status: 409 });
  }
  return username;
}

function cleanDisplayName(value: unknown, fallback: string) {
  return String(value ?? fallback).trim().replace(/\s+/g, " ").slice(0, 100) || fallback;
}

function cleanSubject(value: unknown) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 998);
}

function cleanBody(value: unknown) {
  return String(value ?? "").slice(0, 2_000_000);
}

function normalizeAddress(value: unknown): PatraAddress | null {
  if (typeof value === "string") {
    const address = value.trim().toLowerCase().slice(0, 320);
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)
      ? { address }
      : null;
  }

  if (!value || typeof value !== "object") return null;
  const object = value as Record<string, unknown>;
  const address = String(object.address ?? "").trim().toLowerCase().slice(0, 320);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return null;
  const name = String(object.name ?? "").trim().slice(0, 100);
  return name ? { name, address } : { address };
}

function addressList(value: unknown, max = 100) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, max)
    .map(normalizeAddress)
    .filter((item): item is PatraAddress => Boolean(item));
}

function isFolderKind(value: unknown): value is PatraFolderKind {
  return ["inbox", "sent", "drafts", "archive", "spam", "trash"].includes(
    String(value)
  );
}

function publicMailbox(mailbox: StoredPatraMailbox) {
  return {
    id: mailbox.id,
    address: mailbox.address,
    localPart: mailbox.localPart,
    domain: mailbox.domain,
    mailboxClass: mailbox.mailboxClass,
    displayName: mailbox.displayName,
    status: mailbox.status,
    quotaBytes: mailbox.quotaBytes,
    usedBytes: mailbox.usedBytes,
    createdAt: mailbox.createdAt
  };
}

function mutationOriginAllowed(
  request: IncomingMessage,
  allowedOrigins: ReadonlySet<string>
) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

function secureSecretMatches(request: IncomingMessage) {
  const configured = process.env.PATRA_COMPANY_PROVISIONING_SECRET?.trim();
  if (!configured) return false;
  const supplied = String(
    request.headers["x-patra-company-provisioning-secret"] ?? ""
  );
  if (!supplied) return false;

  const left = createHash("sha256").update(configured).digest();
  const right = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(left, right);
}

function errorStatus(error: unknown) {
  const direct = Number((error as { status?: number }).status ?? 0);
  if (direct) return direct;
  const code = String((error as { code?: unknown }).code ?? "");
  if (code === "23505") return 409;
  return 500;
}

function errorCode(error: unknown) {
  const code = String((error as { code?: unknown }).code ?? "");
  if (code === "23505") return "mailbox_address_taken";
  return error instanceof Error ? error.message : "patra_error";
}

async function requireIdentity(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  const identity = await resolveWorkspaceIdentity(request);
  if (!identity) {
    sendJson(
      response,
      401,
      { error: "authentication_required" },
      origin,
      allowedOrigins
    );
    return null;
  }
  return identity;
}

async function ownedMailbox(
  userId: string,
  mailboxId: string
): Promise<StoredPatraMailbox | null> {
  const mailbox = await store.getMailbox(mailboxId);
  return mailbox?.userId === userId && mailbox.status === "active"
    ? mailbox
    : null;
}

function uniqueRecipients(...groups: PatraAddress[][]) {
  const map = new Map<string, PatraAddress>();
  for (const address of groups.flat()) {
    map.set(address.address.toLowerCase(), address);
  }
  return Array.from(map.values());
}

async function deliverLocally(
  sender: StoredPatraMailbox,
  recipients: PatraAddress[],
  input: {
    to: PatraAddress[];
    cc: PatraAddress[];
    subject: string;
    textBody: string;
    htmlBody: string | null;
    threadId: string;
    sentAt: string;
  }
) {
  let localCount = 0;
  const external: PatraAddress[] = [];

  for (const recipient of recipients) {
    const target = await store.getMailboxByAddress(recipient.address);
    if (!target || target.status !== "active") {
      external.push(recipient);
      continue;
    }

    await store.createMessage({
      mailboxId: target.id,
      folderKind: "inbox",
      from: {
        name: sender.displayName,
        address: sender.address
      },
      to: input.to,
      cc: input.cc,
      bcc: [],
      subject: input.subject,
      textBody: input.textBody,
      htmlBody: input.htmlBody,
      read: false,
      starred: false,
      labels: [],
      deliveryStatus: "delivered-local",
      receivedAt: input.sentAt,
      sentAt: input.sentAt,
      threadId: input.threadId,
      internetMessageId: null
    });
    localCount += 1;
  }

  return { localCount, external };
}

export async function handlePatraRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>
) {
  if (!url.pathname.startsWith("/v1/patra")) return false;

  try {
    await store.ready();
  } catch (error) {
    console.error("Patra store initialization failed", error);
    sendJson(
      response,
      503,
      { error: "patra_store_unavailable" },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") &&
    !mutationOriginAllowed(request, allowedOrigins)
  ) {
    sendJson(
      response,
      403,
      { error: "origin_not_allowed" },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/patra/capabilities") {
    sendJson(
      response,
      200,
      {
        service: "tamishra-patra",
        publicDomain: PUBLIC_DOMAIN,
        companyDomain: COMPANY_DOMAIN,
        persistence: store.kind,
        capabilities: {
          publicMailboxProvisioning: true,
          companyMailboxProvisioning: Boolean(
            process.env.PATRA_COMPANY_PROVISIONING_SECRET?.trim()
          ),
          folders: true,
          drafts: true,
          localDelivery: true,
          externalDeliveryQueue: true,
          smtpDeliveryConfigured: false,
          inboundSmtpConfigured: false
        }
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/patra/availability") {
    try {
      const username = validateUsername(url.searchParams.get("username"), true);
      const address = username + "@" + PUBLIC_DOMAIN;
      const available = await store.isAddressAvailable(address);
      sendJson(
        response,
        200,
        { username, address, available },
        origin,
        allowedOrigins
      );
    } catch (error) {
      sendJson(
        response,
        errorStatus(error),
        { error: errorCode(error) },
        origin,
        allowedOrigins
      );
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/v1/patra/mailboxes") {
    const identity = await requireIdentity(
      request,
      response,
      origin,
      allowedOrigins
    );
    if (!identity) return true;

    const mailboxes = await store.listMailboxesForUser(identity.user.id);
    sendJson(
      response,
      200,
      { mailboxes: mailboxes.map(publicMailbox), persistence: store.kind },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "POST" && url.pathname === "/v1/patra/mailboxes") {
    const identity = await requireIdentity(
      request,
      response,
      origin,
      allowedOrigins
    );
    if (!identity) return true;

    try {
      const body = await readJson(request);
      const username = validateUsername(body.username, true);
      const existing = await store.listMailboxesForUser(identity.user.id);
      const existingPublic = existing.find(
        (mailbox) => mailbox.domain === PUBLIC_DOMAIN
      );
      if (existingPublic) {
        sendJson(
          response,
          409,
          {
            error: "public_mailbox_already_exists",
            mailbox: publicMailbox(existingPublic)
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      const address = username + "@" + PUBLIC_DOMAIN;
      if (!(await store.isAddressAvailable(address))) {
        throw Object.assign(new Error("mailbox_address_taken"), { status: 409 });
      }

      const mailbox = await store.provisionMailbox({
        userId: identity.user.id,
        localPart: username,
        domain: PUBLIC_DOMAIN,
        mailboxClass: "public",
        displayName: identity.user.displayName
      });

      sendJson(
        response,
        201,
        { mailbox: publicMailbox(mailbox), persistence: store.kind },
        origin,
        allowedOrigins
      );
    } catch (error) {
      sendJson(
        response,
        errorStatus(error),
        { error: errorCode(error) },
        origin,
        allowedOrigins
      );
    }
    return true;
  }

  if (
    request.method === "POST" &&
    url.pathname === "/v1/patra/admin/company-mailboxes"
  ) {
    if (!secureSecretMatches(request)) {
      sendJson(
        response,
        403,
        { error: "company_provisioning_not_authorized" },
        origin,
        allowedOrigins
      );
      return true;
    }

    try {
      const body = await readJson(request);
      const userId = String(body.userId ?? "").trim();
      if (!userId) {
        throw Object.assign(new Error("user_id_required"), { status: 400 });
      }
      const username = validateUsername(body.username, false);
      const displayName = cleanDisplayName(body.displayName, username);
      const address = username + "@" + COMPANY_DOMAIN;

      if (!(await store.isAddressAvailable(address))) {
        throw Object.assign(new Error("mailbox_address_taken"), { status: 409 });
      }

      const existing = await store.listMailboxesForUser(userId);
      const existingCompany = existing.find(
        (mailbox) => mailbox.domain === COMPANY_DOMAIN
      );
      if (existingCompany) {
        sendJson(
          response,
          409,
          {
            error: "company_mailbox_already_exists",
            mailbox: publicMailbox(existingCompany)
          },
          origin,
          allowedOrigins
        );
        return true;
      }

      const mailbox = await store.provisionMailbox({
        userId,
        localPart: username,
        domain: COMPANY_DOMAIN,
        mailboxClass: "tamishra-company",
        displayName
      });

      sendJson(
        response,
        201,
        { mailbox: publicMailbox(mailbox) },
        origin,
        allowedOrigins
      );
    } catch (error) {
      sendJson(
        response,
        errorStatus(error),
        { error: errorCode(error) },
        origin,
        allowedOrigins
      );
    }
    return true;
  }

  const mailboxMatch = url.pathname.match(
    /^\/v1\/patra\/mailboxes\/([^/]+)(?:\/(.*))?$/
  );
  if (!mailboxMatch) return false;

  const identity = await requireIdentity(
    request,
    response,
    origin,
    allowedOrigins
  );
  if (!identity) return true;

  const mailboxId = decodeURIComponent(mailboxMatch[1]);
  const action = mailboxMatch[2] ?? "";
  const mailbox = await ownedMailbox(identity.user.id, mailboxId);

  if (!mailbox) {
    sendJson(
      response,
      404,
      { error: "mailbox_not_found" },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && action === "folders") {
    const folders = await store.listFolders(mailbox.id);
    sendJson(
      response,
      200,
      {
        mailbox: publicMailbox(mailbox),
        folders: folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          kind: folder.kind,
          totalCount: folder.totalCount ?? 0,
          unreadCount: folder.unreadCount ?? 0
        }))
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  if (request.method === "GET" && action === "messages") {
    const folderValue = url.searchParams.get("folder") ?? "inbox";
    if (!isFolderKind(folderValue)) {
      sendJson(
        response,
        400,
        { error: "invalid_folder" },
        origin,
        allowedOrigins
      );
      return true;
    }

    const messages = await store.listMessages(mailbox.id, folderValue, {
      search: url.searchParams.get("q") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 100)
    });
    sendJson(
      response,
      200,
      {
        mailbox: publicMailbox(mailbox),
        folder: folderValue,
        messages
      },
      origin,
      allowedOrigins
    );
    return true;
  }

  const messageMatch = action.match(/^messages\/([^/]+)$/);
  if (request.method === "GET" && messageMatch) {
    const message = await store.getMessage(
      mailbox.id,
      decodeURIComponent(messageMatch[1])
    );
    if (!message) {
      sendJson(
        response,
        404,
        { error: "message_not_found" },
        origin,
        allowedOrigins
      );
      return true;
    }
    sendJson(response, 200, { message }, origin, allowedOrigins);
    return true;
  }

  if (request.method === "PATCH" && messageMatch) {
    try {
      const body = await readJson(request);
      const folderKind =
        body.folder === undefined
          ? undefined
          : isFolderKind(body.folder)
            ? body.folder
            : null;
      if (folderKind === null) {
        throw Object.assign(new Error("invalid_folder"), { status: 400 });
      }

      const message = await store.updateMessageState(
        mailbox.id,
        decodeURIComponent(messageMatch[1]),
        {
          folderKind,
          read: typeof body.read === "boolean" ? body.read : undefined,
          starred:
            typeof body.starred === "boolean" ? body.starred : undefined
        }
      );
      if (!message) {
        sendJson(
          response,
          404,
          { error: "message_not_found" },
          origin,
          allowedOrigins
        );
        return true;
      }
      sendJson(response, 200, { message }, origin, allowedOrigins);
    } catch (error) {
      sendJson(
        response,
        errorStatus(error),
        { error: errorCode(error) },
        origin,
        allowedOrigins
      );
    }
    return true;
  }

  if (request.method === "POST" && action === "drafts") {
    try {
      const body = await readJson(request);
      const to = addressList(body.to);
      const cc = addressList(body.cc);
      const bcc = addressList(body.bcc);
      const message = await store.createMessage({
        mailboxId: mailbox.id,
        folderKind: "drafts",
        from: {
          name: mailbox.displayName,
          address: mailbox.address
        },
        to,
        cc,
        bcc,
        subject: cleanSubject(body.subject),
        textBody: cleanBody(body.textBody),
        htmlBody: null,
        read: true,
        starred: false,
        labels: [],
        deliveryStatus: "draft",
        sentAt: null,
        receivedAt: null,
        threadId: String(body.threadId ?? "").trim() || undefined
      });
      sendJson(response, 201, { message }, origin, allowedOrigins);
    } catch (error) {
      sendJson(
        response,
        errorStatus(error),
        { error: errorCode(error) },
        origin,
        allowedOrigins
      );
    }
    return true;
  }

  if (request.method === "POST" && action === "send") {
    try {
      const body = await readJson(request);
      const to = addressList(body.to);
      const cc = addressList(body.cc);
      const bcc = addressList(body.bcc);

      if (!to.length && !cc.length && !bcc.length) {
        throw Object.assign(new Error("recipient_required"), { status: 400 });
      }

      const subject = cleanSubject(body.subject);
      const textBody = cleanBody(body.textBody);
      const htmlBody = null;
      const sentAt = new Date().toISOString();
      const threadId = String(body.threadId ?? "").trim() || "thr_" + Date.now();

      const sent = await store.createMessage({
        mailboxId: mailbox.id,
        folderKind: "sent",
        from: {
          name: mailbox.displayName,
          address: mailbox.address
        },
        to,
        cc,
        bcc,
        subject,
        textBody,
        htmlBody,
        read: true,
        starred: false,
        labels: [],
        deliveryStatus: "queued",
        sentAt,
        receivedAt: null,
        threadId,
        internetMessageId: null
      });

      const recipients = uniqueRecipients(to, cc, bcc);
      const delivery = await deliverLocally(mailbox, recipients, {
        to,
        cc,
        subject,
        textBody,
        htmlBody,
        threadId: sent.threadId,
        sentAt
      });

      let queue = null;
      if (delivery.external.length) {
        queue = await store.enqueueDelivery(sent.id, mailbox.id, delivery.external);
      } else {
        await store.updateMessageState(mailbox.id, sent.id, {
          deliveryStatus: "delivered-local",
          sentAt
        });
      }

      sendJson(
        response,
        202,
        {
          messageId: sent.id,
          sentAt,
          localRecipients: delivery.localCount,
          externalRecipients: delivery.external.map((item) => item.address),
          delivery:
            delivery.external.length > 0
              ? "queued-for-external-smtp"
              : "delivered-locally",
          queueId: queue?.id ?? null
        },
        origin,
        allowedOrigins
      );
    } catch (error) {
      sendJson(
        response,
        errorStatus(error),
        { error: errorCode(error) },
        origin,
        allowedOrigins
      );
    }
    return true;
  }

  return false;
}
