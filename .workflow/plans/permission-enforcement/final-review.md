<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist (C6 Runtime Permission Enforcement)

Worked through before publishing. Every box ticked `[x]` or marked
`N/A — <reason>`. `gap-check.js` (Check 9) blocks publish on any unticked box.

```text
[x] Definition of Done agreed in Step 1a — README has a `## Definition of
    Done` with IDed [dod.N] clauses (outcome, old-gone, evidence, non-goals,
    rollback). Supplied in the invocation (non-interactive subagent); founder is
    the named reviewer ([dod.5]).
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8) —
    dod.1..dod.6 each have a check() in audit_c6.py phase_final.
[x] Final audit written first — every DoD clause + design principle has a named
    check in phase_final (positive, negative, reality, per-type, ref, regression).
[x] All magic named — two pieces. (1) The declared-but-unenforced permission
    logging (loader.ts:256, adapters) — eliminated by the enforcement states;
    its absence is checked by audit-final.ref-deny-by-default. (2) The PARALLEL
    LEGACY host runtime under scripts/host/ (pre-nx copy of loader/supervisor/
    runtime/registrar/adapters with same-named symbols, two ProcessSupervisor /
    two loadFromLockfile) — this is a script-duplicating-a-primary-module magic.
    It now has a named ELIMINATION state, `consolidate-legacy` (the plan root),
    which DELETES the scripts/host/** tree + the two legacy test files so
    libs/host-runtime is the single canonical runtime. Its forcing functions are
    [consolidate-legacy.1..6] (dir gone, no importer, one definition, suite/build/
    lint green). No new parallel cache or string-literal dispatcher.
[x] Shorthand/mechanism separated — the permission DECLARATION (author shorthand,
    schema) is preserved unchanged ([inv:schema-stable]); the unenforced logging
    MECHANISM is replaced by a compiled Policy + real enforcement.
[x] External caller analysis done — every changed symbol declared in dag.json
    `changes`. consolidate-legacy DELETES {ProcessSupervisor, activate{Agent,Skill,
    Hook,Command,Mcp}, loadFromLockfile, McpRegistrar}; process-boundary resigns
    ProcessSupervisor; inproc-policy resigns activate{Agent,Skill,Hook,Command};
    mcp-path-guard resigns handleToolCall. Callers mapped via GitNexus (fresh @
    e29624c): the LEGACY copies (scripts/host/* + scripts/host-runtime.test.ts +
    scripts/host-delivery.test.ts) are in consolidate-legacy.mutates (deleted);
    the CANONICAL copies (libs/host-runtime/src/{index,supervisor,loader,registrar,
    runtime,adapters/*}.ts) are accounted via consolidate-legacy.read_only and the
    enforcement states' reservations; docs/architecture-audit-v2.md (prose only)
    is read_only. handleToolCall ← same-file (extensions/.../index.ts, mutated by
    mcp-path-guard). The architect runs the authoritative --discover gate (planner
    lacks Bash/rg here — see Dispatch note).
[x] Every node changing a symbol declares it in dag.json `changes`
    (deletes/resigns/renames) — consolidate-legacy carries the deletes set;
    process-boundary, inproc-policy, mcp-path-guard each carry a resigns set;
    foundation/audit nodes are additive (empty changes or none).
[x] Every deferral has a forcing function — no unanswered trigger phrases. The
    SOFT in-process level is not a deferral but a scoped non-goal ([dod.6]) with
    its forcing check audit-final.per-type-soft. Searched all contexts for
    "eventually"/"for now"/"later"/"out of scope"/"backward compat" — none left
    dangling; legacy-compat paths are bounded by [def:enforcement-opt-in] and
    proven by the .3 legacy criteria.

Structure (dag.json / state.json / _shared.md):
[x] Identity is a stable slug — no positional numbers anywhere in the source.
[x] dag.json holds structure; state.json holds runtime only.
[x] Slug set in dag.json.nodes == slug set in state.json.states (8 slugs); every
    context path exists; current_state=consolidate-legacy is a real node.
[x] Shared definitions centralized in contexts/_shared.md — policy-env,
    resource-sink, per-type levels, session-fixes, the two [ref:] idioms are
    defined once and referenced, never restated across contexts.

Per-state completeness (verified for every work state):
[x] Acceptance criteria present — ≥1 per added symbol, per mutated file, plus a
    negative/legacy criterion per state.
[x] Criterion IDs are slug-keyed ([policy-core.1] …) and match check IDs in
    audit_c6.py (gap-check Check 3).
[x] reservations.mutates populated for every state — every created/changed file.
[x] dag.json artifacts == reservations.mutates exactly for every node
    (gap-check Check 2). inproc-policy mutates index.ts and audit-foundation/
    enforcement/final mutate the plan-dir scripts/audit_c6.py — both reflected.
[x] Commit points section present in every context — mandatory post-guard commit
    plus an intermediate work-product commit.
[x] Shared-file merge protocols — N/A: the two parallel states (process-boundary,
    inproc-policy) mutate disjoint files; verified no overlap. Documented in both
    contexts.

Guards and audits:
[x] Guards are red→green — policy/supervisor/adapter/memory-server specs do not
    exist yet (the .spec.ts files are in `mutates`, not present), so each guard
    currently fails; the audit_c6 guards fail until each phase's checks pass.
[x] All criteria are deterministic commands — node/grep/nx/python, AST-ish grep
    where order matters (ref-guard-before-sink checks index order of guard vs sink).
[x] Final audit has negative checks — audit-final.negative-fs +
    negative-no-file (denial + absence of side effect) and nongoal-no-kernel-sandbox.
[x] Final audit has ≥1 live-data check — the reality driver spawns the REAL
    built memory-server and writes to a REAL filesystem path ([inv:reality]).
[x] notes field answers "what do I need to know that the context doesn't make
    obvious" for every node (footguns: mkdirSync-before-open, env scrub breakage,
    toEnv/fromEnv parity).
[x] dag.json dependency graph matches state-machine.md topology diagram exactly.

Hand off:
[x] Dispatch-or-orchestrate decision made (Step 1b: automatic dispatch = no);
    the "Dispatch Plan with >" line is printed in the planner's final report.
```

## Gap-check note (planner environment limitation)

The planner's environment lacks `ripgrep`/Bash for the Glob/Grep tools and did
not execute `node .../scripts/gap-check.js ... --discover` itself. The plan was
constructed directly against the checker's SOURCE (`gap-check.js`, read in full)
to satisfy every mechanical check: slug-set identity, artifacts↔mutates,
criterion↔audit-ID match, dependency integrity/acyclicity, null gaps, references
flat-shape + audit_check linkage, DoD coverage, and this filled checklist.
**The architect must run the gate** (`--discover`) from the repo root and treat
any FAIL as a hard block, per the invocation.

**Amendment 2026-06-12 (gap-check fixes).** Inserted `consolidate-legacy` as the
plan root to eliminate the nx-migration duplicate (`scripts/host/**`) so the
duplicate caller-mapping `--discover` FAILs vanish, and confirmed every
work-state criterion ([process-boundary.1..6], [mcp-path-guard.1..5],
[inproc-policy.1..5], [policy-core.1..6], [consolidate-legacy.1..6]) has a
matching `check()` ID in `audit_c6.py` (Check 3). `docs/architecture-audit-v2.md`
reserved read_only across the deleting/changing states (prose mentions only).
