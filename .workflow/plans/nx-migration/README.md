<!-- markdownlint-disable MD013 MD033 -->
# Nx + self-hosting migration — Implementation Plan

> **Goal:** Adopt Nx for the undifferentiated monorepo/build/generator/boundary
> layer, keep the novel layer (manifest contract, install/cascade, host runtime,
> registry, the `sox` CLI) custom, and make `sox` a literal self-hosted
> extension #0 — delivering born-conformant authoring + a scaled, cached build
> so many extensions of every type can be added rapidly.
>
> **Spec:** `docs/decisions/0001-nx-and-self-hosting.md` (why/what) ·
> `docs/plans/nx-self-hosting-migration.md` (how) · `DOD.md` (the bar)
> **Executor:** `sox-active:typescript-pro`
> **Author:** planner (workflow-planner, plan-state-machine)
> **Created:** 2026-06-11

---

## What this directory is

A **resumable state machine**. The implementation is decomposed into work states
plus audit hold points and a terminal `done`. Each state is a self-contained work
order keyed by an immutable **slug**. Structure (`dag.json`) and runtime
(`state.json`) are separate files so reordering is cheap and progress is durable.

```text
.workflow/plans/nx-migration/
├── README.md          ← this file (orientation, DoD, execution model, invariants)
├── dag.json           ← STRUCTURE: nodes (slug → phase, depends_on, guard, artifacts, changes, context)
├── state.json         ← RUNTIME: current_state, per-slug status+timestamps, transition/amendment logs
├── references.json    ← REFERENCE PATTERN CATALOG: [ref:] idioms (anchor + rule + audit_check)
├── state-machine.md   ← human render of dag.json
├── final-review.md    ← filled Step-7 checklist (publish gate)
├── scripts/
│   ├── audit_nx_migration.py   ← phase-scoped audit runner (foundation/engine/final)
│   └── gap-check.js            ← deterministic gap check (publish gate)
└── contexts/
    ├── _shared.md     ← centralized definitions + [ref:] fallbacks (referenced, never restated)
    └── <slug>.md      ← one work-order context per state
```

Identity is the slug. Ordering comes from `dag.json` (`depends_on`), so inserting
or splitting a state never renumbers anything; criterion IDs (`[<slug>.n]`) stay
stable. The legacy P0–P10 numbers map onto immutable slugs (see
`state-machine.md`); sequence is the DAG, not the numbers.

---

## How the executor uses this plan

1. **Read `state.json` and `dag.json`.** Find `current_state`. If `in_progress`,
   resume it. Otherwise pick the first `pending` node whose `depends_on` are all
   `done`.
2. **Read that state's context file** (`dag.json` node's `context`) plus
   `contexts/_shared.md` for referenced definitions. The context is the complete
   work order.
3. **Do the work.** Respect reservations — never mutate files outside `mutates`.
   For the code-moving states (`engine-libs`, `memory-core`, `migrate-rest`),
   run GitNexus impact/context **before** moving any symbol and
   `gitnexus detect-changes` **after** (see those contexts).
4. **Run the guard.** The state may not advance until the guard exits 0. Acceptance
   checks capture `$?` directly — **never pipe** a command whose exit code is tested.
5. **Update runtime:** set status `done`, record timestamps, append the transition
   log, set `current_state` to the next eligible node.
6. **Commit (R1).** Every write to a plan file is immediately committed. Honor the
   `Commit points` section in the context for intermediate checkpoints (R2).
7. **Stop at a state boundary.** One state per session.

**Never skip a guard. Never leave a plan write uncommitted.**

### If reality diverges from the work order

Classify: *does it alter the dependency graph, target-state invariants, or
final-audit coverage?* **No** → executor-class amendment (edit in place, keep
`dag.json`/`state.json`/`state-machine.md`/context in sync, append `amendment_log`,
commit, continue). **Yes** → planner-class: stop, record the reason in
`amendment_log`, escalate to the planner. Never reshape the graph yourself.

---

## Definition of Done

> Agreed with the requester (the **founder**, the human user) and supplied in the
> dispatch invocation — the plan-level success contract: *what it means for the
> whole change to be finished and correct.* Distinct from per-state acceptance
> criteria. Scope is **D5** of ADR-0001: the in-scope clauses below cover A1,
> A12, B1–B4, C7 + no-regression of currently-green items; **C6 + memory
> semantic depth are explicit non-goals.** Each clause is proven by ≥1
> final-audit check (the `dod.N` check named in parentheses); `gap-check.js`
> Check 8 verifies the map.

- `[dod.1]` **A1 — born-conformant `init`** — `sox init <type> <id>` scaffolds
  an extension that validates against `libs/manifest` with **zero hand-edits**,
  for every active type. (Proven by audit check `dod.1`.)
