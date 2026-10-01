# s8-backup-expiry — backup expiry: age + companion-atomic + never-expire + observability

**Phase:** expiry · **Deps:** s1 · **Tier:** hard · **Est:** ~350 R / ~900 W
**⚠️ SERIALIZE with s6** (shares `RetentionResult`).

## Goal

Replace the count-only `pruneRotatedBackups` with the single `pruneBackupSets` policy pass (count ∧ age ∧
bytes, companion-atomic, never-expire), extend `sidecar-retention.ts`, and surface the `backup_retention`
gauge.

## File ownership

- **mutates:** `libs/memory-core/src/backup.ts` (replace `pruneRotatedBackups` `:542`; regex `:430`; header
  `:421`; tmp regex `:462`; loop `:559`), `libs/memory-core/src/config.ts` (§3.4 fields),
  `libs/memory-core/src/index.ts` (re-export),
  `libs/data/store/store-adapter/src/sidecar-retention.ts` (`:34/:45/:58` — add `wal` + byte cap),
  `.../memory-server/src/index.ts` (tick `:4545` expiry pass + ping `:1765` gauge),
  `.../memory-server/src/metrics-snapshot-section.ts`, `libs/memory-core/src/store-growth.ts` (gauge section)
- **creates:** `libs/memory-core/src/backup-retention.bl-<newid>.spec.ts`

## Contract (DESIGN §3.3/§3.5/§8)

`BackupRetentionPolicy`, `RetentionResult`, `pruneBackupSets(backupDir, policy, opts?)`; extended
`pruneStaleTshmSidecars` returning `expiredBytes`/`totalBytes`; `isStructurallyProtected(name, {newestVerified,
protectedRefs})`.

## Acceptance criteria (the BL-225 tests)

1. **`1dd4c870`**: after rotation + expiry, **no orphaned companion** remains; no `.db` unlinked before its
   companions; an orphan companion whose `.db` is gone is renamed aside and reported.
2. **Never-expire**: with `retentionCount=1`, `maxAgeMs=0`, `maxTotalBytes=0`, the newest verified backup
   **and** a live `protectedRefs` entry both survive. Pointer file `~/.memory/backups/.last-verified`
   (atomic tmp+rename).
3. **Age**: a 20-day-old backup expires under `retentionCount=24`; ranking uses the filename timestamp, not
   mtime.
4. **Crash-ordering**: crash after companion-rename / before `.db`-unlink ⇒ self-contained `.db` present; no
   `db-gone-companion-present` state.
5. **Checkpoint-before-expire**: a backup with a non-empty `-wal` is checkpointed (restore from `.db`-only is
   complete) before expiry; a checkpoint failure leaves the set intact + reported.
6. **Observability**: ping/gauge exposes `expired_count`, `oldest_backup_age_ms`, `total_backup_bytes`,
   `orphaned_companion_count`.
7. `npx nx test memory-core store-adapter memory-server` green in an isolated worktree.

## Commit points

- After specs pass: commit `backup.ts`, `config.ts`, `index.ts`, `sidecar-retention.ts`, memory-server files,
  `store-growth.ts`, spec by **explicit pathspec**.

## Notes

- `[inv:never-delete-live-sidecar]`: `pruneBackupSets` **renames aside** companions; only `sidecar-retention`
  unlinks, only `.stale-*`. Never `.db`-unlink-before-companions.
- The 342 MB orphan belongs to `1dd4c870` (DESIGN §15); name the test after it.
