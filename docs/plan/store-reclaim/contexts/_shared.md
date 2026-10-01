# contexts/_shared.md — shared definitions for the store-reclaim plan

Reference these from segment contexts instead of restating. One change here lands everywhere.

## Glossary

- `[def:singleton-key]` — `(id, resolved-store-resource)`; resource = canonical absolute `db_path`. At most
  one live process per key (`[inv:singleton]`, service-lifecycle §5).
- `[def:reclaim-owed]` — the durable obligation key `_adapter_meta.reclaim_owed` (value `'1'`), set on the
  rising edge of the growth alarm and cleared only on a successful swap. Precedent: `DEEP_VERIFY_OWED_KEY`
  (`deep-verify.ts`).
- `[def:build-record]` — `<db>.rebuild-<ts>.json`, written by the live builder: `{ expectedSource:
  {dev,ino,size,mtime_ns}, builtAt }`. Consumed by the swapper's identity check.
- `[def:retention-set]` — one backup as a *unit*: `memory-<ISO>.db` + its `-wal`/`-shm`/`-tshm` companions +
  any `.pre-repair-*`/`.pre-restore-*` pre-image bearing the same `<ISO>` stem.

## Invariants (violating any is a plan defect)

- `[inv:singleton]` — at most one reclaim runs per store; the `<db>.reclaim-lock` enforces it (§7).
- `[inv:never-delete-live-sidecar]` — no code path unlinks a non-`.stale-*` sidecar. Expiry **renames aside**
  (`staleSidecarPath`); `sidecar-retention.ts` is the only unlinker, only of `.stale-*`.
- `[inv:no-write-lost]` — the swap never proceeds across a write. The `source_changed` identity guard
  (`readFileIdentity`) is the fence (`e92196e2`).
- `[inv:no-force]` — a non-quiescent store is `refused` with pids; never signal a holder, never `--force`.
- `[inv:adapter-only]` — all `VACUUM`/checkpoint access goes through the sanctioned adapter
  (`backupTo`/`rebuildStoreOffline`); never stock `sqlite3` (`9ae11d20`).
- `[inv:deploy-verified]` — a deploy is complete only when the RUNNING process is verified executing the new
  artifact (service-lifecycle §9.4a). `loaded:yes`/exit 0 are not evidence.
- `[inv:registry-release-only]` — never write `registry/index.json`; never `registry:sync-index` (ADR-0021).
- `[inv:commit-by-pathspec]` — `git commit <paths> -m …`; never `git add -A`, `git add .`, bare
  `git commit`, `--no-verify`, `git stash`, `git reset --hard`.
- `[inv:nx-targets]` — build/test/lint/typecheck via `npx nx …` only.
- `[inv:tree-state]` — quote `node tools/check-suite-tree-state.mjs --project <p>` with every suite result
  (BL-456); run tests in an isolated worktree under `.worktrees/`.

## Reference patterns (`[ref:]`)

- `[ref:deep-verify-lock]` — **anchor:** `libs/data/store/store-adapter/src/deep-verify.ts` (O_EXCL lock
  `DEEP_VERIFY_LOCK_NAME` + pid-liveness steal; durable owes-key). **Rule:** the reclaim lock and the
  `reclaim_owed` obligation must mirror this exactly.
- `[ref:ensure-backend-lock]` — **anchor:** `libs/service-proxy/src/ensure-backend.ts:270-308`
  (`tryAcquireLock`/`releaseLock`). **Rule:** O_EXCL create, pid-liveness, TTL stale-steal.
- `[ref:swap-into-place]` — **anchor:** `libs/data/store/store-adapter/src/store-rebuild.ts:556`
  (`swapIntoPlace`). **Rule:** reuse it unchanged; never invent a new swap.
- `[ref:stale-sidecar]` — **anchor:** `libs/data/store/store-adapter/src/sidecar-retention.ts:58`
  (`staleSidecarPath`). **Rule:** move companions aside via this; never clobber, never delete.
- `[ref:store-growth-gauge]` — **anchor:** `libs/memory-core/src/store-growth.ts`.
  **Rule:** extend this gauge; do not add a parallel one.

## Fixtures

- **leaked store** — build by interleaving inserts with `OPTIMIZE INDEX idx_fts_node` (Turso syntax), per
  `libs/memory-core/src/store-growth.bl-c5249cdd.spec.ts`'s `seedLeakedStore()`.
- **live-peer** — a second process holding a read connection, for the `not_quiescent` refusal test.
