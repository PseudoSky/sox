# done — TERMINAL

> **Slug is identity.** Immutable. Terminal sentinel.

**Phase:** convergence (Audit) · **Depends on:** audit-final
**Guard:** `python3 .workflow/plans/nx-migration/scripts/audit_nx_migration.py --phase final`

---

## Goal

The migration is complete. This terminal state is reached only after `audit-final`
exits 0 and the founder ([dod.10]) accepts. It performs no work; its guard
re-asserts the final audit so the terminal state is itself verifiable, and its
executor sets `state: complete`.

---

## Semantic Distillation

- **Primitive:** WIRE the terminal transition — set `state: complete`.
- **Reference Pattern:** `audit-final`'s green run; the founder's acceptance.
- **Delta Spec:** confirm `audit-final` is `done`; re-run the final guard; set
  frontmatter `state: complete` in `status.md`; append the terminal transition.
- **Invariants:** no source mutation; only `audit-final` may have run the fixes.
- **Validation:** the guard exits 0.

---

## Acceptance criteria (audit-specific)

- [ ] **[done.1]** The final guard re-asserts green from a clean slate.

---

## Reservations

```text
read_only:  ["libs",
             "apps",
             "packages",
             "extensions"]
mutates:    ["scripts/audit_nx_migration.py"]
```

---

## Contract Promise

- **Added:** none.
- **Modified:** none (terminal sentinel; the audit script is unchanged here).

---

## Commit points

- [ ] **After confirming green + founder acceptance** (mandatory) — `chore(nx-migration): done — migration complete (state: complete)`

---

## Notes for executor

- This is the FINAL state: set `state: complete` in `status.md` frontmatter (not
  `executing`).
- Do NOT merge to main — that is for the founder to do after acceptance.

**Mandatory completion step.** Update `state.json` (`done` → status `done`,
`current_state` stays `done`), set `status.md` `state: complete`, append the
transition, and commit (R1).
