# audit-final — FINAL REALITY AUDIT

> **Slug is identity.** `audit-final` is immutable. It is the last state before
> `done` and operationalizes the Definition of Done.

**Phase:** convergence · **Depends on:** `audit-enforcement`
**Guard:** `python3 .workflow/plans/permission-enforcement/scripts/audit_c6.py --phase final`

---

## Goal

Prove C6 is closed **against reality**: spawn the real built `memory-server` as a
child OS process under the host runtime, attempt a forbidden filesystem access,
and confirm it is **denied AND has no side effect** — and confirm declared access
still works. Verify the per-type enforcement levels, the `[ref:]` conformance
rules, and that nothing currently green regressed. This is the terminal hold
point; the founder reviews after it passes ([dod.5]).

**Every `[dod.N]` clause and every `[ref:]` idiom maps to ≥1 check here**
(gap-check Checks 7 & 8). No deferrable items.

`audit_c6.py --phase final` calls `phase_enforcement()` first, so the entire
foundation + enforcement checklist runs as a precondition ([def:audit-runner]).

---

## Semantic Distillation

- **Primitive:** EXTEND `scripts/audit_c6.py` with `phase_final()` — the
  reality checks for every `[dod.N]`, every `[ref:]`, and the regression gates.

- **Reference Pattern:** the `## Definition of Done` in `README.md`; the
  `references.json` catalog; the audit-v2 baseline (344/377 tests, lifecycle
  e2e). Uses **[fix:memory-ext]**, **[fix:allowed-db]**, **[fix:evil-db]**.

- **Delta Spec:** `phase_final()` runs `phase_enforcement()` then these checks.
  The reality checks SPAWN the real built `memory-server` child via the host
  runtime path (or directly with the **[def:policy-env]** set, mirroring what the
  supervisor injects) and drive it over stdio (`initialize` → `tools/call`):

  ```text
  # ── [dod.1] positive: declared access works (reality) ──
  [audit-final.positive-fs]   spawn memory-server with SOX_PERM_ENFORCE=1 +
                              SOX_PERM_FS_WRITE=["~/.memory/**"]; memory_write with
                              db_path=~/.memory/c6-allowed.db ([fix:allowed-db]) →
                              result has NO isError; ~/.memory/c6-allowed.db EXISTS.

  # ── [dod.2] negative: undeclared access blocked (reality, REQUIRED) ──
  [audit-final.negative-fs]   same spawned server; memory_write with
                              db_path=/tmp/sox-c6-evil.db ([fix:evil-db]) →
                              result IS isError (permission denied).
  [audit-final.negative-no-file]  after the denied call, /tmp/sox-c6-evil.db does
                              NOT exist and no /tmp/sox-c6-evil* dir was created —
                              the side effect was prevented, not just reported. [inv:reality]

  # ── [dod.3] per-type enforcement levels ──
  [audit-final.per-type-hard] the spawned mcp-server denies the undeclared path
                              (HARD level delivered) — asserted via the two negative
                              checks above against a REAL process boundary.
  [audit-final.per-type-soft] the in-process adapters (agent/hook/command) carry a
                              compiled policy + audit log and DOCUMENT the SOFT level;
                              grep each adapter for the SOFT/[dod.6] header note AND
                              assert no OS-isolation primitive was added for them.

  # ── [ref:] conformance (gap-check Check 7) ──
  [audit-final.ref-deny-by-default]  all permission decisions route through a Policy
                              method (policy.ts); grep confirms no ad-hoc compare
                              against SOX_PERM_*/permission arrays outside policy.ts.
  [audit-final.ref-guard-before-sink]  the memory-server guard precedes getDb/openDb;
                              AST/grep confirms the policy check appears before the
                              getDb call in handleToolCall.

  # ── [dod.4] no regression ──
  [audit-final.regress-suite] nx run-many -t test  → green; test count >= baseline
                              ([inv:no-regress]; baseline 344 passing per audit-v2).
  [audit-final.regress-e2e]   nx run host-runtime:test-e2e (tools/test-e2e-lifecycle.js)
                              → exits 0 (lifecycle still works under enforcement).

  # ── [dod.5] reviewer gate (machine half) ──
  [audit-final.reviewer-gate] this very script exits 0 — the machine half of the
                              founder's acceptance proof; founder approval is the
                              human half, recorded in the transition_log.

  # ── [dod.6] non-goal: no kernel sandbox / native isolation dependency ──
  [audit-final.nongoal-no-kernel-sandbox]  negative: no seccomp/landlock/apparmor/
                              container/namespace dependency or native-isolation
                              import was introduced (grep package.json + src for the
                              forbidden primitives) — bounding is process-boundary +
                              in-process guard only.
  ```

  Capture `$?` directly from the spawned-process driver (never pipe a tested exit
  through `tee`/`grep` that would mask it). The script collects all failures,
  prints each with criterion ID + fix, exits with the failure count.

