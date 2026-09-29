---
'@adhd/sox-memory-core': patch
'@adhd/sox-extension-memory-server': patch
---

Fix a torn-backup-published and a VACUUM-on-shutdown defect in the store backup
path (BL-ff7d9e24).

`backupStore` now stages the backup under a temp name, runs
`verifyStagedBackupIsNotTorn` against the staged file, and only then publishes
it (atomic rename) to its final rotated name — a backup that fails verification
is never published under a name a restore path would pick up. Shutdown no
longer runs `VACUUM INTO` as part of its backup: VACUUM INTO on a live,
possibly-still-writing store could itself produce a torn/inconsistent copy,
and the shutdown path's job is a safe snapshot, not compaction.

Tests (red→green, each naming BL-ff7d9e24):
`libs/memory-core/src/bl-ff7d9e24-torn-backup-not-published.spec.ts`,
`extensions/bundles/sox-memory-bundle/members/memory-server/src/bl-ff7d9e24-no-vacuum-on-shutdown.spec.ts`.
