# Tamishra Mail backend boundary

Tamishra Mail is a first-party Workspace service with an optional open-standards mail-server bridge.

## Product rule

Tamishra Mail must not depend on Google Mail, Microsoft Outlook, Microsoft Graph, Google APIs, Microsoft APIs or vendor OAuth services.

The primary mailbox is **Tamishra Mail**.

Optional interoperability is limited to standards-based mail protocols such as IMAP and SMTP for independently operated mail servers.

## Client responsibilities

Web, desktop and mobile may:

- show folders, threads, messages and attachments
- compose and edit drafts
- synchronize through the Tamishra Workspace gateway
- display account health
- configure an optional custom IMAP/SMTP server

Clients must never persist mailbox passwords or gateway secrets in browser local storage, IndexedDB, source files or public environment variables.

## Secure gateway responsibilities

The Workspace gateway must:

1. authenticate the Tamishra Workspace user
2. authorize mailbox ownership
3. encrypt custom mail-server credentials at rest
4. create short-lived mail sessions
5. enforce rate limits and connection limits
6. scan or quarantine unsafe attachments
7. record security-sensitive actions in audit logs
8. normalize provider errors into MailProviderError
9. support incremental synchronization
10. prevent raw credentials from being returned to clients

## Mail adapters

Initial adapters:

- Tamishra Mail — primary first-party mailbox
- standards-based IMAP + SMTP — optional custom-server bridge
- LocalMailProvider — offline/demo development

All adapters implement `MailProvider`.

The UI must not import external mail-provider SDKs directly.

## Tamishra-native mailbox flow

1. User signs in to Tamishra Workspace.
2. The Workspace gateway resolves the user's Tamishra Mail account.
3. The mail client requests folders/messages through the authenticated gateway.
4. Drafts and outgoing messages are submitted to Tamishra Mail.
5. Tamishra Mail performs delivery and synchronization.
6. Clients receive only mailbox data and sanitized account metadata.

## Custom IMAP/SMTP flow

The user may configure an independent mail server.

Credentials are submitted only to the authenticated Workspace gateway over TLS. The gateway validates the server connection and stores an encrypted secret reference. Raw passwords must never be returned to any client.

## Attachment safety

Attachments require:

- declared and detected MIME type
- file-size limits
- filename normalization
- malware scanning hook
- signed/expiring download URLs
- content-disposition controls
- HTML/SVG sanitization where previewed

## Deployment

Tamishra Workspace is deployed under `tamishra.in/workspace`.

Workspace APIs are served under the Tamishra domain through the Workspace-owned backend boundary. The product must not depend on Google or Microsoft services for its core runtime.
