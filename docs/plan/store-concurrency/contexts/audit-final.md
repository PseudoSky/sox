# Audit — final (after S2)

Independent audit of the whole plan, once S2's guard is green.

## Entry condition

`s2-coldopen-flake` guard green; S2-AC1..AC4 each has a red→green test.

## Checks

1. **Attributability (BL-456).** Run the full `store-adapter` suite under
   concurrent-writer load and quote `node tools/check-suite-tree-state.mjs
   --project store-adapter` with the result. A clean tree + zero failures = the
   suite is attributable.
2. **No weakened assertion / no allowed failure count.** The `tshm-init-race`
   failure assertion is `toBe(0)` with no parameter; no "bounded signal-death
   count" allowance exists anywhere (`rg "allow.*count|maxFail|tolerat"` in the
   suites).
3. **Determinism, not luck.** Run each gate arm N times; the flip is stable. The
   RED control (lock removed / probe removed) reproduces every run.
4. **No weakened timing.** Any changed bound is re-derived from an explicit
   budget stated in the test, not raised until green.
5. **S1 invariant still holds** after S2's test-only seam (no production
   behaviour change from the seam; it defaults to a no-op).

## Exit

Pass → plan complete. Fail → record the failing check; do not mark the plan done.
