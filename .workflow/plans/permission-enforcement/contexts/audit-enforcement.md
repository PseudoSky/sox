# audit-enforcement — ENFORCEMENT AUDIT

> **Slug is identity.** `audit-enforcement` is immutable. It depends on every
> state in the enforcement phase via `dag.json`.

**Phase:** Audit · **Depends on:** `process-boundary`, `inproc-policy`, `mcp-path-guard`
**Guard:** `python3 .workflow/plans/permission-enforcement/scripts/audit_c6.py --phase enforcement`

---

## Goal

Verify every acceptance criterion of `process-boundary`, `inproc-policy`, and
`mcp-path-guard` against the actual codebase before the final reality audit. This
hold point confirms each enforcement seam is wired and each type's level is
delivered. Mandatory; no deferrable items.

`audit_c6.py --phase enforcement` calls `phase_foundation()` first
([def:audit-runner] phase-cumulative), so a failure in the foundation layer
surfaces here too.

---

## Semantic Distillation

- **Primitive:** EXTEND `scripts/audit_c6.py` with a `phase_enforcement()`
  function checking every `[process-boundary.*]`, `[inproc-policy.*]`, and
  `[mcp-path-guard.*]` criterion.

- **Reference Pattern:** the acceptance-criteria sections of the three
  enforcement states. Each check references a criterion by its slug-keyed ID.

- **Delta Spec:** `audit_c6.py --phase enforcement` runs `phase_foundation()`
  then:

  ```text
  [process-boundary.1..6] nx run host-runtime:test  (supervisor-policy.spec.ts: policy-env, env scrub,
                          legacy compat, cwd, carried-forward suite green, policy() accessor)
  [inproc-policy.1..5]    nx run host-runtime:test  (inproc-policy.spec.ts) + grep for SOFT header notes
  [mcp-path-guard.1..5]   nx run memory-server:test (permission-guard.spec.ts: deny/allow/before-sink/legacy/env-parity)
  ```

  Collects all failures, prints each with its criterion ID and fix, exits with
  the failure count.

- **Invariants:** [def:audit-runner], [inv:no-regress] (both lib and
  memory-server suites green), [inv:per-type] (the SOFT header check enforces
  honest scoping).

- **Validation:** `audit_c6.py --phase enforcement` exits 0 and prints
  `ENFORCEMENT AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] The script checks every `[process-boundary.*]`, `[inproc-policy.*]`, and
      `[mcp-path-guard.*]` criterion ID — none omitted.
- [ ] `phase_enforcement()` calls `phase_foundation()` first.
- [ ] The script exits 0 and prints `ENFORCEMENT AUDIT PASSED`.
- [ ] No criterion is skipped or manual-only.

---

## Reservations

```text
read_only:  ["libs/host-runtime/src/supervisor.ts",
             "libs/host-runtime/src/adapters/agent.ts",
             "libs/host-runtime/src/adapters/hook.ts",
             "libs/host-runtime/src/adapters/command.ts",
             "extensions/mcp-servers/memory-server/src/index.ts"]
mutates:    ["scripts/audit_c6.py"]
```

> `scripts/audit_c6.py` is relative to the plan dir.

---

## Contract Promise

- **Added:** `phase_enforcement()` in `scripts/audit_c6.py`.
- **Modified:** `scripts/audit_c6.py` (the one accumulating audit runner).
- **Deleted:** none.

---

## Commit points

- [ ] **After each source fix** to satisfy a failing criterion — commit the
      source change: `fix(c6): <slug>.<n> — <correction>`
- [ ] **After the audit passes** (mandatory) — commit the audit script + runtime
      updates: `chore(c6): audit-enforcement green — N criteria verified`

---

## Notes for executor

- Build both projects before running (`nx run host-runtime:build`,
  `nx run memory-server:build`) — the vitest specs run from source via the test
  target, but `[process-boundary.1]`/`.2`/`.4` spawn a probe child that may need
  the built lib; document any build precondition in the check failure message.
- The most likely failure is `[mcp-path-guard.1]` if the guard runs AFTER
  `mkdirSync` in `openDb` — check the filesystem-absence assertion carefully; a
  created directory at the evil path is a fail even if no `.db` file appears.
- Any plan-structure change triggered by a finding is a `planner`-class
  `amendment_log` entry, not a silent edit.
