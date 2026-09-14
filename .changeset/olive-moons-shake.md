---
'@adhd/sox-store-adapter': patch
---

Retry the transient foreign `-shm` refusal instead of failing the open (BUG-031).

A classic `-shm` beside a turso store is written only by a better-sqlite3 opener, and the
guard inferred from that it must be foreign residue — refusing the open outright whenever a
live peer held the store.

The inference is false. This package's own sanctioned hatches are such openers:
`preflightSchemaSanity`'s readonly `openSchemaReader` runs on the open path itself, and
`deleteSchemaRowsViaBetterSqlite3` runs during FTS5 repair. SQLite materialises a `-shm` for
the life of such a connection and removes it on last close, so the sidecar is routinely a
live, legitimate artifact that clears within milliseconds — turning a millisecond window into
a hard open failure. Reproduced in this repo's own suite at 1/300 cold-open processes by
`tshm-init-race.spec.ts`.

The refusal is now retried on the same bounded linear backoff the two other transient open
races use (ADR-0012 §4). Genuine residue never clears and still refuses after the bound; a
live hatch's sidecar clears and the open proceeds. The exhausted refusal is marked
`retryable`, like its two siblings. The reconcile/rename branch is deliberately unchanged —
it still fires only when the store is quiescent, so retrying cannot widen the window in which
a live sidecar is renamed out from under its owner.

Also corrects the "FOREIGN by construction" claim in `wal-ownership.ts`, which asserted the
same false inference.
