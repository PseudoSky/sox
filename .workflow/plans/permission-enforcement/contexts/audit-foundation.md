# audit-foundation — FOUNDATION AUDIT

> **Slug is identity.** `audit-foundation` is immutable. It depends on every
> state in the foundation phase via `dag.json`; adding a foundation state only
> adds an edge.

**Phase:** Audit · **Depends on:** `consolidate-legacy`, `policy-core`
**Guard:** `python3 .workflow/plans/permission-enforcement/scripts/audit_c6.py --phase foundation`

---

## Goal

Verify every acceptance criterion of `consolidate-legacy` and `policy-core`
against the actual codebase before any enforcement state begins. The legacy
`scripts/host/` duplicate must be gone (so C6 is enforced once, in the single
canonical runtime) AND the Policy contract must be correct — enforcement states
(`process-boundary`, `inproc-policy`) consume both. This is a mandatory hold
point.

**There are no deferrable items in an audit state.** A failing check is fixed in
source before advancing — not a known issue, not a TODO.

---

## Semantic Distillation

- **Primitive:** CREATE `scripts/audit_c6.py` (the plan-dir audit runner) with a
  `phase_foundation()` function checking every `[consolidate-legacy.*]` and
  `[policy-core.*]` criterion.

- **Reference Pattern:** the acceptance-criteria sections of
  `consolidate-legacy.md` and `policy-core.md`. Each check references a criterion
  by its slug-keyed ID.

- **Delta Spec:** `audit_c6.py --phase foundation` runs:

  ```text
  [consolidate-legacy.1..6] scripts/host gone; legacy tests gone; no importer of scripts/host;
                            one ProcessSupervisor/loadFromLockfile definition; suite + build + lint green
  [policy-core.1] node -e "require dist/index.js; assert compilePolicy + compilePolicyFromEnv are functions"
  [policy-core.2] nx run host-runtime:test   (deny-by-default assertion in policy.spec.ts)
  [policy-core.3] nx run host-runtime:test   (legacy-compat assertion)
  [policy-core.4] nx run host-runtime:test   (toEnv/fromEnv round-trip assertion)
  [policy-core.5] nx run host-runtime:test   (~/ and ** matching assertion)
  [policy-core.6] grep policy.ts imports — only node:* / local
  ```

  The script collects all failures, prints each with its criterion ID and the
  specific fix, then exits with the failure count. `nx run host-runtime:test`
  must be built first (`nx run host-runtime:build`) so `dist/index.js` exists for
  `[policy-core.1]`.

- **Invariants:** [def:audit-runner] (read-only; phase-cumulative),
  [inv:no-regress] (the existing lib suite stays green).

- **Validation:** `python3 .../audit_c6.py --phase foundation` exits 0 and
  prints `FOUNDATION AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] `scripts/audit_c6.py` runs without network or ML models.
- [ ] The script checks every `[consolidate-legacy.*]` and `[policy-core.*]`
      criterion ID — none omitted.
- [ ] The script exits 0 and prints `FOUNDATION AUDIT PASSED`.
- [ ] No criterion is marked skipped or manual-only.

---

## Reservations

```text
read_only:  ["libs/host-runtime/src/policy.ts",
             "libs/host-runtime/src/policy.spec.ts",
             "libs/host-runtime/src/index.ts"]
mutates:    ["scripts/audit_c6.py"]
```

> The audit script path `scripts/audit_c6.py` is RELATIVE TO THE PLAN DIR
> (`.workflow/plans/permission-enforcement/scripts/audit_c6.py`) — gap-check
> resolves audit scripts under `<plan-dir>/scripts/`.

---

## Contract Promise

- **Added:** `scripts/audit_c6.py` (reused by later audits with different
  `--phase`).
- **Modified:** none (audit is read-only; fixes happen in source).

---

## Commit points

- [ ] **After each source fix** to satisfy a failing criterion — commit the
      source change: `fix(c6): policy-core.<n> — <correction>`
- [ ] **After the audit passes** (mandatory) — commit the audit script + runtime
      updates: `chore(c6): audit-foundation green — N criteria verified`

---

## Notes for executor

- Build the lib before running `[policy-core.1]`/`.6` — `dist/index.js` must
  exist. The audit script can run `nx run host-runtime:build` as a precondition
  inside the check, or assume the executor built it; document whichever you
  choose in the check's failure message.
- Write the script so `--phase enforcement` and `--phase final` call this
  function first ([def:audit-runner] phase-cumulative).
- The most common failure here is `[policy-core.4]` (env round-trip) — if it
  fails, the bug is in `toEnv`/`fromEnv` in `policy.ts`, not the check.
