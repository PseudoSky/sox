<!-- markdownlint-disable MD013 MD033 -->
# audit-foundation — FOUNDATION_AUDIT

> **Slug is identity.** `audit-foundation` is immutable. It depends on every state in the foundation
> phase via `dag.json`, so adding a state to the phase only adds an edge — this file's name never
> changes.

**Phase:** Audit · **Depends on:** schema-delta, capability-engine, host-registry
**Guard:** `python3 scripts/audit_eim.py --phase foundation`

---

## Goal

Verify every acceptance criterion from `schema-delta`, `capability-engine`, and `host-registry`
against the actual codebase before advancing to the **enforcement** phase. This is a mandatory hold
point. `mcp-runtime`, `install-lifecycle`, and `generators` may not begin until every foundation
criterion passes.

**There are no deferrable items in an audit state.** If a criterion is not met, the executor fixes
it in source before advancing — not a known issue, not a follow-up ticket, not a `# TODO`. The
criterion is met or the audit fails.

---

## Semantic Distillation

- **Primitive:** CREATE `scripts/audit_eim.py` — the phase-cumulative checklist runner that exits
  with the failure count. `phase_foundation()` is authored here; later audits call it first.

- **Reference Pattern:** the acceptance-criteria sections of `schema-delta.md`,
  `capability-engine.md`, `host-registry.md` — the exact items the script checks, by slug-keyed ID.

- **Delta Spec:** `scripts/audit_eim.py --phase foundation` runs:

  ```text
  [schema-delta.1..5]      grep/build/test checks on libs/manifest
  [capability-engine.1..5] grep/test checks on libs/install-engine capabilities + ledger
  [host-registry.1..5]     grep/test checks on libs/host-registry (claude + codex)
  ```

  The `_run` helper **prepends the repo-local `node_modules/.bin` to PATH** (computed from the
  script's own location) so a bare `nx` inside a check resolves deterministically in a clean
  subprocess. The script collects all failures, prints each with its criterion ID and the specific
  fix, then exits with the failure count (0 = pass).

- **Invariants:**
  - Runs without ML models or network access.
  - Read-only — never modifies source files; fixes happen in source.
  - Every failure names the file/symbol and the required change.
  - Fixes made during the audit are committed before the guard is re-run.

- **Validation:** `python3 scripts/audit_eim.py --phase foundation` exits 0 and prints
  `FOUNDATION AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] `scripts/audit_eim.py` runs without ML models or network.
- [ ] The script checks every slug-keyed criterion ID from `schema-delta`, `capability-engine`,
      `host-registry`. No criterion is omitted.
- [ ] The script exits 0 and prints `FOUNDATION AUDIT PASSED`.
- [ ] No criterion is marked "skipped" or "manual-only" in the output.

---

## Reservations

```text
read_only:  ["libs/manifest", "libs/install-engine", "libs/host-registry"]
mutates:    ["scripts/audit_eim.py"]
```

---

## Contract Promise

- **Added:** `scripts/audit_eim.py` (also used by `audit-enforcement` and `audit-final` with a
  different `--phase`).
- **Modified:** none (audit is read-only; fixes happen in source files).

---

## Commit points

- [ ] **After each source fix** to satisfy a failing criterion — commit the source change (not the
      check): `fix(eim): <slug>.<n> — <what was corrected>`
- [ ] **After the audit passes** (mandatory) — commit the audit script plus `state.json` / `dag.json`:
      `chore(eim): audit-foundation green — foundation criteria verified`

---

## Notes for executor

- The most common failure here will be `schema-delta.2` (an existing `agent` manifest still carries
  `lifecycle`) or `capability-engine.3` (reverse disturbs a foreign key). Fix the **source**, never
  weaken the check.
- The `_run` PATH augmentation is non-negotiable — without it `./node_modules/.bin/nx`-equivalent
  bare-`nx` checks exit 127 in the audit subprocess (this was a real C6 failure). The skeleton in
  `scripts/audit_eim.py` already does this; do not remove it.
- Write the script incrementally runnable: `--phase enforcement`/`--phase final` (authored in later
  audit states) call `phase_foundation()` first, so one script accumulates all checks.
