# audit-core — CORE_AUDIT

> **Slug is identity.** `audit-core` is immutable; depends on its phase's states via `dag.json`.

**Phase:** Audit · **Depends on:** core-engine, core-invariants
**Guard:** `python3 docs/plan/tokenguard-service/scripts/audit_tokenguard.py --phase core`

---

## Goal

Verify every `core-engine.*` and `core-invariants.*` criterion against the actual codebase before `tg-service` may begin. Mandatory hold point. Proves the engine invariants hold **and** that no red-team vocabulary leaked into the library. Runs independently of the framework phase (parallel track).

---

## Semantic Distillation

- **Primitive:** EXTEND `audit_tokenguard.py --phase core` — runs `core-engine.*` + `core-invariants.*` checks (standalone; does not require the framework phase).
- **Reference Pattern:** the acceptance-criteria sections of `core-engine` and `core-invariants`.
- **Delta Spec:** `phase_core()` runs one check per `[core-engine.1..5]` + `[core-invariants.1..5]`, including the negative grep that `engagement`/`roe` vocabulary is absent from the lib, and runs the Vitest suite as the round-trip/leak/SSE proof.
- **Invariants:** read-only; fixes land in `libs/tokenguard-core/src` or the test suite.
- **Validation:** exits 0 and prints `CORE AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] The script checks every `[core-engine.*]` + `[core-invariants.*]` criterion ID. None omitted.
- [ ] The zero-WOP-vocabulary negative check is included.
- [ ] The script exits 0 and prints the phase PASS line.
- [ ] No criterion is marked skipped/manual.

---

## Reservations

```text
read_only:  ["libs/tokenguard-core/src/index.ts",
             "libs/tokenguard-core/src/tokenize.ts",
             "libs/tokenguard-core/test/roundtrip.spec.ts"]
mutates:    ["docs/plan/tokenguard-service/scripts/audit_tokenguard.py"]
```

---

## Contract Promise

- **Added:** `phase_core()` checks in `audit_tokenguard.py`.
- **Modified:** none.

---

## Commit points

- [ ] **After each source/test fix** — `fix(tokenguard-service): <slug>.<n> — <correction>`
- [ ] **After the audit passes** (mandatory) — `chore(tokenguard-service): audit-core green`

---

## Notes for executor

- A subtle detector regex change that breaks longest-first or boundary matching is the likeliest failure — fix the regex, never relax the round-trip assertion.
