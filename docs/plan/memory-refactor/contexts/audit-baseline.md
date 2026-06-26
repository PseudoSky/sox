# audit-baseline — Phase audit: baseline

> **Slug is identity.** `audit-baseline` is immutable.

**Phase:** baseline · **Depends on:** `p0-baseline` · **Guard:** `audit_memrefactor.py --phase baseline`

---

## Goal

Create the phase-cumulative audit runner `scripts/audit_memrefactor.py` (mirrors
`audit_c6.py`: `--phase baseline|layout|extraction|routing|final`, each phase runs its
own checks + all prior phases, exit code = failure count, read-only). Implement
`phase_baseline()` to verify every `[p0-baseline.*]` criterion.

This state both BUILDS the runner and PROVES the baseline is trustworthy before any
refactor begins.

---

## Semantic Distillation

- **Primitive:** CREATE `audit_memrefactor.py` + `phase_baseline()`.
- **Reference Pattern:** `.workflow/plans/permission-enforcement/scripts/audit_c6.py`
  (phase dispatch, cumulative phases, slug-keyed checks, real-artifact verification).
- **Delta Spec:** `phase_baseline()` checks:
  - [p0-baseline.1] live server `memory_ping` → `embed_on_hash_fallback:false` +
    `embed_model:"bge-base-en-v1.5"`.
  - [p0-baseline.2] [fix:cosine-sanity] recorded `< 0.5`.
  - [p0-baseline.3] `baseline/tool-snapshot.json` exists, lists exactly 19 tools, each
    with a non-empty `inputSchema`.
  - [p0-baseline.4] `space_invariant_check.mjs --self-test` exits 0 + a run on a
    [fix:memory-db] copy exits 0.
  - [p0-baseline.5] `baseline/baseline.md` records the green gate set.
- **Invariants:** [inv:reality] (read the snapshot + run the real check), [def:audit-runner]
  (never weaken a check to pass).
- **Validation:** `python3 … --phase baseline` exits 0.

---

## Acceptance criteria

- [ ] **[audit-baseline.1]** `audit_memrefactor.py` exists, supports all five `--phase`
      values, and phases are cumulative.
- [ ] **[audit-baseline.2]** `--phase baseline` checks every `[p0-baseline.*]` and exits 0.

---

## Notes for executor

- If the server is still on hash ([p0-baseline.1] fails), the failure is correct — the
  republish has not landed. Do not weaken the check; report the block.
- Budget: 1 session.
