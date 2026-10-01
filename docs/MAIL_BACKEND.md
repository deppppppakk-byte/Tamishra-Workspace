# Tamishra Mail backend boundary

Tamishra Mail is intentionally split into a reusable client and a secure mail gateway.

## Client responsibilities

The web, desktop and mobile clients may:

- show folders, threads, messages and attachments
- compose and edit drafts
- request provider connection
- request synchronization
- display account health
- submit new credentials only over an authenticated encrypted channel

Clients must **not** persist OAuth refresh tokens, IMAP passwords, SMTP passwords or app passwords in browser local storage, IndexedDB, source files or public environment variables.

## Secure gateway responsibilities

The gateway must:

1. own OAuth client secrets
2. validate OAuth state and redirect URIs
3. exchange authorization codes server-side
4. encrypt provider refresh tokens at rest
5. store IMAP/SMTP secrets in a secret store or encrypted credential table
6. create short-lived provider sessions for mail operations
7. apply per-user authorization and account ownership checks
8. enforce rate limits and connection limits
9. scan or quarantine unsafe attachments before serving downloads
10. record security-sensitive actions in audit logs
11. normalize provider errors into MailProviderError
12. support incremental sync cursors

## Provider adapters

Initial adapters:

- Google Mail API via OAuth
- Microsoft Graph Mail via OAuth
- standards-based IMAP + SMTP
- LocalMailProvider for offline/demo development
- future Tamishra-hosted mailbox adapter

All adapters implement `MailProvider`. The UI must not import provider SDKs directly.

## OAuth flow

1. Client asks `MailGateway.beginOAuth`.
2. Gateway creates a signed/expiring state value.
3. User authorizes at the provider.
4. Provider returns an authorization code to the gateway callback.
5. Gateway validates state, exchanges the code and stores encrypted tokens.
6. Gateway returns only sanitized account metadata to the client.
7. The client refreshes folders/messages using the account ID.

## IMAP/SMTP flow

The user can enter server settings in the client, but credentials are sent only to the authenticated gateway over TLS. The gateway validates the connection and stores an encrypted secret reference. Raw passwords must never be returned to any client.

## Attachment safety

Attachments should have:

- declared and detected MIME type
- file-size limits
- filename normalization
- malware scanning hook
- signed/expiring download URLs
- content-disposition controls
- HTML/SVG sanitization where previewed

## Static web build

The current web app uses Next.js static export for portability to desktop/mobile packaging. For real external mail, deploy a separate authenticated gateway/API service or switch the hosted web build to a server-capable Next.js deployment. Do not add provider secrets to the static bundle.
