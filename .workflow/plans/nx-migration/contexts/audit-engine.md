# audit-engine — ENGINE PHASE AUDIT

> **Slug is identity.** Immutable. Depends on every engine-phase state.

**Phase:** engine (Audit) · **Depends on:** engine-libs, sox-extension
**Guard:** `python3 .workflow/plans/nx-migration/scripts/audit_nx_migration.py --phase engine`

---

## Goal

Re-run the foundation phase, then verify every `engine-libs` and `sox-extension`
criterion against the actual repo before convergence begins. Mandatory hold point
— `type-discovery` may not start until every item passes. **No deferrable items.**
Fixes happen in source, never by weakening a check.

---

## Semantic Distillation

- **Primitive:** EXTEND `scripts/audit_nx_migration.py --phase engine` (calls
  `phase_foundation()` first, then the engine checks).
- **Reference Pattern:** the acceptance-criteria sections of `engine-libs`
  (`[engine-libs.1-5]`) and `sox-extension` (`[sox-extension.1-5]`).
- **Delta Spec:** RUN the `--phase engine` checks; fix any source failure they
  surface (the A12 parser, a fix not carried forward, a non-validating
  `extension.json`).
- **Invariants:** read-only audit; no network/ML models.
- **Validation:** the guard exits 0 (`ENGINE AUDIT PASSED`).

---

## Acceptance criteria (audit-specific)

- [ ] **[audit-engine.1]** `--phase engine` checks every engine criterion ID plus
      all foundation criteria; runs without ML models or network.
- [ ] **[audit-engine.2]** The guard exits 0; no criterion skipped or manual.

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

- **Added:** the engine checks in `scripts/audit_nx_migration.py`.
- **Modified:** none (audit read-only; fixes in source).

---

## Commit points

- [ ] **After each source fix** — `fix(nx-migration): <slug>.<n> — <what was corrected>`
- [ ] **After the audit passes** (mandatory) — `chore(nx-migration): audit-engine green — criteria verified`

---

## Notes for executor

- Never weaken a check to pass it — fix the source.
- A common failure is the A12 parser not flowing through the live CLI even though
  the unit test passes — verify against `node dist/apps/sox/main.js ... --help`.
- Record every fix in the `transition_log` summary.

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
