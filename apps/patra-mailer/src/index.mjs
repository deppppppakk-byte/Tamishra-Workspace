import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import postgres from "postgres";
import nodemailer from "nodemailer";
import PostalMime from "postal-mime";
import { SMTPServer } from "smtp-server";

const databaseUrl =
  process.env.WORKSPACE_DATABASE_URL?.trim() ||
  process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("WORKSPACE_DATABASE_URL is required for Patra Mailer.");
}

const sql = postgres(databaseUrl, { max: 5, prepare: false });
const publicDomain =
  process.env.PATRA_MAIL_DOMAIN?.trim().toLowerCase() || "patra.tamishra.in";
const companyDomain =
  process.env.PATRA_COMPANY_MAIL_DOMAIN?.trim().toLowerCase() || "tamishra.in";
const acceptedDomains = new Set([publicDomain, companyDomain]);

const listenHost = process.env.PATRA_SMTP_LISTEN_HOST?.trim() || "0.0.0.0";
const listenPort = Number(process.env.PATRA_SMTP_LISTEN_PORT ?? 2525);
const maxMessageBytes = Number(
  process.env.PATRA_SMTP_MAX_MESSAGE_BYTES ?? 26_214_400
);
const pollMs = Math.max(
  1000,
  Number(process.env.PATRA_DELIVERY_POLL_MS ?? 5000)
);
const maxAttempts = Math.max(
  1,
  Number(process.env.PATRA_DELIVERY_MAX_ATTEMPTS ?? 5)
);
const healthPort = Number(process.env.PATRA_HEALTH_PORT ?? 4201);

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeAddress(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const address = value.trim().toLowerCase();
    return address ? { address } : null;
  }
  const address = String(value.address ?? "").trim().toLowerCase();
  if (!address) return null;
  const name = String(value.name ?? "").trim();
  return name ? { name, address } : { address };
}

function normalizeAddressList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(normalizeAddress).filter(Boolean);
}

function domainOf(address) {
  return String(address ?? "").trim().toLowerCase().split("@").pop() || "";
}

function tlsPem(name) {
  const value = process.env[name]?.trim();
  return value ? value.replace(/\\n/g, "\n") : null;
}

async function ensureSchema() {
  await sql`
    create table if not exists workspace_users (
      id text primary key,
      email text not null unique,
      display_name text not null,
      email_verified boolean not null default false,
      disabled boolean not null default false,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists patra_mailboxes (
      id text primary key,
      user_id text not null references workspace_users(id) on delete cascade,
      local_part text not null,
      domain text not null,
      address text not null unique,
      mailbox_class text not null,
      display_name text not null,
      status text not null default 'active',
      quota_bytes bigint not null default 5368709120,
      used_bytes bigint not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique(user_id, domain)
    )
  `;

  await sql`
    create table if not exists patra_folders (
      id text primary key,
      mailbox_id text not null references patra_mailboxes(id) on delete cascade,
      name text not null,
      kind text not null,
      created_at timestamptz not null default now(),
      unique(mailbox_id, kind)
    )
  `;

  await sql`
    create table if not exists patra_messages (
      id text primary key,
      mailbox_id text not null references patra_mailboxes(id) on delete cascade,
      folder_id text not null references patra_folders(id) on delete cascade,
      thread_id text not null,
      from_name text,
      from_address text not null,
      to_json jsonb not null default '[]'::jsonb,
      cc_json jsonb not null default '[]'::jsonb,
      bcc_json jsonb not null default '[]'::jsonb,
      subject text not null default '',
      text_body text not null default '',
      html_body text,
      preview text not null default '',
      received_at timestamptz,
      sent_at timestamptz,
      is_read boolean not null default false,
      starred boolean not null default false,
      labels_json jsonb not null default '[]'::jsonb,
      delivery_status text not null,
      internet_message_id text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    create table if not exists patra_delivery_queue (
      id text primary key,
      message_id text not null references patra_messages(id) on delete cascade,
      mailbox_id text not null references patra_mailboxes(id) on delete cascade,
      status text not null default 'queued',
      attempts integer not null default 0,
      next_attempt_at timestamptz not null default now(),
      last_error text,
      recipients_json jsonb not null default '[]'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `;

  await sql`
    alter table patra_delivery_queue
    add column if not exists recipients_json jsonb not null default '[]'::jsonb
  `;

  await sql`
    create index if not exists patra_delivery_queue_ready_idx
    on patra_delivery_queue(status, next_attempt_at, created_at)
  `;
}

