# s3-live-builder — two-phase trigger, Phase A (memory-server)

**Phase:** trigger · **Deps:** s1, s2 · **Tier:** hard · **Est:** ~280 R / ~750 W
**⚠️ SERIALIZE with s4, s4_5, s5** (overlapping memory-server files).

## Goal

Add the **live builder**: when `reclaim_owed` is set, spawn a **detached child** that runs the stage (build
the compacted copy via `backupTo` against the **live** store) and writes the **build-record** sidecar. No
exclusivity gate is taken. This is Phase A of DESIGN §6.3.

## File ownership

- **creates:** `extensions/bundles/sox-memory-bundle/members/memory-server/src/store-reclaim-builder.ts`
- **mutates:** `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts` —
  the compaction chain (`:4532` def, `:4545` `runCompactionPass` call, `:4559` arm), the `memory_ping`
  branch (`:1765`) for the rising-edge obligation write, and the boot block (`:4827`) to read
  `reclaim_owed` before the first writable open.
- **creates:** `.../memory-server/src/store-reclaim-builder.bl-<newid>.spec.ts`
- **read_only:** `backend.ts`, `metrics-snapshot-section.ts`

## Contract

- `writeReclaimOwed(dbPath)` / `readReclaimOwed(dbPath)` / `clearReclaimOwed(dbPath)` over `_adapter_meta`
  (`[def:reclaim-owed]`).
- `spawnReclaimBuilder(dbPath): ChildProcess` — detached, `unref()`'d, writes the build record
  (`[def:build-record]`).
- The builder child runs `adapter.backupTo(<db>.rebuild-<ts>, {skipIntegrityCheck:true})` + `stampRebuildMeta`.

## Acceptance criteria

1. On a leaked fixture with `reclaim_owed='1'`, a live build produces `<db>.rebuild-<ts>` and a valid
   `.json` build record **while the store is concurrently writable**.
2. The build completes without a main-thread/watchdog kill (`5b29f533`): assert no `mainthread.watchdog_kill`
   and no `driver_stall` event during a build that exceeds the kill budget.
3. The obligation is written on the rising edge of `alarm` and **not** re-written while owed.
4. `npx nx test memory-server` green in an isolated worktree.

## Commit points

- After the builder spec passes: commit the new file + `index.ts` by **explicit pathspec**.

## Notes

- Do **not** take `openOfflineExclusive` here — that is the swapper's job (S4). Phase A is additive.
- The child must be spawned such that `mainthread-monitor`/`driver-stall-watchdog` (armed at `:4865`/`:4881`)
  do not observe it — a detached process is not in this process's watchdog scope.
