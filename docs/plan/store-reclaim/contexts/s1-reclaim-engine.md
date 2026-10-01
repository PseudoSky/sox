# s1-reclaim-engine — NEW domain-free reclaim engine (store-adapter)

**Phase:** foundation · **Deps:** none · **Tier:** hard · **Est:** ~250 R / ~900 W
**Gate:** ⛔ blocked on **Q2** (Turso version) — resolve before dispatch.

## Goal

Create `libs/data/store/store-adapter/src/store-reclaim.ts`: the policy evaluator, the crash-safe
single-flight lock, the throttle, and the call into the existing `rebuildStoreOffline`. No schema knowledge —
the live-node count is injected by the domain composer.

## File ownership

- **creates:** `libs/data/store/store-adapter/src/store-reclaim.ts`
- **mutates:** `libs/data/store/store-adapter/src/index.ts` (export the new symbols)
- **creates:** `libs/data/store/store-adapter/src/store-reclaim.bl-<newid>.spec.ts`
- **read_only:** `store-rebuild.ts`, `store-lease.ts`, `errors.ts`, `types.ts`

## Contract (from DESIGN §3.1)

Add exactly: `StoreReclaimPolicy`, `StoreReclaimFacts`, `ReclaimSkipReason`, `StoreReclaimStatus`,
`StoreReclaimReport`, `StoreReclaimOptions`, `evaluateReclaim(facts, policy, now)`,
`reclaimStoreIfNeeded(dbPath, opts)`, `STORE_RECLAIM_LOCK_SUFFIX = '.reclaim-lock'`,
`acquireReclaimLock(dbPath, maxWaitMs)`. Signatures are in `DESIGN.md §3.1` — do not drift.

## Invariants to honor

`[inv:singleton]` (`[ref:deep-verify-lock]` + `[ref:ensure-backend-lock]`), `[inv:adapter-only]`,
`[inv:swap-into-place]`.

## Acceptance criteria (guard)

1. `npx nx test store-adapter` green in an isolated worktree (quote `check-suite-tree-state`).
2. `evaluateReclaim`: fires on each leg; `below_threshold`/`throttled`/`no_live_nodes` returns `skip`.
3. `reclaimStoreIfNeeded` on a leaked fixture: `status:'reclaimed'`,
   `after.file_bytes < before.file_bytes`, `bytes_reclaimed > 0`.
4. Lock: two concurrent callers ⇒ exactly one proceeds, the other `refused/lock_held`; a dead-pid lock is
   stolen; a live peer ⇒ `refused/not_quiescent` **with `pids`, no data loss**.
5. Registry: `git diff --exit-code registry/index.json` clean.

## Commit points

- After the spec file passes locally: commit source (`store-reclaim.ts`, `index.ts`, spec) by **explicit
  pathspec**.

## Notes for the executor

- The lock JSON is `{pid, startedAt}`. Steal only on `ESRCH` from `process.kill(pid,0)`.
- `reclaimStoreIfNeeded` must **not** build or swap directly — it delegates to `rebuildStoreOffline` (S1
  keeps the existing one-shot path; the two-phase split is S3/S4). If the two-phase split lands first,
  `StoreReclaimOptions` gains a `mode: 'build' | 'swap'` discriminator — coordinate with S3/S4 authors.
- Test file name must contain the new engine id (BL-225): file it via `backlog-operator` first, then name the
  spec after it.

## Audit

`audit-mid` verifies: no raw `sqlite3`/driver string appears; the lock file is removed on throw; the swap is
the only mutator of the canonical path.
