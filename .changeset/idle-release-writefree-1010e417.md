---
'@adhd/sox-store-adapter': minor
---

A reopen after an idle release no longer writes to the store, and a close with
nothing in the WAL no longer truncates it (BL-1010e417, 595e7daf, 5eacd776,
44896cff).

- `stampAdapterMeta` reads first. When `adapter_type` and `adapter_version`
  already match and `created_at` exists, it returns without a transaction.
  Otherwise it takes `BEGIN IMMEDIATE`, re-reads, and upserts only the values
  that differ. The Turso open also skips `CREATE TABLE IF NOT EXISTS
  _adapter_meta` when the stamp is current.
- `_openReal` has a typed internal open reason: `'initial'`, `'poison'` or
  `'release'`. It is not an option or an env var.
  - A `'release'` reopen reuses the instance's `recursiveCte` probe.
  - A `'release'` reopen skips the `fast` integrity pass and its
    `_adapter_meta.last_integrity` upsert, which was the only WAL frame such a
    reopen wrote. An owed deep verification is still picked up and scheduled.
  - A `'release'` reopen keeps the lease, the foreign-shm and sidecar
    preflight, the BUG-026 WAL baseline and the orphaned-FTS guard.
  - `'initial'` and `'poison'` opens run the full ceremony.
  - `lastOpenTiming` reports the wall time of each phase.
- Close reads the frame count from its PASSIVE checkpoint. With zero frames it
  skips the TRUNCATE and the `-tshm` rename. When the count is unavailable, it
  skips them only if the `-wal` was 0 bytes at close start and is still 0.
  With frames present the path is unchanged.
- `.stale-*` sidecar names are collision-free:
  `YYYY-MM-DD-HHMM-SSmmm-p<pid>[-n]` (`staleSidecarPath`). Before this, every
  rename inside one minute overwrote the previous one. Retention matches and
  ranks both the new and the legacy minute-only names.
- Measured on a 115 MB copy of a store snapshot: a release reopen takes
  2.6–10.4 ms, against 506–542 ms for a full open.
- Renames per idle-release cycle are unchanged at one. The `-tshm` that a
  zero-frame close keeps is moved aside by the next open's BL-373 preflight
  instead of at close.
