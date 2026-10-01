# STATE — store-concurrency

```yaml
schema: plan-state-machine/v1-light
plan: store-concurrency
repo: sox-ecosystem
design: docs/plan/store-concurrency/DESIGN.md
current_state: s1-sidecar-ownership
entry_blocked_on: []
last_updated: 2026-09-30
authored_by: architect
```

## Objective

Reconcile every store-adapter call site that mints or removes WAL-index sidecars
to **one** ownership invariant (DESIGN §2), and give the two load-flaky
cold-open/reconcile suites a **deterministic** reproduction so their results are
attributable (BL-456) without weakening any assertion (BL-225).

## Segment status

| State | Segment | Status | Guard | Deps |
|-------|---------|--------|-------|------|
| `s1-sidecar-ownership` | Sidecar/`-tshm` ownership invariant + call-site reconciliation | NOT STARTED | S1-AC1..AC5 (DESIGN §6) | none |
| `s2-coldopen-flake` | Cold-open / WAL-init flake: mechanism + deterministic repro | NOT STARTED | S2-AC1..AC4 (DESIGN §6) | **s1-sidecar-ownership** |
| `audit-mid` | Audit after S1 (invariant conformance across all call sites) | NOT STARTED | DESIGN §6 S1-AC1..AC5 all red→green | s1 |
| `audit-final` | Audit after S2 (attributability + no weakened assertion) | NOT STARTED | DESIGN §6 S2-AC1..AC4; run under full-suite load | s2 |

## Serialization / file-reservation constraints

**Order is S1 → S2, strictly.** The two segments touch the same
`libs/data/store/store-adapter/` package and, in part, the same files
(`cold-open-lock.ts`, `turso-adapter.ts`, `store-rebuild.ts`); S2's deterministic
suites assert the very invariant S1 defines and exercise S1's cleanup paths.
Authoring them concurrently would let S2 encode pre-S1 behaviour. Do **not**
dispatch S2 until S1's guard is green.

