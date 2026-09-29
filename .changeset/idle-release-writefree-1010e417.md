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
  - The skip applies only when the retained verdict is clean: `verify.ok`,
    no damaged finding, no unknown finding, and no failed repair. An aborted
    pass (the BL-352 `ok:false` shape), a damaged or unvalidated verdict, or a
    failed repair makes the next release reopen run the full pass, so repair
    is retried on the next reopen instead of waiting for a poison event or a
    restart. A store whose fast verdict carries a standing `unknown` finding
    (for example an FTS table with no row longer than 24 characters, a probe
    skipped through `SOX_STORE_VERIFY_SKIP`, or a non-FTS custom index method)
    runs that full pass and its upsert on every release reopen, so it is not
    write-free.
  - A release reopens as `'release'` only when its own close was clean: the
    `wal_identity` check found no damage and every PASSIVE checkpoint it ran
    succeeded. Otherwise the reopen is `'initial'`. A non-writable close runs
    neither check and counts as clean.
  - Release reopens no longer run the periodic `fast` verification.
    `_adapter_meta.last_integrity`, which `memory_ping` reads, now reflects
    the last full open, so its age grows over the process lifetime. This
    trades against ADR-0013
    (`docs/decisions/0013-feature-switches-are-typed-config-not-env-vars.md`),
    which says verification "always runs ≥ fast"; here it runs at every full
    open, not at every release reopen. No periodic re-verify cadence is added.
  - Under `SOX_STORE_VERIFY=deep`, a release reopen no longer requests a deep
    pass itself. It still schedules a deep pass that another opener recorded
    as owed.
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
- Renames per idle-release cycle are unchanged at one, moved from close to
  open: the `-tshm` that a zero-frame close keeps is moved aside by the next
  open's BL-373 preflight.