- `[dod.2]` **A12 — dual flag forms** — both `--flag value` and `--flag=value`
  parse correctly and match the documented `--help` output. (Proven by audit
  check `dod.2`.)
- `[dod.3]` **B1 — born-conformant for all active types** — `init <type>` emits
  conformant output (self-description, per-package `tsconfig`,
  `keywords`/`author`) for all 6 active types (`prompt` parked). (Proven by
  audit check `dod.3`.)
- `[dod.4]` **B2 — full lifecycle, repeatable, no manual fixups** — a freshly
  scaffolded extension passes `init → build → validate → install → run` and
  tears down with **zero orphan processes** verified against the OS process
  table. (Proven by audit check `dod.4`.)
- `[dod.5]` **B3 — build scales** — the build graph is incremental/cached:
  touching one package rebuilds only the affected projects (`nx affected`).
  (Proven by audit check `dod.5`.)
- `[dod.6]` **B4 — adding an extension never red-bars validate** — scaffolding a
  new extension leaves `sox validate` green across the tree. (Proven by audit
  check `dod.6`.)
- `[dod.7]` **C7 — shared code without reach-in** — an extension reuses shared
  internal code via a `libs/*` internal library; **zero** cross-extension
  `../**/dist/` reach-in imports remain, enforced by module-boundary lint.
  (Proven by audit check `dod.7`.)
- `[dod.8]` **No regression of currently-green items** — every item green before
  the migration (A2–A11, C1–C5) stays green; the full suite passes. (Proven by
  audit check `dod.8`.)
- `[dod.9]` **Non-goals (explicitly NOT delivered)** — C6 (runtime permission
  enforcement) and memory semantic depth (real embeddings, LLM organizer
  enrichment) are **not** claimed done; no check asserts them complete. (Proven
  by audit check `dod.9`, which asserts they remain unclaimed/out of scope.)
- `[dod.10]` **Reviewer + rollback** — the **founder** accepts "done"; proof =
  the final-audit script exits 0 from a clean slate on `feat/nx-migration` (real
  process table + real artifacts, not self-reported test output) and the founder
  approves. Partial completion is **not** done; the abort condition is "any D5
  in-scope check red" → repair forward, never merge. (Proven by audit check
  `dod.10`.)

---

## Execution model

> Supplied by the requester in the dispatch (Step 1b). These choices steer
> topology, file ownership, audit placement, and hand-off.

- **Parallel execution:** **yes, where the DAG genuinely allows** — serial
  otherwise. The `engine` phase is serial (`engine-libs → sox-extension`). The
  `convergence` phase is mostly serial by data dependency
  (`type-discovery → memory-core → migrate-rest → ci-release`). No two states
  share a mutable file, so no merge protocol is required; any future parallel
  insertion must add one.
- **Implementer agent(s):**
  - [x] `typescript-pro` — every work state (one executor subagent per state).
- **Review:** **yes** — reviewer is the **founder**, after `audit-final`
  (`audit-final` is the mandatory hold point; the founder's acceptance follows a
  green run from a clean slate).
- **Automatic dispatch:** **no** — hand off with the Dispatch line (Step 8).
  Execution is resumable and orchestrated by `workflow-architect`; the executor
  (`typescript-pro`) is a different agent than the planner.

---

## Design invariants

These hold throughout the migration, not just at the end. Full definitions live
in `contexts/_shared.md`.

- **[inv:nx-dev-only]** — Nx is **dev-time only**; never a consumer/runtime
  dependency. See `[ref:nx-never-runtime-dep]`.
- **[inv:nx-free-core]** — `libs/authoring`'s `scaffold()` core is nx-free so
  `sox init` works without nx. See `[ref:nx-free-authoring-core]`.
- **[inv:scaffold-parity]** — `sox init` == `@adhd/sox-nx:extension` (byte-identical
  output from one `scaffold()` core). See `[ref:scaffold-parity]`.
- **[inv:fix-carry-forward]** — all work is currently uncommitted incl. this
  session's fixes; `checkpoint-branch` commits + tags them, and every later state
  carries fixes forward — **never re-grab pre-fix code** from before the tag.
- **[inv:manifest-source]** — `libs/manifest` is the single source of truth for
  "conformant". See `[ref:manifest-single-source]`.
- **[inv:ordering]** — `manifest-lib` before `authoring-lib`; engine libs before
  wiring `sox-extension`; generate shells → port logic → wire/verify last.

---

## Status at a glance

```bash
python3 -c "
import json
dag = json.load(open('.workflow/plans/nx-migration/dag.json'))
st  = json.load(open('.workflow/plans/nx-migration/state.json'))
print('current:', st['current_state'])
for slug, node in dag['nodes'].items():
    status = st['states'].get(slug, {}).get('status', '?')
    print(f'  [{node[\"phase\"]}] {slug}: {status}')
"
```
