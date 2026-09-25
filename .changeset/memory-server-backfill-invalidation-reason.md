---
'@adhd/sox-extension-memory-server': patch
---

Republishes the memory-server bundle with the `@adhd/sox-memory-core` and
`@adhd/sox-store-adapter` changes it inlines. The previous published bytes
(1.3.3) date from 2026-09-05.

- `memory_curate` declares the new `backfill_invalidation_reason` op (503cdc2b)
  and passes the store's `dbPath` into `memoryCurate`. Every invalidation now
  records `meta.invalidatedReason` (f7461993).
- Also includes: the `restore_neardup` curate op; live-only counting and
  pagination for `memory_entity_episodes` and `memory_related`
  (`invalidated_count`); recall degradations propagated across the MCP boundary
  (BL-391); auto-chunks inheriting topic, tags, importance and `t_occurred`;
  failing closed when no store is configured; the Turso FTS quoted-query fix.
