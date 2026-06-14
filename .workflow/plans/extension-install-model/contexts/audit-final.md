<!-- markdownlint-disable MD013 MD033 -->
# audit-final — FINAL_AUDIT

> **Slug is identity.** `audit-final` is immutable. It depends on the convergence states +
> `audit-enforcement` via `dag.json`; adding a state to convergence only adds an edge — this file's
> name never changes.

**Phase:** Audit (final, before `done`) · **Depends on:** ingestion-skill, dod-reconcile,
audit-enforcement
**Guard:** `python3 scripts/audit_eim.py --phase final`

---

## Goal

The reality audit that operationalizes the **Definition of Done**. It proves **every `[dod.1]`–
`[dod.13]`**, **every `[ref:*]`** idiom, and **[inv:no-regress]** against the real codebase + real
hosts — positive (the new system works), negative (the old system is gone), live-data (real
artifacts, not fixtures), and conformance (each `[ref:]` rule holds). It also runs the convergence
criteria (`[ingestion-skill.*]`, `[dod-reconcile.*]`) and, being phase-cumulative, every foundation
+ enforcement criterion. This is the last state before `done`; the **founder** reviews after it is
green (**[dod.11]**), and only then is `state: complete` set.

**There are no deferrable items.** A failing check is fixed in source before the founder review.

---

## Semantic Distillation

- **Primitive:** EXTEND `scripts/audit_eim.py` — add `phase_final()`, which calls
  `phase_enforcement()` first, then runs the DoD/reference/live checks.

- **Reference Pattern:** the `## Definition of Done` clauses `[dod.1]`–`[dod.13]` in `README.md`; the
  five idioms in `references.json` (each `audit_check` `[audit-final.ref-<slug>]`); the convergence
  states' criteria; **[fix:ingest-source]** + **[fix:c6-e2e]**.

- **Delta Spec:** `scripts/audit_eim.py --phase final` runs `phase_enforcement()` then:

  ```text
  Convergence criteria:
    [ingestion-skill.1..4]   skill exists / legacy gone / flow+delegation / born-conformant
    [dod-reconcile.1..2]     DOD.md + CLAUDE.md split "run"

  Definition-of-Done proofs (one check id literally containing each [dod.N]):
    [dod.1]  declarative reinject end-to-end (claude project+user, codex) — on disk
    [dod.2]  mcp stdio (.mcp.json, --trust prompt) AND sox service; undeclared access denied
    [dod.3]  six capabilities each apply/reverse/update/verify, idempotent, scope+host-aware
    [dod.4]  host registry ships claude + codex; detection + forbidden-key refusal
    [dod.5]  provenance ledger drives diff/uninstall; external edit detected; foreign keys untouched
    [dod.6]  old system gone — install-target consumer + memory vendored guard gone (grep empty)
    [dod.7]  generators expose Appendix-A options; --content @source stamps source provenance
    [dod.8]  no regression — nx run-many build,lint,test + C6 e2e + memory-* green
    [dod.9]  DoD reconciled — DOD.md/CLAUDE.md split run(process)/placed(declarative)
    [dod.10] non-goals respected — boundary: no check asserts the foreign host executed content
    [dod.11] reviewer = founder — final audit exits 0 (proof object); founder approval is the gate
    [dod.12] rollback — a capability that cannot cleanly reverse aborts
    [dod.13] ingestion skill replaces docs/ingestion; swarm-cost ingested via the skill

  Reference conformance (one per references.json idiom):
    [audit-final.ref-ledger-reversible]       config/array merges record + reverse exactly
    [audit-final.ref-host-keyed-target]       no literal host path outside libs/host-registry
    [audit-final.ref-config-merge-format]     host configs touched only via config-merge (json+toml)
    [audit-final.ref-policy-env-enforce]      every mcp spawn path enforces policy-env at the sink
    [audit-final.ref-born-conformant-scaffold] sox init ⇄ nx byte-identical, single scaffolder

  Live-data check:
    [live] ingest swarm-cost driven solely by sox-ingest; assert the extension lands + validates
  ```

  Same `_run` PATH augmentation. Collects all failures, prints each with its ID + fix, exits with the
  failure count.

- **Invariants:** runs without ML models or network (the live ingest uses local sources + the real
  FS, no network); read-only over source; every failure names the file/symbol; the boundary
  (**[inv:boundary]**) is asserted negatively — **no** check claims the foreign host executed
  content.

- **Validation:** `python3 scripts/audit_eim.py --phase final` exits 0 and prints
  `FINAL AUDIT PASSED`; then the founder reviews (**[dod.11]**) before `state: complete`.

---

## Acceptance criteria (audit-specific)

- [ ] `phase_final()` calls `phase_enforcement()` first (cumulative across all three phases).
- [ ] Every `[dod.1]`–`[dod.13]` clause has a proving check whose id contains that clause id.
- [ ] Every `references.json` idiom's `[audit-final.ref-<slug>]` check is present.
- [ ] At least one negative check (old system gone) and at least one live-data check are present.
- [ ] The script exits 0 and prints `FINAL AUDIT PASSED`.
- [ ] No criterion is marked "skipped" or "manual-only".

---

## Reservations

```text
read_only:  ["libs", "packages", "apps", "extensions", "bin", "DOD.md", "CLAUDE.md", "docs"]
mutates:    ["scripts/audit_eim.py"]
```

---

## Contract Promise

- **Added:** `phase_final()` in `scripts/audit_eim.py` (DoD + reference + live checks).
- **Modified:** `scripts/audit_eim.py` (extends the one accumulating script; audit stays read-only
  over source).

---

## Commit points

- [ ] **After each source fix** to satisfy a failing DoD/reference/live check — `fix(eim): <id> — <what was corrected>`
- [ ] **After the audit passes** (mandatory) — commit the audit script plus `state.json` /
      `dag.json`: `chore(eim): audit-final green — all DoD + references + live verified`
- [ ] **After founder approval** (**[dod.11]**) — set `state: complete` and commit:
      `chore(eim): plan complete — founder accepted`

---

## Notes for executor

- This audit spawns **real hosts** where possible: place a markdown agent into `.claude/agents/`
  (claude) + the codex equivalent; run an mcp-server as stdio in `.mcp.json` (assert undeclared
  access denied) AND as a sox service; ingest `swarm-cost` via the `sox-ingest` skill. Verify against
  the FS, not test output (the project rule).
- **The boundary check is a negative** (`[dod.10]`): confirm NO check asserts "the foreign host ran
  it" (**[inv:boundary]**). A check that tries to prove execution is itself a defect.
- `[dod.11]` is satisfied by the audit exiting 0 **and** the founder approving — the script proves
  the mechanical half; do not set `state: complete` before the founder signs off.
- Keep one accumulating script: `phase_final()` MUST call `phase_enforcement()` (which calls
  `phase_foundation()`), so `--phase final` re-runs all 30 prior-phase criteria too.
