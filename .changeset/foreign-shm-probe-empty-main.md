---
"@adhd/sox-store-adapter": patch
---

fix(store-adapter): the BUG-026 foreign-`-shm` probe no longer opens a main db file that is missing or under one page. SQLite's pager deletes the `-wal` beside a zero-page main file on a read-write open (and better-sqlite3 creates a missing main file first), so the probe could destroy a store whose data lived only in its WAL. It now returns `indeterminate` without spawning and emits `store_adapter.foreign_shm.probe_declined_small_main`.
