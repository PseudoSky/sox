---
'@adhd/sox-store-adapter': patch
---

Serialize concurrent cold opens of the same Turso store across processes.
`@tursodatabase/database` 0.7.x aborts in Rust
(`shared_wal_coordination.rs:1644`) when many processes open one store at the
same instant, and the adapter's open retry cannot catch an abort. The real
open now holds an advisory lock (`<db>.sox-lease.d/.coldopen.lock`, new
`acquireColdOpenLock`) around the driver open and the open-time
WAL-coordination init. The lock is released before the adapter is returned, so
no caller query ever runs under it. It is stale-safe: a dead or aged-out holder
is swept, and a live holder is waited on for at most 15 s before the open
proceeds unlocked. Measured with 24 simultaneous cold opens per path: 7
panics in 1536 processes without the lock, 0 in 1536 with it. 0.7.2 does not
change the coordination code, so the lockfile stays on 0.7.1. (6fd60658)