| Segment | Exclusive file ownership |
|---|---|
| S1 | `store-reclaim.ts` (worktree `feat/s1-reclaim-engine`), `store-rebuild.ts`, `sidecar-retention.ts`, and (for the [042a98fa](#backlog-binding) call site) `foreign-shm-lock.ts`, `preflight.ts`; any new `sidecar-ownership.ts` helper; the `-tshm`-window code in `cold-open-lock.ts` / `turso-adapter.ts` |
| S2 | `__tests__/turso-cold-open-serialize.6fd60658.spec.ts`, `__tests__/wal-contentdead-reconcile.debt003-bug014.spec.ts`, `__tests__/tshm-init-race.spec.ts`, `__tests__/fixtures/*`; the **test-only** seam S2 adds to `cold-open-lock.ts` / `turso-adapter.ts` (a seam S1 must land first) |

## Acceptance criteria (the guard is red→green)

Full text in DESIGN §6. Summary:

- **S1-AC1** non-quiescent read-open leaves the artifact set byte-identical (full-snapshot equality).
- **S1-AC2** a peer-created `-tshm` survives a `reclaimStoreIfNeeded` facts-read; only this read's own artifact is removed.
- **S1-AC3** `verifyStagedBackupIsNotTorn` leaves zero artifacts it created (the missing cleanup).
- **S1-AC4** restore path does not delete a `.stale-*` produced by renaming a pre-existing `-tshm` ([0086e8cd](#backlog-binding)).
- **S1-AC5** `removeForeignShmIfUnlocked` never unlinks a sidecar; a content-proven-dead one is rename-aside ([042a98fa](#backlog-binding)).
- **S2-AC1** `6fd60658` fails deterministically RED with `acquireColdOpenLock` removed from `_openReal`, GREEN with it.
- **S2-AC2** `debt003-bug014` fails deterministically RED without the content-dead probe, GREEN with it.
- **S2-AC3** the tshm-init-race classifier buckets a signal death exactly ([0387f89b](#backlog-binding)); no bounded-count allowance.
- **S2-AC4** no assertion weakened; no skipped failing case; both suites green under the full-suite load that currently flakes them.

## Blockers

- **B1 — `store-reclaim.ts` is unmerged.** It exists **only** in the worktree
  `.worktrees/s1-reclaim-engine` (branch `feat/s1-reclaim-engine`, commit
  `ce979c8e`), not on `main`. S1 cannot merge to `main` until that branch lands,
  or S1 must be executed *within* the worktree. Confirm branch state at S1 intake.
- **B2 — the substrate fix for the tshm-init race may already be shipped.**
  `isTshmCoordinationInitRace` (errors.ts) and `acquireColdOpenLock`
  (cold-open-lock.ts) exist in the tree; S2's RED control requires removing them
  temporarily (the legal negative-control pattern the suites already document).
  No env toggle may be used to enable/disable it ([ADR-0013](../../decisions/0013-feature-switches-are-typed-config-not-env-vars.md)).
- **B3 — backlog tool is cross-repo.** `/Users/nix/dev/node/adhd/entrypoint/backlog/`,
  package `@adhd/backlog` v1.0.6, not in `sox-ecosystem`. Backlog writes go through
  `backlog-operator`.
- **B4 — substrate memory-write defect (UNFILED).** During the 2026-09-30 research
  pass, `memory_write` failed non-retryably with `E_IO`
  `[BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001]` — the store refuses to
  proceed when the mandated `-tshm` coordinator did not appear after open
  (`retryable:false`); `memory_ping` had already reported `enrichment: stalled`.
  Same substrate as this plan. Must be filed via `backlog-operator`; it blocks
  memory-write work until filed and triaged.

## Open questions

- **Q1 — deterministic-repro form for `6fd60658`.** The panic is uncatchable
  (native abort), so the deterministic test must assert the **mutual-exclusion
  property** of the open window (via a test seam at the `-tshm` create-then-write
  instant), not observe the abort. Confirm the seam belongs in `cold-open-lock.ts`
  or `turso-adapter._openReal`. (DESIGN §5.1; needs implementer decision at S2.)
- **Q2 — `-shm` scope.** [042a98fa](#backlog-binding) is about `-shm`; the
  invariant in DESIGN §2 is written for all sidecars. Confirm S1's edit to
  `foreign-shm-lock.ts`/`preflight.ts` stays behaviour-preserving apart from
  unlink→rename-aside.
- **Q3 — `sidecar-ownership.ts` vs extending `sidecar-retention.ts`.** DESIGN §3
  proposes a small shared module; confirm at S1 intake whether the snapshot/
  difference primitives move out of `store-rebuild.ts` or are imported from it.

## ADR proposal

Next sequential ADR = **0026** — *Sidecar ownership and the read-open
side-effect contract*. **PROPOSED; do not write without owner approval.**
Draft body lives in DESIGN §2; it records: a read-open may create (never
destroy) sidecars; ownership is by creating process while it holds a live
connection; cleanup is difference-of-full-snapshot, rename-aside-never-unlink
under non-quiescence; and the `.stale-*` rename-target exclusion.

## Anchor gaps (unverified)

- **AG1.** The direction cited `store-reclaim.ts :481` ("never cleans up") and
  `:542` ("too aggressive"). Those line numbers do **not** match the worktree file
  as read. The actual sites are `verifyStagedBackupIsNotTorn` (:549) and
  `cleanupFactsProbeTshm` (:610). The direction's numbers are recorded as
  `(UNVERIFIED — line numbers stale)`.
- **AG2.** [0086e8cd](#backlog-binding) cites `store-rebuild.ts line 822 / 896 /
  908` (a commit-pinned shape). The file as read has `listFileArtifacts` at :450,
  `removeCreatedArtifacts` at :471, the backup snapshot at :1241 and its cleanup
  at :1261. The defect is real; the cited line numbers are `(UNVERIFIED)` against
  current `main`.
- **AG3.** Backlog uid `d513326d` (memory.db `-tshm` prune gap) and `97deb271`
  (canonical of `06922862`) were surfaced as relations but their bodies were not
  read in this pass — `(UNVERIFIED)`.

## Transition log

```jsonc
[
  { "ts": "2026-09-30", "state": "s1-sidecar-ownership", "event": "authored",
    "note": "Plan authored from direction: two serialized segments; invariant + call-site reconciliation (S1), flake mechanism + deterministic repro (S2).", "by": "architect" },
  { "ts": "2026-09-30", "state": "s1-sidecar-ownership", "event": "research_folded",
    "note": "Researcher pass complete: prior-art (§2) sharpens the invariant (sidecar is engine-owned; only the last-closer may delete; read-open does not block cross-process TRUNCATE — turso#7833) and supplies the deterministic-repro recipe (§3.4). Researcher's memory writes were blocked by BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001 (unfiled; B4).", "by": "architect" }
]
```