async function mailboxForAddress(address) {
  const normalized = String(address).trim().toLowerCase();
  const rows = await sql`
    select *
    from patra_mailboxes
    where address=${normalized} and status='active'
    limit 1
  `;
  return rows[0] ?? null;
}

async function inboxFolder(mailboxId) {
  const rows = await sql`
    select id
    from patra_folders
    where mailbox_id=${mailboxId} and kind='inbox'
    limit 1
  `;
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function storeInboundMessage(mailbox, parsed, envelopeRecipient) {
  const folderId = await inboxFolder(String(mailbox.id));
  if (!folderId) throw new Error("Patra inbox folder is missing.");

  const from =
    normalizeAddress(parsed.from) ||
    normalizeAddress(parsed.sender) ||
    { address: "unknown@invalid" };
  const to = normalizeAddressList(parsed.to);
  const cc = normalizeAddressList(parsed.cc);
  const subject = String(parsed.subject ?? "").slice(0, 998);
  const textBody = String(parsed.text ?? "").slice(0, 2_000_000);
  const htmlBody =
    typeof parsed.html === "string"
      ? parsed.html.slice(0, 4_000_000)
      : null;
  const preview = textBody.replace(/\s+/g, " ").trim().slice(0, 180);
  const receivedAt = new Date().toISOString();
  const messageId = "msg_" + randomUUID();
  const threadId =
    String(parsed.inReplyTo ?? parsed.messageId ?? "").trim() ||
    "thr_" + randomUUID();
  const internetMessageId =
    String(parsed.messageId ?? "").trim() || null;
  const toJson = JSON.stringify(
    to.length ? to : [{ address: envelopeRecipient }]
  );
  const ccJson = JSON.stringify(cc);

  await sql`
    insert into patra_messages(
      id, mailbox_id, folder_id, thread_id,
      from_name, from_address, to_json, cc_json, bcc_json,
      subject, text_body, html_body, preview,
      received_at, sent_at, is_read, starred,
      labels_json, delivery_status, internet_message_id
    ) values (
      ${messageId}, ${String(mailbox.id)}, ${folderId}, ${threadId},
      ${from.name ?? null}, ${from.address},
      ${toJson}::jsonb, ${ccJson}::jsonb, '[]'::jsonb,
      ${subject}, ${textBody}, ${htmlBody}, ${preview},
      ${receivedAt}, null, false, false,
      '[]'::jsonb, 'delivered-local', ${internetMessageId}
    )
  `;
}

function outboundTransport() {
  const host = process.env.PATRA_SMTP_RELAY_HOST?.trim();
  if (!host) return null;

  const port = Number(process.env.PATRA_SMTP_RELAY_PORT ?? 587);
  const secure =
    process.env.PATRA_SMTP_RELAY_SECURE === "true" || port === 465;
  const user = process.env.PATRA_SMTP_RELAY_USER?.trim();
  const pass = process.env.PATRA_SMTP_RELAY_PASSWORD ?? "";

  return nodemailer.createTransport({
    host,
    port,
    secure,
    pool: true,
    maxConnections: Number(process.env.PATRA_SMTP_RELAY_CONNECTIONS ?? 5),
    maxMessages: Number(process.env.PATRA_SMTP_RELAY_MAX_MESSAGES ?? 100),
    auth: user ? { user, pass } : undefined,
    requireTLS:
      process.env.PATRA_SMTP_RELAY_REQUIRE_TLS === "true"
  });
}

const transport = outboundTransport();

async function claimQueueItem() {
  const rows = await sql`
    update patra_delivery_queue
    set
      status='processing',
      attempts=attempts+1,
      updated_at=now()
    where id=(
      select id
      from patra_delivery_queue
      where status='queued'
        and next_attempt_at <= now()
      order by created_at asc
      limit 1
      for update skip locked
    )
    returning *
  `;
  return rows[0] ?? null;
}

async function outboundPayload(queue) {
  const rows = await sql`
    select
      q.id as queue_id,
      q.attempts,
      q.recipients_json,
      m.*,
      b.address as mailbox_address,
      b.display_name as mailbox_display_name,
      b.domain as mailbox_domain
    from patra_delivery_queue q
    join patra_messages m on m.id=q.message_id
    join patra_mailboxes b on b.id=q.mailbox_id
    where q.id=${String(queue.id)}
    limit 1
  `;
  return rows[0] ?? null;
}

function dkimConfig(domain) {
  const privateKey = tlsPem("PATRA_DKIM_PRIVATE_KEY");
  const keySelector = process.env.PATRA_DKIM_SELECTOR?.trim();
  if (!privateKey || !keySelector) return undefined;
  return {
    domainName: domain,
    keySelector,
    privateKey
  };
}

async function markQueueDelivered(queueId, messageId, internetMessageId) {
  await sql`
    update patra_delivery_queue
    set status='delivered', last_error=null, updated_at=now()
    where id=${queueId}
  `;
  await sql`
    update patra_messages
    set
      delivery_status='sent-external',
      sent_at=coalesce(sent_at, now()),
      internet_message_id=coalesce(${internetMessageId}, internet_message_id),
      updated_at=now()
    where id=${messageId}
  `;
}

async function markQueueFailed(queue, messageId, error) {
  const attempts = Number(queue.attempts ?? 1);
  const message = String(error instanceof Error ? error.message : error)
    .slice(0, 2000);

  if (attempts >= maxAttempts) {
    await sql`
      update patra_delivery_queue
      set status='failed', last_error=${message}, updated_at=now()
      where id=${String(queue.id)}
    `;
    await sql`
      update patra_messages
      set delivery_status='failed', updated_at=now()
      where id=${messageId}
    `;
    return;
  }

  const delayMinutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
  await sql`
    update patra_delivery_queue
    set
      status='queued',
      last_error=${message},
      next_attempt_at=now() + make_interval(mins => ${delayMinutes}),
      updated_at=now()
    where id=${String(queue.id)}
  `;
}

async function processOneOutbound() {
  if (!transport) return false;
  const queue = await claimQueueItem();
  if (!queue) return false;

  const payload = await outboundPayload(queue);
  if (!payload) {
    await markQueueFailed(queue, "", new Error("delivery_payload_not_found"));
    return true;
  }

  const envelopeRecipients = parseJsonArray(payload.recipients_json)
    .map((item) => normalizeAddress(item)?.address)
    .filter(Boolean);

  if (!envelopeRecipients.length) {
    await markQueueFailed(
      queue,
      String(payload.id),
      new Error("external_recipient_missing")
    );
    return true;
  }

  const to = parseJsonArray(payload.to_json);
  const cc = parseJsonArray(payload.cc_json);
  const bcc = parseJsonArray(payload.bcc_json);
  const senderAddress = String(payload.mailbox_address);
  const senderName = String(payload.mailbox_display_name ?? "");
  const senderDomain = String(payload.mailbox_domain ?? domainOf(senderAddress));

  try {
    const info = await transport.sendMail({
      envelope: {
        from: senderAddress,
        to: envelopeRecipients
      },
      from: senderName
        ? { name: senderName, address: senderAddress }
        : senderAddress,
      to,
      cc,
      bcc: bcc.filter((entry) =>
        envelopeRecipients.includes(String(entry.address ?? "").toLowerCase())
      ),
      subject: String(payload.subject ?? ""),
      text: String(payload.text_body ?? ""),
      html: payload.html_body ? String(payload.html_body) : undefined,
      messageId:
        payload.internet_message_id
          ? String(payload.internet_message_id)
          : undefined,
      dkim: dkimConfig(senderDomain)
    });

    await markQueueDelivered(
      String(queue.id),
      String(payload.id),
      String(info.messageId ?? "") || null
    );
  } catch (error) {
    await markQueueFailed(queue, String(payload.id), error);
  }

  return true;
}

async function outboundLoop() {
  for (;;) {
    try {
      let processed = 0;
      while (processed < 20 && (await processOneOutbound())) {
        processed += 1;
      }
    } catch (error) {
      console.error("Patra outbound worker error", error);
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxMessageBytes) {
        reject(Object.assign(new Error("message_too_large"), { responseCode: 552 }));
        stream.destroy();
        return;
      }
      chunks.push(buffer);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function smtpServer() {
  const key = tlsPem("PATRA_SMTP_TLS_KEY");
  const cert = tlsPem("PATRA_SMTP_TLS_CERT");
  const disabledCommands = ["AUTH"];
  if (!key || !cert) disabledCommands.push("STARTTLS");

  return new SMTPServer({
    name: process.env.PATRA_SMTP_HOSTNAME?.trim() || "mx.patra.tamishra.in",
    secure: false,
    key: key ?? undefined,
    cert: cert ?? undefined,
    authOptional: true,
    disabledCommands,
    size: maxMessageBytes,
    maxClients: Number(process.env.PATRA_SMTP_MAX_CLIENTS ?? 100),
    socketTimeout: Number(process.env.PATRA_SMTP_SOCKET_TIMEOUT_MS ?? 60_000),

    async onRcptTo(address, session, callback) {
      try {
        const recipient = String(address.address ?? "").trim().toLowerCase();
        if (!acceptedDomains.has(domainOf(recipient))) {
          const error = new Error("Relay not permitted");
          error.responseCode = 550;
          callback(error);
          return;
        }

        const mailbox = await mailboxForAddress(recipient);
        if (!mailbox) {
          const error = new Error("Mailbox unavailable");
          error.responseCode = 550;
          callback(error);
          return;
        }

        callback();
      } catch (error) {
        callback(error);
      }
    },

    async onData(stream, session, callback) {
      try {
        const raw = await collectStream(stream);
        if (stream.sizeExceeded || raw.length > maxMessageBytes) {
          const error = new Error("Message too large");
          error.responseCode = 552;
          callback(error);
          return;
        }

        const parsed = await PostalMime.parse(raw);
        const recipients = Array.from(
          new Set(
            session.envelope.rcptTo
              .map((item) => String(item.address ?? "").trim().toLowerCase())
              .filter(Boolean)
          )
        );

        let delivered = 0;
        for (const recipient of recipients) {
          const mailbox = await mailboxForAddress(recipient);
          if (!mailbox) continue;
          await storeInboundMessage(mailbox, parsed, recipient);
          delivered += 1;
        }

        if (!delivered) {
          const error = new Error("No valid Patra recipients");
          error.responseCode = 550;
          callback(error);
          return;
        }

        callback(null, "Patra accepted message for delivery");
      } catch (error) {
        console.error("Patra inbound SMTP error", error);
        callback(error);
      }
    }
  });
}

await ensureSchema();

const healthServer = createServer(async (request, response) => {
  if (request.url !== "/health" && request.url !== "/ready") {
    response.statusCode = 404;
    response.end("not found");
    return;
  }

  try {
    if (request.url === "/ready") {
      await sql`select 1 as ok`;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(
      JSON.stringify({
        service: "tamishra-patra-mailer",
        status: "ok",
        database: "ready",
        inboundSmtp: true,
        outboundRelayConfigured: Boolean(transport),
        domains: Array.from(acceptedDomains)
      })
    );
  } catch {
    response.statusCode = 503;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ service: "tamishra-patra-mailer", status: "not-ready" }));
  }
});

healthServer.listen(healthPort, "0.0.0.0", () => {
  console.log(`Patra Mailer health endpoint listening on :${healthPort}`);
});

const server = smtpServer();
server.on("error", (error) => {
  console.error("Patra SMTP server error", error);
});

server.listen(listenPort, listenHost, () => {
  console.log(
    `Patra SMTP receiver listening on ${listenHost}:${listenPort} for ${Array.from(acceptedDomains).join(", ")}`
  );
  if (!transport) {
    console.warn(
      "PATRA_SMTP_RELAY_HOST is not configured; outbound external delivery will remain queued."
    );
  }
});

void outboundLoop();
