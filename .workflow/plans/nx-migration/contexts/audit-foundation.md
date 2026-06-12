# audit-foundation — FOUNDATION PHASE AUDIT

> **Slug is identity.** Immutable. Depends on every foundation-phase state.

**Phase:** foundation (Audit) · **Depends on:** checkpoint-branch, nx-init, manifest-lib, authoring-lib
**Guard:** `python3 .workflow/plans/nx-migration/scripts/audit_nx_migration.py --phase foundation`

---

## Goal

Verify every acceptance criterion from `checkpoint-branch`, `nx-init`,
`manifest-lib`, and `authoring-lib` against the actual repo before the engine
phase begins. Mandatory hold point — `engine-libs` may not start until every item
passes. **There are no deferrable items.** A failing check is fixed in source
(never by weakening the check) before advancing.

---

## Semantic Distillation

- **Primitive:** EXTEND `scripts/audit_nx_migration.py --phase foundation` — the
  structured checklist runner that exits with the failure count.
- **Reference Pattern:** the acceptance-criteria sections of the four foundation
  states — those IDs are exactly what the script checks
  (`[checkpoint-branch.1-2]`, `[nx-init.1-6]`, `[manifest-lib.1-6]`,
  `[authoring-lib.1-6]`).
- **Delta Spec:** the script (already authored in this plan's `scripts/`) runs the
  `phase_foundation()` checks. This state's work is to RUN it, and to fix any
  source failure it surfaces.
- **Invariants:** audit is read-only; runs without ML models or network.
- **Validation:** the guard exits 0 and prints `FOUNDATION AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] **[audit-foundation.1]** `scripts/audit_nx_migration.py --phase foundation`
      runs without ML models or network and checks every foundation criterion ID.
- [ ] **[audit-foundation.2]** The guard exits 0 (`FOUNDATION AUDIT PASSED`); no
      criterion skipped or marked manual.

---

## Reservations

```text
read_only:  ["libs",
             "apps",
             "packages",
             "extensions",
             "scripts/validate-manifests.ts"]
mutates:    ["scripts/audit_nx_migration.py"]
```

---

## Contract Promise

- **Added:** the foundation checks in `scripts/audit_nx_migration.py` (also used by
  later phases via `--phase`).
- **Modified:** none (audit is read-only; fixes happen in source files).

---

## Commit points

- [ ] **After each source fix** to satisfy a failing criterion — `fix(nx-migration): <slug>.<n> — <what was corrected>`
- [ ] **After the audit passes** (mandatory) — `chore(nx-migration): audit-foundation green — criteria verified`

---

## Notes for executor

- The audit script is read-only — never weaken a check to make it pass; fix source.
- The most common failure is a reference to a deleted demo or pre-fix path in a
  file outside a state's `mutates` — fix the source file.
- Every fix made during this audit goes in the `transition_log` summary.

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
