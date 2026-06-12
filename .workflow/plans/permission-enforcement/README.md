<!-- markdownlint-disable MD013 MD033 -->
# C6 — Runtime Permission Enforcement — Implementation Plan

> **Goal:** Make declared `permissions` (`fs.read/write`, `network.outbound`,
> `socket.paths`) **enforced at runtime** — an extension attempting access
> outside its declared allowlist is denied/blocked — closing DoD **C6**, with
> the enforcement level scoped honestly per extension type.
>
> **Spec:** `DOD.md` (C6) + `docs/architecture-audit-v2.md` (NEW-4 / §Part 7)
> **Executor:** `sox-active:typescript-pro`
> **Author:** workflow-planner (plan-state-machine)
> **Created:** 2026-06-12
> **Branch:** builds on `feat/nx-migration`; first state branches off it (e.g.
> `feat/c6-permissions`). nx is **dev-time only** (build/test orchestration); it
> ships no runtime behaviour.

---

## What this directory is

A **resumable state machine**. The implementation is decomposed into 5 work
states (`consolidate-legacy`, `policy-core`, `process-boundary`, `inproc-policy`,
`mcp-path-guard`) plus 3 audit hold points and a terminal `done`. Each state is a
self-contained work order keyed by an immutable **slug**. Structure
(`dag.json`) and runtime (`state.json`) are separate files so reordering is
cheap and progress is durable.

```text
.workflow/plans/permission-enforcement/
├── README.md          ← this file (DoD + execution model + invariants)
├── dag.json           ← STRUCTURE: nodes (slug → phase, depends_on, guard, artifacts, context, changes)
├── state.json         ← RUNTIME: current_state, per-slug status+timestamps, transition/amendment logs
├── references.json    ← REFERENCE PATTERN CATALOG ([ref:] idioms as data)
├── state-machine.md   ← human render of dag.json
├── final-review.md    ← filled Step-7 checklist (publish gate)
├── scripts/
│   ├── gap-check.js   ← deterministic gap check (publish gate; run with --discover)
│   └── audit_c6.py    ← phase-scoped audit runner (foundation | enforcement | final)
└── contexts/
    ├── _shared.md     ← centralized definitions + [ref:] fallbacks
    ├── consolidate-legacy.md
    ├── policy-core.md
    ├── audit-foundation.md
    ├── process-boundary.md
    ├── inproc-policy.md
    ├── mcp-path-guard.md
    ├── audit-enforcement.md
    └── audit-final.md
```

Identity is the slug. Ordering comes from `dag.json` (`depends_on`), so inserting
or splitting a state never renumbers anything; criterion IDs (`[<slug>.n]`) stay
stable.

---

## How the executor uses this plan

1. **Read `state.json` and `dag.json`.** Find `current_state`. If `in_progress`,
   resume it. Otherwise pick the first `pending` node whose `depends_on` are all
   `done`.
2. **Read that state's context file** (the node's `context`) plus `_shared.md`
   for referenced definitions. The context is the complete work order.
3. **Do the work.** Respect reservations — never mutate files outside `mutates`.
4. **Run the guard.** The state may not advance until the guard exits 0. Guards
   are red→green: run the guard FIRST to see it fail, then do the work.
5. **Update runtime:** in `state.json` set status `done`, record timestamps,
   append `transition_log`, set `current_state` to the next eligible node.
6. **Commit (R1).** Every write to a plan file is immediately committed. Honor
   the `Commit points` section of the context for work-product commits (R2).
7. **Stop at a state boundary.** One state per session (resumable hand-off —
   automatic dispatch is **no**).

**Never skip a guard. Never leave a plan write uncommitted. Acceptance is
verified against REALITY** — actually attempt a forbidden fs/socket access
against a real spawned process and confirm it is blocked; a record/log check is
NOT acceptance (see `[inv:reality]`).

### If reality diverges from the work order

Classify: *does it alter the dependency graph, the target-state invariants, or
final-audit coverage?*

- **No** — make the local change in place (expand `artifacts`/`mutates`, add a
  criterion plus its matching audit check, fix a wrong guard, update a
  `_shared.md` definition once), keep `dag.json` / `state.json` /
  `state-machine.md` / the context file in sync, append an `amendment_log`
  entry, **commit**, continue.
- **Yes** — stop, record the reason in `amendment_log`, escalate to the planner.
  Do not reshape the graph yourself.

---

## Definition of Done

> Agreed with the requester (the founder) and supplied in the invocation
> (Step 1a, non-interactive subagent run). This is the plan-level success
> contract. Each clause is IDed `[dod.N]` and **proven by ≥1 final-audit check**
> in `scripts/audit_c6.py --phase final` — `gap-check.js` Check 8 verifies the
> mapping.

- `[dod.1]` **Outcome — declared access works (positive).** A real spawned
  `memory-server` whose declared `permissions.fs` allows `~/.memory/**`,
  invoked with `db_path` **inside** `~/.memory/**`, performs `memory_write`
  successfully against a real on-disk SQLite store. Enforcement does not break
  legitimate, declared access. Proven by `[audit-final.positive-fs]`.
- `[dod.2]` **Outcome — undeclared access is blocked (negative, REQUIRED).** The
  same real spawned `memory-server`, invoked with `db_path` **outside**
  `~/.memory/**` (e.g. `/tmp/sox-c6-evil.db`), is **denied at runtime**: the
  tool call returns an `isError`/permission-denied result AND no database file
  is created at the undeclared path. This is verified against reality (a live
  process, a real filesystem check), never a log/record assertion. Proven by
  `[audit-final.negative-fs]` and `[audit-final.negative-no-file]`.
