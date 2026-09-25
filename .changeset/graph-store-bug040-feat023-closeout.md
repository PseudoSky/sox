---
'@adhd/sox-graph-store': patch
---

Tests and a doc comment for BUG-040 / FEAT-023 — **no behaviour change**.

- `WriteNodeOpts.skipDedupe`'s doc comment no longer cites FEAT-012's reverted
  global `(kind, name)` index as "the real uniqueness guard". It now states the
  real model: identity is the DB-generated `uid`, uniqueness is consumer-declared
  via `NodeUniquenessPolicy` (FEAT-023, ADR-0010 D2), and FEAT-012's index was
  **reverted**.
- `bug-040-content-hash-collapse.spec.ts` pins the `skipDedupe` opt-out — distinct
  cross-kind docs with identical content stay distinct (`project`/`unknown` vs
  `status`/`unknown` → 2 rows), 7 identical-title issues stay 7 rows,
  `findOrCreateNode` cross-kind stays distinct — and that the DEFAULT `writeNode`
  still content-dedupes (idempotency preserved).
- `feat-023-policy-tx-scope.spec.ts` pins that a `NodeUniquenessPolicy.check`
  reading through its `tx` argument observes an uncommitted sibling row, rejects
  the second same-key write inside `transaction()`, and rolls the transaction back
  to zero.

Both suites are default-running (no env gates, ADR-0013) and carry recorded
negative controls (unconditional-dedupe flip; commented-out `check` call).
