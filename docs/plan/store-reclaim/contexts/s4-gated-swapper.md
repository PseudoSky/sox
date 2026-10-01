# s4-gated-swapper — two-phase trigger, Phase B (memory-server)

**Phase:** trigger · **Deps:** s3 · **Tier:** hard · **Est:** ~150 R / ~350 W
**⚠️ SERIALIZE with s3, s4_5, s5.**

## Goal

At a controlled stop, take the cold-open gate, re-check all swap gates + identity, and swap the
live-built copy into place. This is Phase B of DESIGN §6.3 / §5.3.

## File ownership

- **mutates:** `.../memory-server/src/index.ts` (boot block `:4827` — the swapper path when a build record
  exists; shutdown path for the idle-gated restart), and the builder module file (add the swap entry point).
- **creates:** `.../memory-server/src/store-reclaim-swapper.bl-<newid>.spec.ts`
- **read_only:** `libs/data/store/store-adapter/src/store-rebuild.ts` (`swapIntoPlace` reused unchanged —
  `[ref:swap-into-place]`)

## Contract

`runGatedSwap(dbPath, buildRecordPath): Promise<StoreReclaimReport>` — loads the build record, calls
`swapIntoPlace(canonical, replacement, backupPath, event, expectedSource)`, and on success:
`clearReclaimOwed(dbPath)` + `stampRebuildMeta` (already done in the copy) + invoke the expiry hook (S6).

## Acceptance criteria

1. **e92196e2**: a write between build (T0) and swap ⇒ `swapIntoPlace` returns `refused/source_changed`; the
   write **survives**; the obligation stays set. (This test names `e92196e2`.)
2. A peer connection ⇒ `refused/not_quiescent` with `pids`; `-wal != 0` ⇒ `refused`.
3. On a quiesced store with an unchanged identity: swap succeeds, `reclaim_owed` cleared, the canonical is
   the compacted file, the pre-swap file is the hard-linked `backup_path`.
4. `npx nx test memory-server` green in an isolated worktree.

## Commit points

- After the swapper spec passes: commit `index.ts` + the module by **explicit pathspec**.

## Notes

- **No new swap logic** — reuse `swapIntoPlace`. S4 only orchestrates gate + identity + obligation clearing.
- The "controlled stop" for memory without the S4.5 barrier is the idle-gated restart (request restart only
  when write queues are idle). If S4.5 lands, the swap instead runs in-process under the barrier.
- A `source_changed` refusal is **normal** under a busy store — do not treat it as a failure; leave the
  obligation and let the next quiesced window retry.