- **Invariants:** [inv:reality] (live process + real filesystem),
  [inv:no-regress] (suite + e2e green), [inv:per-type] (levels proven),
  [inv:carry-fixes] (e2e proves session fixes survive),
  [ref:deny-by-default], [ref:guard-before-sink].

- **Validation:** `audit_c6.py --phase final` exits 0 and prints
  `FINAL AUDIT PASSED`.

---

## Acceptance criteria (audit-specific)

- [ ] The script spawns a REAL `memory-server` child and drives it over stdio —
      it does not assert against a log or a record ([inv:reality]).
- [ ] Every `[dod.N]` (1..6) has a proving check above.
- [ ] Every `[ref:]` in `references.json` has a conformance check above.
- [ ] The negative checks confirm BOTH denial AND the absence of the side effect.
- [ ] The script exits 0 and prints `FINAL AUDIT PASSED`; no check is
      skipped/manual-only.

---

## Reservations

```text
read_only:  ["libs/host-runtime/src/policy.ts",
             "libs/host-runtime/src/supervisor.ts",
             "libs/host-runtime/src/adapters/agent.ts",
             "libs/host-runtime/src/adapters/hook.ts",
             "libs/host-runtime/src/adapters/command.ts",
             "extensions/mcp-servers/memory-server/src/index.ts",
             "extensions/mcp-servers/memory-server/extension.json",
             "package.json"]
mutates:    ["scripts/audit_c6.py"]
```

> `scripts/audit_c6.py` is relative to the plan dir.

---

## Contract Promise

- **Added:** `phase_final()` in `scripts/audit_c6.py` (reality + dod + ref +
  regression checks).
- **Modified:** `scripts/audit_c6.py`.
- **Deleted:** none.

---

## Commit points

- [ ] **After each source fix** to satisfy a failing reality/regression check —
      commit the source change: `fix(c6): <criterion> — <correction>`
- [ ] **After the final audit passes** (mandatory) — commit the audit script +
      runtime updates, and record founder approval in the transition_log summary:
      `chore(c6): audit-final green — C6 enforced against reality (founder approved)`

---

## Notes for executor

- **Reality, not records.** The negative check MUST observe `/tmp/sox-c6-evil.db`
  is absent on disk after a denied call — a "we logged a denial" assertion is NOT
  acceptance ([inv:reality]). Clean up `~/.memory/c6-allowed.db` and any tmp path
  before and after.
- Build first: `nx run memory-server:build` and `nx run host-runtime:build` so
  `dist/index.js` artifacts exist for the spawn. The spawn must set
  **[def:policy-env]** exactly as the supervisor does — reuse `Policy.toEnv()` or
  set the four `SOX_PERM_*` vars + `SOX_PERM_ENFORCE=1` matching the
  memory-server's declared `~/.memory/**`.
- Drive the child over stdio with line-delimited JSON-RPC: `initialize`, then
  `tools/call` `memory_write`. Read the response line; check `isError`.
- `[audit-final.regress-suite]` must assert the test count did not drop below the
  baseline — a silently-removed test is a regression. Record the exact baseline
  number you observe at run time in the check (audit-v2 reports 344 passing /
  377 total; use the live `nx run-many -t test` count as the gate).
- The founder is the reviewer ([dod.5]); a green `--phase final` is the machine
  half of their gate. Record their approval in the transition_log when they sign
  off; do NOT set `state: complete` until the founder approves AND this guard is
  green.
- This is a long, integration-heavy state. Budget 1–2 sessions.
