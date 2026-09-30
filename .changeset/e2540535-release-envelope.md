---
'@adhd/sox-telemetry': minor
'@adhd/sox-extension-memory-cli': patch
'@adhd/sox-extension-memory-flush': patch
---

Release identity on every durable telemetry record

The shared log/span/event envelope now names the release that produced each
record, so a production error or span can be attributed to a build.

- `emitRecord` (the single envelope every `log.*` and every OTel span record
  passes through) stamps `release: { version, artifact_sha256, git_sha }`, read
  from the runtime's already-resolved release state. The contract matches the
  durable `metrics.snapshot`/`metrics.rollup` rows exactly: each field is a
  non-empty string or `null` — never `""` (BL-433). Unset ⇒ all three fields
  `null`.
- `bringUpOtel` adds `service.version` and `sox.artifact_sha256` resource
  attributes, null-safe (an unresolved field is omitted — an OTel attribute
  cannot be `null`, and `""` would be the absent-field ambiguity), so the
  release rides every span and metric point by construction.
- `memory-cli` and `memory-flush` now pass a `release` (their own declared
  semver, resolved from their sibling `package.json`), so their persisted
  snapshots and envelope records are no longer all-`null`.

Additive only: no new environment variable (ADR-0013), no second resolution
path, and an uninitialised process is unchanged.
