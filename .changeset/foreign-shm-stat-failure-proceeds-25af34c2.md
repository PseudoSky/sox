---
'@adhd/sox-store-adapter': patch
'@adhd/sox-extension-memory-server': patch
---

A non-ENOENT failure statting a turso store's `-shm` sidecar (e.g. EACCES) no
longer escalates into `EForeignSqliteSidecar` through the open path's bounded
retry loop. `reconcileForeignSqliteShm` now tags every decline with a
`declineKind` (`stat_unprovable` | `locked` | `in_use` | `rename_failed`) and the
open path routes through the new `foreignShmOpenAction()`: a `stat_unprovable`
decline proceeds with the open (traced as
`store_adapter.foreign_shm.open_proceeds_stat_unprovable`), while a proven live
classic holder still refuses exactly as before. (25af34c2)
