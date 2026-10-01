# audit-mid — hold point after s1–s4_5

**Kind:** audit (mandatory hold point) · **Runs after:** s1, s2, s3, s4, s4_5.
**Read-only.** Fixes happen in source, never by weakening this check.

## Checks

1. **No raw driver/sqlite path.** No `sqlite3` CLI and no bare `new Database(`/`sqlite-vec` load in the new
   reclaim path; all `VACUUM`/checkpoint via `backupTo`/`rebuildStoreOffline`. (`[inv:adapter-only]`)
2. **Lock integrity.** `<db>.reclaim-lock` is removed on every exit path including throw; a dead-pid lock is
   stolen; two concurrent attempts ⇒ one winner. (`[inv:singleton]`)
3. **No write lost.** The only mutator of the canonical path is `swapIntoPlace`; the identity guard
   (`readFileIdentity`) is present and load-bearing; a simulated write between build and swap ⇒ refusal and
   the write survives. (`[inv:no-write-lost]`, `e92196e2`)
4. **No force.** No code path signals a holder; every non-quiescent outcome is `refused` with pids.
   (`[inv:no-force]`)
5. **Reload sentinels reset.** `FTS_OPTIMIZE_PASSES_SINCE_REBUILD=0` + `LAST_REBUILD_AT` stamped in the copy.
6. **Gates table matches reality.** `storeQuiescence`/`storeOpeners`/`-wal == 0` are evaluated at **swap**
   only, never fenced around the build.
7. **Tree state quoted.** Every suite result in the segment logs is accompanied by
   `node tools/check-suite-tree-state.mjs --project <p>` output (BL-456).

## Exit

Prints failures with file:line; exits with the failure count. Non-zero blocks advancing to s5+.
