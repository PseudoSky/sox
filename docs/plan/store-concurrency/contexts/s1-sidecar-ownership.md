# Work order S1 — sidecar-ownership reconciliation

**State:** `s1-sidecar-ownership` · **Deps:** none · **Blocks:** `s2-coldopen-flake`

## Goal

Make every store-adapter call site that mints or removes a sidecar conform to the
invariant in `DESIGN.md` §2 — one full-set snapshot discipline, no booleans, no
bare `unlink` under non-quiescence.

## Done-state (observable)

All of S1-AC1..AC5 (DESIGN §6) pass red→green under
`npx nx test store-adapter` (run under the tree-state check: `node
tools/check-suite-tree-state.mjs --project store-adapter`).

## Scope

- **Reconcile call sites** — `store-reclaim.ts` `verifyStagedBackupIsNotTorn`
  (:549, missing cleanup) and `cleanupFactsProbeTshm` (:610, boolean-driven,
  over-aggressive); `store-rebuild.ts` restore path (rename-target exclusion,
  0086e8cd); `foreign-shm-lock.ts:259` + `preflight.ts:467`
  `removeForeignShmIfUnlocked` (rename-aside, 042a98fa).
- **Extract the primitive** — `snapshotSidecarArtifacts` +
  `removeCreatedArtifacts(path, before, event, {quiescent})` into a shared module.
- **Do NOT touch** the lock machinery, `evaluateReclaim`, the
  `rebuildStoreOffline` delegation contract, or the report mapping.

## Blocker to clear at intake

`store-reclaim.ts` is **unmerged** (worktree `feat/s1-reclaim-engine`, `ce979c8e`).
Confirm branch state; execute within the worktree or after it lands.

## Read first

`DESIGN.md` §2/§3/§5; `store-rebuild.ts:421-496` and `:1230-1262`;
`store-reclaim.ts:30-49, :549-627, :652-744`; `sidecar-retention.ts:142`.

## Guard

S1-AC1..AC5. Each is a red→green named test. A test that skips the non-quiescent
case does not count (BL-225).
