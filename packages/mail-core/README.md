# @tamishra/mail-core

Provider-neutral domain contracts for Tamishra Mail.

## Boundary

The UI should talk to this abstraction instead of importing Gmail-, IMAP-, SMTP- or vendor-specific objects.

Adapters can implement:

- account connection and capabilities
- folder discovery
- paginated message listing
- full message retrieval
- drafts
- send
- read/star state
- folder movement and deletion
- incremental sync

Provider credentials and tokens must remain server-side or in a secure native credential store. They must never be persisted in browser local storage.
