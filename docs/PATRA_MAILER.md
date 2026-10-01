# Patra Mailer

Patra Mailer is the independent SMTP delivery service for Tamishra Patra.

It is intentionally separated from the Workspace web/gateway process. The gateway owns authenticated mailbox operations; Patra Mailer owns internet mail transport.

## Service responsibilities

### Inbound SMTP

Patra Mailer:

1. listens for SMTP delivery
2. accepts only recipients under configured Patra-owned domains
3. rejects unknown mailboxes
4. applies a message-size limit
5. parses RFC email/MIME
6. stores the message in the recipient's Patra Inbox
7. does not act as an open relay

Configured native domains:

- `patra.in` — public Patra accounts
- `tamishra.in` — protected Tamishra company accounts

### Outbound SMTP

Messages created through the Patra API are delivered immediately to local Patra recipients.

External recipients are written to `patra_delivery_queue`. Patra Mailer:

1. claims queued work atomically
2. sends only the external SMTP envelope recipients
3. preserves normal To/Cc headers
4. hides Bcc from visible headers
5. signs with DKIM when configured
6. retries transient failures with exponential backoff
7. marks the message failed after the configured retry limit
8. records successful external delivery state

## Runtime

From the monorepo root:

```text
npm run dev:patra-mailer
npm run start:patra-mailer
npm run check:patra-mailer
```

Health endpoints:

```text
GET http://<mailer-host>:4201/health
GET http://<mailer-host>:4201/ready
```

`/ready` checks database connectivity.

## SMTP ports

Development may use:

```text
PATRA_SMTP_LISTEN_PORT=2525
```

For real internet MX delivery, the public mail host normally needs SMTP on TCP port 25. Use an infrastructure-level mapping or configure the process accordingly.

Do not expose the Workspace gateway itself on port 25.

## DNS required before public launch

The following are deployment requirements, not values that are currently live.

### A / AAAA

Point the chosen MX hostname, for example:

```text
mx.patra.in
```

to the public mail server.

### MX

Example:

```text
patra.in.      MX 10 mx.patra.in.
tamishra.in.   MX 10 mx.patra.in.
```

Only publish the `tamishra.in` MX change after confirming it will not disrupt any existing company mail service.

### SPF

A starting policy when the MX host is the authorized sender:

```text
v=spf1 mx -all
```

Adjust this before deployment if other legitimate Tamishra senders exist.

### DKIM

Patra Mailer supports a configured selector, for example:

```text
PATRA_DKIM_SELECTOR=patra1
```

Publish the matching public key at:

```text
patra1._domainkey.patra.in
patra1._domainkey.tamishra.in
```

Use separate keys per domain in production if operational separation is required.

### DMARC

Begin with monitoring while validating SPF/DKIM alignment, then strengthen the policy after successful delivery testing.

Example monitoring record:

```text
_dmarc.patra.in TXT "v=DMARC1; p=none"
```

Do not move directly to a strict reject policy until legitimate send paths have been verified.

### Reverse DNS

The outbound mail server's public IP should have PTR/reverse DNS aligned with its SMTP hostname. Forward DNS and reverse DNS should agree.

## TLS

Set:

```text
PATRA_SMTP_TLS_KEY=
PATRA_SMTP_TLS_CERT=
```

When both are available, the inbound SMTP server can advertise STARTTLS. Without them, STARTTLS is disabled rather than presenting an invalid certificate.

Outbound relay TLS is controlled with:

```text
PATRA_SMTP_RELAY_REQUIRE_TLS=true
```

Do not disable certificate validation in production.

## Outbound MTA boundary

`PATRA_SMTP_RELAY_HOST` should point to a Tamishra-controlled SMTP MTA/relay.

Patra application code does not depend on Gmail, Outlook, Microsoft Graph, Google APIs, or Microsoft APIs.

The mailer remains provider-neutral: the SMTP relay can be a self-hosted MTA deployed by Tamishra.

## Current implementation status

Implemented:

- public `@patra.in` mailbox provisioning
- protected `@tamishra.in` mailbox provisioning
- system folders
- persistent messages
- drafts
- local Patra-to-Patra delivery
- external delivery queue
- inbound SMTP recipient validation
- inbound MIME parsing
- inbound Inbox persistence
- outbound SMTP worker
- SMTP retry/backoff
- DKIM hook
- TLS hook
- health/readiness endpoints

Still required before calling public internet mail production-ready:

- deploy a public mail host
- configure port 25 reachability
- configure DNS/MX
- configure SPF
- generate/publish DKIM keys
- configure DMARC
- configure PTR/reverse DNS
- configure a production SMTP MTA/relay
- attachment object storage and malware scanning
- bounce/DSN processing
- spam/reputation controls
- abuse/rate-limit policy
- end-to-end deliverability testing
