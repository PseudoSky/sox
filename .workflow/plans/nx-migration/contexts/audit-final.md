# audit-final — FINAL AUDIT: D5 SCOPE FROM A CLEAN SLATE

> **Slug is identity.** Immutable. Legacy P10 = the final audit.

**Phase:** convergence (Audit) · **Depends on:** type-discovery, memory-core, migrate-rest, ci-release
**Guard:** `python3 .workflow/plans/nx-migration/scripts/audit_nx_migration.py --phase final`

---

## Goal

Full, final verification of the **D5 scope** against **reality** ([def:reality-check])
from a clean slate: every active type `init → build → validate → install → run`,
lifecycle with zero orphan processes (OS process table via `pgrep`), the full
command surface using the documented flag forms. Every `[dod.N]` and every `[ref:]`
idiom is proven by a check here (positive + negative + live-data). A1, A12, B1–B4,
C7 pass; nothing previously green regresses. C6 and memory semantic depth remain
explicitly out of scope ([dod.9]). **No deferrable items.** On green, the founder
accepts (the reviewer assigned in [dod.10]).

---

## Semantic Distillation

- **Primitive:** EXTEND + RUN `scripts/audit_nx_migration.py --phase final` (calls
  `phase_engine()` + `_convergence_work()`, then the DoD/ref/negative/live checks).
- **Reference Pattern:** `DOD.md` (the bar); ADR-0001 D5; `CLAUDE.md` (currently-green
  items that must not regress); `references.json` (the `[ref:]` idioms).
- **Delta Spec:** RUN the final phase. Every failing assertion is fixed at its root
  cause in the owning state's output (P1–P9 equivalents), rebuilt, and re-run — do
  not declare done with any in-scope assertion red. Verify previously-green items
  (A2–A11, C1–C5) stay green; confirm C6 and memory-depth are NOT claimed done.
- **Invariants:** read-only audit; verification against reality, not test logs alone.
- **Validation:** the guard exits 0 (`FINAL AUDIT PASSED`); the founder accepts.

The final-audit check IDs proving each DoD clause and reference:

| Proves | Check ID (in the audit script) |
|---|---|
| `[dod.1]` A1 | `dod.1` |
| `[dod.2]` A12 | `dod.2` |
| `[dod.3]` B1 | `dod.3` |
| `[dod.4]` B2 (lifecycle, zero orphans) | `dod.4` |
| `[dod.5]` B3 (incremental) | `dod.5` |
| `[dod.6]` B4 | `dod.6` |
| `[dod.7]` C7 | `dod.7` |
| `[dod.8]` no regression | `dod.8` |
| `[dod.9]` non-goals unclaimed | `dod.9` |
| `[dod.10]` reviewer/rollback | `dod.10` |
| `[ref:nx-free-authoring-core]` | `audit-final.ref-nx-free-authoring-core` |
| `[ref:scaffold-parity]` | `audit-final.ref-scaffold-parity` |
| `[ref:nx-never-runtime-dep]` | `audit-final.ref-nx-never-runtime-dep` |
| `[ref:manifest-single-source]` | `audit-final.ref-manifest-single-source` |
| `[ref:no-cross-extension-reachin]` | `audit-final.ref-no-cross-extension-reachin` |
| `[ref:dual-flag-form]` | `audit-final.ref-dual-flag-form` |
| `[ref:self-hosted-extension-zero]` | `audit-final.ref-self-hosted-extension-zero` |

---

## Acceptance criteria (audit-specific)

- [ ] **[audit-final.1]** `--phase final` runs every DoD, reference, negative, and
      live-data check plus all prior phases; no ML models or network.
- [ ] **[audit-final.2]** The guard exits 0 (`FINAL AUDIT PASSED`); no in-scope
      assertion red; no criterion skipped or manual.

---

## Reservations

```text
read_only:  ["libs",
             "apps",
             "packages",
             "extensions",
             "DOD.md",
             "CLAUDE.md"]
mutates:    ["scripts/audit_nx_migration.py"]
```

---

## Contract Promise

- **Added:** the final-phase checks (DoD proofs, reference conformance, negative,
  live-data) in `scripts/audit_nx_migration.py`.
- **Modified:** none (audit read-only; fixes happen in the owning states' source).

---

## Commit points

- [ ] **After each root-cause fix** — `fix(nx-migration): <id> — <what was corrected>`
- [ ] **After the audit passes + founder acceptance** (mandatory) — `chore(nx-migration): audit-final green — D5 scope verified from clean slate`

---

## Notes for executor

- DO NOT declare done with any D5 in-scope item red — repair forward, never merge.
- DO NOT claim C6 or memory semantic depth as done — they remain out of scope.
- Verification is against the real process table + real artifacts, not test logs alone.
- Make fixes targeted in the specific lib/config that is wrong; do not re-implement
  prior states.
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
The terminal `done` state follows once the founder accepts.
