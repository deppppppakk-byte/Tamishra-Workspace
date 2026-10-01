# Tamishra Document Native Format (.tmdoc)

Tamishra Docs uses **`.tmdoc`** as its native document file extension.

## Identity

- Extension: `.tmdoc`
- Product: Tamishra Docs
- MIME type: `application/vnd.tamishra.document`
- Current format version: `1`
- Magic signature: `TMDOC\n`

A `.tmdoc` file is the lossless Tamishra-native representation of a document.
DOCX, HTML, TXT and PDF remain interoperability/output formats.

## Goals

The format is designed to preserve Tamishra features that external office formats may
not represent exactly:

- structured Tamishra document model
- page and section settings
- headers and footers
- comments and replies
- review suggestions
- version snapshots
- sharing grants
- native block IDs
- Tamishra pagination metadata
- future extension-specific data

## Version 1 container

Version 1 is UTF-8 encoded and begins with the exact bytes:

```text
TMDOC\n
```

The remaining bytes contain a JSON envelope:

```json
{
  "checksum": "8-hex-digit FNV-1a checksum",
  "payload": {
    "manifest": {},
    "record": {},
    "comments": [],
    "suggestions": [],
    "versions": [],
    "grants": []
  }
}
```

The checksum is calculated over a deterministic, key-sorted JSON representation of
the `payload`. It is an integrity check for accidental corruption, not a
cryptographic signature.

## Manifest

Every package contains:

- `format`: `"Tamishra Document"`
- `extension`: `".tmdoc"`
- `mimeType`: `"application/vnd.tamishra.document"`
- `formatVersion`: integer format version
- `producer`: `"Tamishra Docs"`
- `createdAt`: ISO timestamp
- `exportedAt`: ISO timestamp
- `documentId`: Tamishra document ID
- `title`: document title

## Compatibility rules

Readers must:

1. Reject files without the `TMDOC\n` signature.
2. Reject malformed envelopes or incomplete document payloads.
3. Verify the payload checksum.
4. Reject format versions newer than the reader supports.
5. Preserve unknown future-compatible metadata when migrations add that capability.
6. Never silently reinterpret another file type as `.tmdoc`.

## Desktop integration

Tamishra Workspace registers `.tmdoc` as an editable native document association.
On desktop launch, a file passed by the operating system is limited to 64 MB before
it is read into the Docs frontend and validated by the normal `.tmdoc` parser.

## Security

The native format is data, not executable code. Importers must continue to sanitize
or constrain any rendered HTML and embedded resources. The checksum does not prove
authorship or trust.

A future signed format version may add cryptographic signatures without changing
the `.tmdoc` extension.
