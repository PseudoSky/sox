# Work order S2 — cold-open / WAL-init flake determinism

**State:** `s2-coldopen-flake` · **Deps:** `s1-sidecar-ownership` · **Blocks:** none

## Goal

Replace the base-rate triggers of `turso-cold-open-serialize.6fd60658` and
`wal-contentdead-reconcile.debt003-bug014` with **deterministic** reproductions,
and fix the `tshm-init-race.spec.ts` classifier — without weakening any assertion
(BL-225). Make the suites attributable (BL-456).

## Mechanism (established — see DESIGN §3)

- **Real, uncatchable:** many simultaneous cold opens of a never-opened store →
  Rust abort `shared_wal_coordination.rs:1644`. Fix: `acquireColdOpenLock`.
- **Real, catchable:** `-tshm` init race (`shared WAL coordination … magic
  mismatch` / `… smaller than the header`). Fix: `isTshmCoordinationInitRace` +
  bounded retry.
- **Harness artefact:** the 1/300 signal death and the 180 s timeout under
  full-suite load (0387f89b, 56ffdbcb) — resource contention, not the invariant.

## Done-state (observable)

S2-AC1..AC4 (DESIGN §6): each suite's gate arm flips red→green deterministically;
classifier exact; both suites green under full-suite load.

## Scope

- Add the test-only `-tshm` create-then-write seam (mirror `store-rebuild.ts:665`);
  no-op in production.
- Rewrite `6fd60658`'s gate arm to assert the **mutual-exclusion property** of the
  open window (overlap absent with the lock, present without it) — the abort is
  uncatchable so the repro asserts the serialization that prevents it.
- Make `debt003-bug014` fire the content-dead reconcile deterministically (unit
  gate over a fabricated 0-byte WAL + stale index; integration asserts peer
  survival).
- Fix the `tshm-init-race.spec.ts` classifier bucket. **Reject** the "bounded
  signal-death count" proposal — it is a skipped case.

## Guard

S2-AC1..AC4. Quote `node tools/check-suite-tree-state.mjs --project store-adapter`
with the full-suite result.
