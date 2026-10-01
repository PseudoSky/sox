# Audit — mid (after S1)

Independent audit of S1 against the invariant, before S2 is dispatched.

## Entry condition

`s1-sidecar-ownership` guard green; S1-AC1..AC5 each has a red→green test naming
the observable in DESIGN §6.

## Checks

1. **Invariant conformance, all call sites.** Every site in DESIGN §2's table is
   reconciled; no boolean ownership fact remains anywhere in the store-adapter
   (`rg "Preexisted"`, `rg "rmSync\\(.*-tshm"`, `rg "unlinkSync\\(.*-shm"`) — each
   remaining `unlink`/`rmSync` of a sidecar is justified in-source.
2. **No weakened assertion.** Diff the S1 test files; no pre-existing assertion
   removed, relaxed, or guarded to skip (BL-225).
3. **No empty catch.** Every new/modified catch traces via `@adhd/sox-telemetry`.
4. **Parity.** `store-rebuild.ts`'s established behaviour is unchanged for
   existing callers; the extracted primitive preserves it for a quiescent store.
5. **Rename-target exclusion** proven by a test, not asserted in prose.

## Exit

Pass → unblock `s2-coldopen-flake`. Fail → record the failing check as a blocker in
`STATE.md`; do not dispatch S2.
