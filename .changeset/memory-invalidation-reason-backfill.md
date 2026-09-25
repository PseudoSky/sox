---
'@adhd/sox-memory-core': minor
---

Every episode invalidation now records why it happened, and a new
`memory_curate { op: 'backfill_invalidation_reason' }` gives legacy rows an
explicit reason.

- **`meta.invalidatedReason` on every invalidation (f7461993).** Every writer
  of `t_invalid` goes through the shared `invalidateEpisodeInTx` helper in
  `invalidation-meta.ts`: `memory_invalidate`, `merge_duplicates`, and
  `restore_neardup` reverse. The helper stamps `invalidatedReason`,
  `invalidatedVia` and `invalidatedAt` into `node.meta` in the same
  transaction that sets `t_invalid`.
- **`backfill_invalidation_reason` (503cdc2b).** Targets invalidated episodes
  that predate f7461993: no `SAME_AS`/`SUPERSEDES` edge in either direction and
  no `invalidated*` meta key. It writes only `node.meta`
  (`invalidatedReason = "unknown-legacy: …"`, `invalidatedVia =
  "backfill_503cdc2b"`, `invalidatedAt = t_invalid`,
  `invalidatedReasonBackfilledAt = now`) and never writes `t_invalid`. The scope
  predicate is re-checked per row inside one immediate transaction, so a second
  run touches 0 rows. `dry_run` defaults to TRUE. Apply and reverse first run the
  shared integrity gate and take a verified store backup, and abort without
  mutating if either fails. `reverse: true` removes exactly the four keys where
  `invalidatedVia == "backfill_503cdc2b"`. `memoryCurate` gains an optional
  `ctx` parameter that carries the store's `dbPath`.

**Minor, not patch.** The public type surface published since 0.10.2 narrows
in ways that PUBLISHING.md's patch-for-additive-API exception excludes:
`NearDupResult.should_invalidate: boolean` is replaced by
`status: 'near_dup' | 'candidate'`, and `SupersessionChainResult.canonical_uid`
is now optional. Code that reads either field must be updated.
