# sox-ingest

Declarative skill for ingesting external sources into sox-ecosystem as born-conformant extensions.

## Overview

`sox-ingest` encodes the full ingestion flow: initialize → generalize+author → validate → publish → install → enable → remove-old. An agent told "ingest `<source>` into sox" loads this skill and runs the complete flow with no bespoke prompts; per-type and per-operation specifics are delegated to `references/`.

## When to use

Use this skill when you need to port an external repo, file, or directory into sox-ecosystem as one or more born-conformant extensions.

## Inputs

| Field | Type | Description |
|-------|------|-------------|
| `source` | string | File path, directory path, or repository URL of the external source to ingest |

## Outputs

| Field | Type | Description |
|-------|------|-------------|
| `status` | string | Result of the ingestion flow: `"success"` or error message |

## References

See `references/` for per-type and per-operation prompts used during ingestion.
