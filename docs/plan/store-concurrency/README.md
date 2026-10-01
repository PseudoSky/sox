# store-concurrency — sidecar ownership + cold-open/init-race determinism

Plan authored by **architect**, repo `sox-ecosystem`, slug `store-concurrency`.
Shape: plan-state-machine light (`README.md` + `STATE.md` + `contexts/`), the same
shape `docs/plan/store-reclaim/` uses and which the `plan-state-machine` skill
explicitly permits ("raw-file editing stays valid").

The authoritative specification is **[`DESIGN.md`](./DESIGN.md)**. `STATE.md` is
the resumable runtime (segment status, guards, serialization, transition log).
`contexts/` holds one work order per segment plus the mid/final audit stubs.

## Why this plan exists

Two defect families sit on the same substrate — cross-process store invariants
under [ADR-0012](../../decisions/0012-turso-multiprocess-write-and-driver-agnostic-error-taxonomy.md)'s
multi-writer premise (writers serialized by `multiprocess_wal`'s `.tshm`
coordinator, *not* MVCC) — and they touch overlapping files. They are specified
together so the two segments cannot land contradictory rules:

1. **Segment 1 — the sidecar / `-tshm` ownership invariant.** A read-open mints
   sidecars and a later cleanup removes them, but ownership is decided from a
   *boolean* snapshot taken before the read, guarded only on a WAL-size check. A
   peer that opens the store during that window has its `-tshm` deleted from
   under it. `store-reclaim.ts` does this in two places; `store-rebuild.ts` has a
   *full-snapshot* discipline that is safer but still has one rename-shaped hole
   ([0086e8cd](#backlog-binding)). The invariant is stated once (DESIGN §2) and
   **every** call site is reconciled to it.
2. **Segment 2 — the cold-open / WAL-init flake family.**
   `turso-cold-open-serialize.6fd60658` and
   `wal-contentdead-reconcile.debt003-bug014` fail under load and concurrent
   worktrees, pass in isolation, so a suite result cannot be attributed while the
   flake holds (BL-456). The mechanism is established from the suites, not
   assumed (DESIGN §4), and each suite is given a *deterministic* reproduction
   that fails for the right reason — never a weakened assertion, never an
   "allowed failure count" (BL-225).

## Non-negotiables carried from the direction

- **Read-only on source.** This plan delivers specifications and work orders; it
  writes no source. The two segments are executed later by implementer agents.
- **No weakened assertion, ever.** A test that skips the failing case does not
  count (BL-225). "Allow a bounded signal-death count" (the proposal in
  [0387f89b](#backlog-binding)) is explicitly **rejected**.
- **Two segments, strictly serialized** — they touch overlapping files. Order
  **S1 → S2**, stated in `STATE.md` and DESIGN §1.
- **Never an empty catch** — every error path traces through `@adhd/sox-telemetry`.
- **No `registry/index.json` edit, no `registry:sync-index`, no hand-edited `BACKLOG.md`.**
