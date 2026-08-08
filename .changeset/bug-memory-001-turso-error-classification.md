---
"@adhd/sox-store-adapter": patch
---

Widen `isBusyError`, `isConcurrentConflict`, `isUniqueConstraintError`, `isForeignKeyError`, and
`isDatabaseError` to also match Turso `GenericFailure` errors by message marker
(BUG-MEMORY-001 / subsumed BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001).

Previously all five helpers were keyed exclusively on an `SQLITE_*`-prefixed `err.code` — a shape
real for `SqliteAdapterImpl`'s better-sqlite3 driver but never produced by the live
`@tursodatabase/database@0.7.1` driver, which emits `code: 'GenericFailure'` on every error it
raises. On the live (Turso) backend these helpers were unreachable dead code: a genuine lock/busy
condition, UNIQUE violation, or FOREIGN KEY violation was never classified as such, and
`memory-core`'s `wrapDbError` (which is meant to build on these helpers) fell through to a generic,
permanent `E_IO` for a condition that was actually transient and retryable.

Each helper now additionally matches the driver's own message text, following the same technique
already established by `isFatalConnectionError` (match message markers, never `err.code`):

- `isBusyError` / `isConcurrentConflict` — `/database (is|table is) locked/i` or `/database is
  busy/i`
- `isUniqueConstraintError` — `/Runtime error:\s*UNIQUE constraint failed/i`
- `isForeignKeyError` — `/Runtime error:\s*FOREIGN KEY constraint failed/i`
- `isDatabaseError` — `code === 'GenericFailure'` AND the driver's own phase-prefix convention
  (`/^(prepare|step|reset) failed:/i`)

No function changed signature; no previously-`true` result becomes `false` — this is a strict
widening (more `true`, never fewer) over the existing SQLite `code`-based branch, which is
unchanged. Existing SQLite-mode callers see byte-identical behavior.
