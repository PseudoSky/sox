<!-- markdownlint-disable MD013 -->
# Step 7 — Final review checklist (filled — publish gate)

This is the committed, diffable record that the Step-7 review was done. Every box
is `[x]` or `N/A — <reason>`. `gap-check.js` (Check 9) blocks publish on any
unticked box.

```text
[x] Definition of Done agreed in Step 1a — README has a `## Definition of Done`
    with IDed [dod.1]-[dod.10] clauses (outcome A1/A12/B1-B4/C7, old-gone via
    demos+scaffolder-test+reach-in, evidence=founder+green clean-slate audit,
    non-goals C6+memory-depth, rollback=any in-scope red -> repair forward).
[x] Every [dod.N] is proven by a final-audit check (gap-check.js Check 8) —
    dod.1..dod.10 each have a check() in audit_nx_migration.py phase_final.
[x] Final audit written first — audit_nx_migration.py operationalizes every DoD
    clause and every [ref:] idiom (positive + negative + live-data) before the
    work states were finalized.
[x] All magic named — the special cases this migration eliminates each have a
    check: the drift-prone string-template scaffolder (replaced by libs/authoring
    + born-conformance, [authoring-lib.3-4]); the cross-extension ../**/dist
    reach-in (killed in memory-core, [memory-core.3], audit-final.ref-no-cross-
    extension-reachin); the dual dist mirror / hand-maintained build (nx tsc
    targets); the broken single-form flag parser (A12 fix, [ref:dual-flag-form]).
[x] Shorthand/mechanism separated — the ergonomic "scaffold a type" shorthand is
    preserved as scaffold()/@adhd/sox-nx generators; the drift-prone hand-rolled
    string-template mechanism is eliminated. nx is dev-time only — the build
    mechanism is adopted without leaking into the runtime contract.
[x] External caller analysis done — gap-check.js --discover ran clean. The
    migration relocates whole files/directories and deletes fixtures rather than
    re-signaturing public symbols, so each code-moving node declares an explicit
    empty `changes` block; every file deletion/move is covered by a state's
    `mutates`, and every read source by `read_only`. The code-moving states
    additionally mandate GitNexus impact/context BEFORE moving and detect-changes
    AFTER (engine-libs, memory-core, migrate-rest) — a discovered importer outside
    the reservations is a planner-class divergence (stop + escalate).
[x] Every node changing a symbol declares it in dag.json `changes` — the three
    code-moving nodes (engine-libs, memory-core, migrate-rest) and checkpoint-
    branch carry explicit `changes` blocks (empty deletes/resigns/renames: this
    migration moves files, not public symbol signatures).
[x] Every deferral has a forcing function — no "during migration period"/"for
    now" debt. Out-of-scope items (C6, memory-depth) are explicit non-goals in
    [dod.9] with a negative audit check, not deferrals. The session fixes are
    carried forward by [inv:fix-carry-forward], forced by engine-libs guards
    [engine-libs.2-3].

Structure (dag.json / state.json / _shared.md):
[x] Identity is a stable slug — no positional state numbers in any source file;
    legacy P0-P10 appear only as a human cross-reference in notes/state-machine.md.
[x] dag.json holds structure; state.json holds runtime only (status, timestamps,
    transition_log, amendment_log — both empty at publish).
[x] Slug set in dag.json.nodes == slug set in state.json.states (14 slugs); every
    context path exists (gap-check Check 1 + Check 2 green).
[x] Shared definitions centralized in contexts/_shared.md — [def:]/[inv:]/[shape:]
    /[fix:]/[ref:] referenced from contexts, never restated.

Per-state completeness (verified for every work state):
[x] Acceptance criteria section present — ≥1 criterion per added symbol/file in
    mutates, ≥1 negative grep per deleted thing (demos, scaffolder test, reach-in).
[x] Criterion IDs are slug-keyed ([manifest-lib.1] etc.) and match check IDs in
    audit_nx_migration.py (gap-check Check 3 green).
[x] reservations.mutates is populated for every state — every created/changed file
    is listed.
[x] dag.json node artifacts == reservations.mutates exactly (gap-check Check 2
    green for all 14 nodes).
[x] Commit points section present — mandatory post-guard commit + milestone
    checkpoints for the long/code-moving states.
[x] Shared-file merge protocols — N/A: no two states run in parallel and no two
    states mutate the same file (the only shared file, scripts/validate-manifests.ts,
    is mutated only by migrate-rest; type-discovery's shared paths are sequential,
    not parallel — noted in both contexts).

Guards and audits:
[x] Guards are red->green — each guard fails before its state's work (no lib/app/
    target exists yet) and passes only after; the audit guards fail until source
    fixes land.
[x] All criteria are deterministic commands — node/grep/test/pgrep; no prose; the
    A12 + manifest checks use node assertions, reach-in uses grep -rEl.
[x] Final audit has negative checks — audit-final.neg-demos, neg-scaffolder-test,
    memory-core.3/dod.7 (reach-in absent), dod.9 (C6 not claimed).
[x] Final audit has ≥1 live data check — dod.4 (full lifecycle + OS process table
    via pgrep, zero orphans), memory-core.5/C5 (real write+recall), dod.5 (real
    nx affected rebuild).
[x] notes field answers "what do I need to know that the context doesn't make
    obvious" — every dag node has a resume-context notes string (footguns,
    ordering, gitnexus, fix-carry-forward).
[x] dag.json dependency graph matches state-machine.md topology diagram exactly.

Hand off:
[x] Dispatch-or-orchestrate decision made (Step 1b: automatic dispatch = no);
    the "Dispatch Plan with >" line is printed in the planner's hand-off.
```
