---
'@adhd/sox-memory-core': patch
'@adhd/sox-extension-memory-server': patch
---

A store inside the backup directory is never enlisted into memory-server's
background maintenance. Any tool call resolving a `db_path` (including
`memory_ping`'s store block) used to add it to the set the enrich, drain and
compaction loops iterate for the life of the process, so one
`memory_ping db_path=<backup>` kept a backfill backup open, idle-flushed and
BUG-026-reconciled indefinitely — and eligible for heal writes. Such a store is
now refused (`store.background_enlist_refused`) and closed + evicted when the
call that touched it finishes (`store.transient_backup_released`). New
memory-core exports: `isBackupStorePath`, `closeCachedAdapter`,
`WriteQueue.closeForPath`. (98fe54a3)
