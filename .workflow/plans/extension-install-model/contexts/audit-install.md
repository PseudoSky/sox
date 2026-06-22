# audit-install — INSTALL AUDIT

> **Slug is identity.** `audit-install` is immutable.

**Phase:** Audit · **Depends on:** cli-wiring, declarative-install, mcp-install-modes
**Guard:** `python3 .workflow/plans/extension-install-model/scripts/audit_eim.py --phase install`

---

## Goal

Verify every acceptance criterion from `cli-wiring`, `declarative-install`, and `mcp-install-modes` against the actual codebase, plus re-verify all foundation criteria (cumulative). This is a mandatory hold point. `service-runtime`, `lifecycle`, and `enforcement` may not begin until every item passes.

The behavioral entrypoints proven here: `[dod.1]` init+validate, `[dod.3]` declarative placement, `[dod.4]` mcp profiles, `[dod.7]` update, `[dod.8]` diff, `[dod.9]` uninstall — all driven through real CLI.

**There are no deferrable items in an audit state.**

---

## Semantic Distillation

- **Primitive:** EXTEND `scripts/audit_eim.py --phase install` — adds `[cli-wiring.*]`, `[declarative-install.*]`, `[mcp-install-modes.*]` checks; calls `phase_foundation()` first (cumulative).

- **Reference Pattern:** The acceptance criteria sections in `contexts/cli-wiring.md`, `contexts/declarative-install.md`, `contexts/mcp-install-modes.md`. Behavioral checks invoke the guard scripts. Structural checks use grep.

- **Delta Spec:** `scripts/audit_eim.py --phase install` calls `phase_foundation()` then runs install-phase checks. Exits 0 iff all pass; prints `INSTALL AUDIT PASSED`.

- **Invariants:** Same as audit-foundation: read-only, no network, failures name files.

- **Validation:** `python3 .workflow/plans/extension-install-model/scripts/audit_eim.py --phase install` exits 0.

---

## Acceptance criteria (audit-specific)

- [ ] `scripts/audit_eim.py --phase install` runs all foundation checks PLUS install-phase checks.
- [ ] Every `[cli-wiring.N]`, `[declarative-install.N]`, `[mcp-install-modes.N]` criterion has a matching `check()` call.
- [ ] The script exits 0 and prints `INSTALL AUDIT PASSED`.
- [ ] No criterion is marked "skipped" or "manual-only".

---

## Reservations

```text
read_only:  ["bin/sox",
             "apps/sox/src/main.ts",
             "libs/install-engine/src/install.ts",
             "libs/install-engine/src/diff.ts",
             "libs/install-engine/src/lifecycle.ts",
             "libs/install-engine/src/capabilities/config-merge.ts",
             "libs/install-engine/src/capabilities/run-service.ts"]
mutates:    ["scripts/audit_eim.py"]
```

---

## Contract Promise

- **Modified:** `scripts/audit_eim.py` — `phase_install()` added, cumulative

---

## Commit points

- [ ] **After each source fix** — `fix(eim): <slug>.<n> — <what corrected>`
- [ ] **After the audit passes** — `chore(eim): audit-install green — N criteria verified`

---

## Notes for executor

- The install-phase behavioral guard invocations are the tier-3 proof the orchestrator needs to confirm `[dod.1]`, `[dod.3]`, `[dod.4]`, `[dod.7]`, `[dod.8]`, `[dod.9]`. Do not replace them with library-level unit tests.
- `[dod.2]` (build) is also proven in this phase via `[cli-wiring.3]`.
