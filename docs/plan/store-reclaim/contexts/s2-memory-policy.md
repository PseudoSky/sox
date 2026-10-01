# s2-memory-policy — memory policy binding (memory-core)

**Phase:** foundation · **Deps:** s1 · **Tier:** medium · **Est:** ~150 R / ~400 W

## Goal

Bind the domain-free engine to the memory store: a policy builder from `StoreGrowthConfig`, a live-node
counter, and a thin `reclaimMemoryStoreIfNeeded` wrapper.

## File ownership

- **creates:** `libs/memory-core/src/store-reclaim.ts`
- **mutates:** `libs/memory-core/src/index.ts` (re-export), `libs/memory-core/src/config.ts` (new typed
  fields — DESIGN §3.4)
- **creates:** `libs/memory-core/src/store-reclaim.bl-<newid>.spec.ts` (or extend
  `store-growth.bl-c5249cdd.spec.ts`)
- **read_only:** `store-growth.ts`, `backup.ts`, `compaction.ts`

## Contract (DESIGN §3.2)

`memoryReclaimPolicy(cfg, overrides?)`, `countMemoryLiveNodes(adapter)`,
`reclaimMemoryStoreIfNeeded(dbPath, opts?)`. `countMemoryLiveNodes` must use the **same** query as
`readStoreGrowthGauge` (`store-growth.ts:81`): `SELECT COUNT(*) FROM node WHERE t_invalid IS NULL`.

## Acceptance criteria

1. `countMemoryLiveNodes` equals a direct `SELECT COUNT(*) FROM node WHERE t_invalid IS NULL` on a seeded
   store (invalidated rows excluded).
2. `memoryReclaimPolicy` maps `bytesPerLiveNodeAlarm`/`optimizePassesSinceRebuildAlarm`/`minLiveNodes` and
   `reclaimMinIntervalMs` with the documented defaults.
3. Config D3: a malformed `SOX_STORE_GROWTH_RECLAIM_MIN_INTERVAL_MS` is reported in `config_errors`, never
   thrown; overrides beat env.
4. `npx nx typecheck memory-core` + `npx nx test memory-core` green in an isolated worktree.

## Commit points

- After the spec passes: commit `store-reclaim.ts`, `index.ts`, `config.ts`, spec by **explicit pathspec**.

## Notes

- `config.ts`'s `StoreGrowthConfig` is at `:198-223`; add fields there, mirror `resolveStoreGrowthConfig`'s
  never-throw D3 pattern.