- `[dod.3]` **Per-type enforcement level is explicit and achieved.** Each
  extension type's enforcement level is named and proven, with no unanswered
  trigger phrases (see `[inv:per-type]`):
  - **Spawned process types** (`mcp-server`; and any `command`/`hook` whose
    runtime is `shell`/`python`, i.e. spawned) — **HARD**: process-boundary
    bounding (cwd restriction, env scrub to a declared policy env, fs-path
    allowlist enforced in-process at the resource sink, socket/network egress
    allowlist) — undeclared access denied/blocked.
  - **In-process / declarative types** (`agent`, `skill`, `command`/`hook`
    loaded via in-process `import()`, `prompt`) — **SOFT**: declaration +
    activation-time policy object attached to the handle + an audit log of every
    access decision. **No hard OS isolation** (stated as a non-goal in
    `[dod.6]`). The forcing function for "soft is the ceiling for these types"
    is `[audit-final.per-type-soft]`, which asserts the documented level matches
    the delivered level.
  Proven by `[audit-final.per-type-hard]` and `[audit-final.per-type-soft]`.
- `[dod.4]` **No regression.** Everything currently green stays green: the full
  test suite (the audit-v2 baseline reports 344/377 tests; this plan freezes the
  count captured in `[inv:no-regress]`), the lifecycle end-to-end
  (`nx run host-runtime:test-e2e` / `tools/test-e2e-lifecycle.js`), and the
  delivered behaviour of C1–C5 and C7. Proven by `[audit-final.regress-suite]`
  and `[audit-final.regress-e2e]`.
- `[dod.5]` **Reviewer — the founder accepts.** "Done" is accepted by the
  **founder**. Required proof: `scripts/audit_c6.py --phase final` exits 0
  against the real codebase (positive + both negative + per-type + regression
  checks) AND the founder approves the change. Proven by
  `[audit-final.reviewer-gate]` (the audit script exits 0 = the machine half of
  the gate; founder approval is the human half recorded in the transition log).
- `[dod.6]` **Non-goals (bounds scope).** This plan does **NOT** deliver
  OS-kernel sandboxing (seccomp/landlock/AppArmor/containers/namespaces), and
  does **NOT** deliver hard OS isolation for in-process/declarative types — those
  types are bounded by declaration + audit only. It does NOT alter the
  `permissions` schema contract (`libs/manifest` shapes are stable inputs). It
  does NOT fix the unrelated open audit findings (NEW-1 recall SQL bug, NEW-2
  typecheck, etc.) beyond not regressing what is green. Proven by
  `[audit-final.nongoal-no-kernel-sandbox]` (negative: no kernel-sandbox / native
  isolation dependency was introduced).

---

## Execution model

> Settled with the requester in the invocation (Step 1b).

- **Parallel execution:** **yes, where the DAG allows.** `process-boundary` and
  `inproc-policy` both depend only on `policy-core` and mutate disjoint files —
  they may run in parallel. `mcp-path-guard` depends on `process-boundary` (it
  consumes the policy-env contract). No two states share a mutable file, so no
  merge protocol is required (verified in Step 6).
- **Implementer agent(s):**
  - [x] `sox-active:typescript-pro` — all work states (`policy-core`,
    `process-boundary`, `inproc-policy`, `mcp-path-guard`) and all audit states.
- **Review:** **yes** — reviewer **the founder**, after `audit-final` (the
  terminal hold point). Proof = `audit_c6.py --phase final` exits 0 +
  founder approval (`[dod.5]`).
- **Automatic dispatch:** **no** — resumable hand-off. The executor
  (`typescript-pro`) is a different agent than the planner, work spans sessions,
  and guards need build/test tooling the planner did not run. The planner stops
  at the Dispatch line (Step 8).

---

## Design invariants

These hold throughout the migration, not just at the end. Full definitions in
`contexts/_shared.md`.

- **[inv:reality]** Acceptance is verified against reality — a real spawned
  process and a real filesystem/socket check — never a self-reported log or
  record. The C6 negative check MUST attempt a forbidden access and observe the
  denial + the absence of the side effect.
- **[inv:no-regress]** No state may red-bar anything currently green: the test
  suite, the lifecycle e2e, or C1–C5/C7 delivered behaviour. Every state's guard
  includes (directly or via the next audit) the regression suite.
- **[inv:carry-fixes]** All prior session fixes are carried forward unchanged
  (`[def:session-fixes]`): `fireIsolated` (DEFECT-1), enable-reactivation,
  stop-via-supervisor, `expandTilde` (A5), `resolveExtensionDir` no-stat. No
  state may regress these.
- **[inv:dev-time-nx]** nx is a dev-time build/test orchestrator only. No state
  introduces an nx runtime dependency into shipped extension or host code.
- **[inv:per-type]** Enforcement level is type-dependent and documented per type
  (`[dod.3]`). A claim of "enforced" for an in-process/declarative type that
  implies OS isolation is a defect; the honest level for those types is
  declaration + audit.
- **[inv:schema-stable]** The `permissions` schema contract in `libs/manifest`
  (`ManifestPermissions`) is a stable READ-ONLY input. Enforcement consumes the
  declaration; it does not change the declaration shape.

---

## Status at a glance

```bash
python3 -c "
import json, pathlib
base = pathlib.Path('.workflow/plans/permission-enforcement')
dag = json.load(open(base/'dag.json'))
st  = json.load(open(base/'state.json'))
print('current:', st['current_state'])
for slug, node in dag['nodes'].items():
    status = st['states'].get(slug, {}).get('status', '?')
    print(f'  [{node[\"phase\"]}] {slug}: {status}')
"
```

Run the publish gate (from repo root):

```bash
node .workflow/plans/permission-enforcement/scripts/gap-check.js \
  .workflow/plans/permission-enforcement --discover
```
