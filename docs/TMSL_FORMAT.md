# Tamishra Slides Native Format (.tmsl)

## Purpose

`.tmsl` is the native presentation file format for Tamishra Slides.

It is not a renamed JSON document. A TMSL file is a versioned binary container with a Tamishra-specific signature, metadata header, integrity verification and a compressed document payload.

## Identity

- Extension: `.tmsl`
- MIME type: `application/x-tamishra-slides`
- Format id: `tamishra.slides`
- Container version: `1`
- Current document schema version: `4`

## Binary layout

| Offset | Size | Meaning |
| --- | ---: | --- |
| 0 | 8 bytes | Magic signature: `54 4D 53 4C 01 00 0D 0A` |
| 8 | 4 bytes | Big-endian unsigned header length |
| 12 | variable | UTF-8 JSON container header |
| next | variable | Presentation payload |

The first four signature bytes are ASCII `TMSL`. The remaining bytes identify the first container generation.

## Header

The header includes:

- format id
- container version
- document schema version
- Tamishra Slides custom MIME type
- compression mode
- SHA-256 checksum of the uncompressed document payload
- creation timestamp
- modified timestamp
- generator name
- presentation title
- slide count
- lightweight first-slide preview metadata (background, title and subtitle when available)

## Payload

The payload contains the Tamishra Slides document model, including the presentation title, slides, objects, notes, sections, comments, guides, animations, charts, tables and embedded image data.

Current browsers use GZIP compression through the Web Compression Streams API. When that API is unavailable, the container can fall back to an uncompressed payload while preserving the same file structure.

## Integrity

Before opening a TMSL file, Tamishra Slides:

1. checks the TMSL magic signature;
2. validates the container identity and version;
3. decompresses the payload when needed;
4. recalculates SHA-256 over the uncompressed payload;
5. compares the digest against the header checksum;
6. validates that the decoded document contains a slide array.

A checksum mismatch causes the file to be rejected instead of loading potentially corrupted presentation data.

The preview metadata lives in the uncompressed header, so desktop surfaces such as Recent Files can show presentation identity and a lightweight preview without decompressing the main document payload.

## Compatibility policy

Tamishra Slides keeps legacy JSON import available for migration, but `.tmsl` is the native save/open format.

Future container revisions must change the container version only when the binary envelope itself changes. Presentation-model changes should increment the schema version independently.

## External export

TMSL is the editable Tamishra-native source format. PPTX and PDF are export/interchange formats and are not used as the internal source of truth.
