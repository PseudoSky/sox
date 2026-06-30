<!-- markdownlint-disable MD013 MD033 -->
# Extension Install & Reinjection Model — Implementation Plan

> **Goal:** Make soxe a working cross-scope package-manager/reinjector — declarative *and* code
> extensions install/update/diff/uninstall across scopes into the right host surfaces (claude +
> codex), via a capability engine + provenance ledger + host registry + an MCP wrapper — and ship a
> dogfooded ingestion skill that lets an agent ingest any source on a one-line instruction.
>
> **Spec:** `docs/plans/extension-install-and-reinjection-model.md` + `docs/decisions/0002-extension-install-model.md`
> **Executor:** `sox-active:typescript-pro`
> **Author:** workflow-architect (plan-state-machine v0.8.8)
> **Created:** 2026-06-13
> **Branch:** builds on `feat/nx-migration` (post-C6).

---

## What this directory is

A **resumable state machine** (plan-state-machine skill, workflow 0.8.8). The implementation is
decomposed into work states + audit hold points + a terminal `done`, each keyed by an immutable
**slug**. `dag.json` = structure; `state.json` = runtime. Reordering is cheap; criterion IDs
(`[<slug>.n]`) survive reordering.

```text
.workflow/plans/extension-install-model/
├── README.md · dag.json · state.json · references.json · state-machine.md · final-review.md
├── scripts/   audit_eim.py · gap-check.js · env-pin-check.js
└── contexts/  _shared.md · <slug>.md …
```

---

## How the executor uses this plan

1. Read `state.json` + `dag.json`; find `current_state` (resume if `in_progress`, else first
   `pending` whose `depends_on` are all `done`).
2. Run `node scripts/state-transition.js <plan-dir> <slug> --start`, then read `contexts/<slug>.md`
   + `_shared.md` — the complete work order.
3. Do the work within the declared `mutates`/`read_only` reservations; honor `Commit points`.
4. Run `node scripts/state-transition.js <plan-dir> <slug> --complete --note '<what you verified>'`
   — it runs the guard, captures `end_ref`, runs the audit, advances `current_state`. Never skip it.
5. **One state per session.** Never skip a guard; never leave a plan write uncommitted (R1).

Divergence: *does it change the graph, target-state invariants, or final-audit coverage?* No →
executor-class amendment in place (`state-transition.js --amend --class executor`). Yes → stop and
escalate (planner-class). Pin every guard tool (`./node_modules/.bin/<tool>` / `npx --yes` / a
python script) — never a bare `nx`/`tsc`.

---

## Definition of Done

> Agreed interactively (Step 1a) before any work state. The plan-level contract — *what the whole
> change means when finished and correct.* Each clause carries a numbered id and is proven by ≥1
> final-audit check (`gap-check.js` Check 8 enforces the mapping).

+ `[dod.1]` **Declarative reinjection end-to-end** — a `prompt`/`agent`/`skill` installs to the
  correct host-discovery target for (host, scope); `diff` shows pending changes; a version bump
  `update`s in place; `uninstall` removes it — reality-verified on the real FS for **claude
  (project + user)** and **codex**.
+ `[dod.2]` **MCP install modes** — an `mcp-server` installs as **stdio in `.mcp.json`** (materialize
  + config-merge, `--trust prompt`) AND as a **soxe service** (`run-service`), selected by `--profile`;
  both reality-verified, and an undeclared access is **denied** (C6 holds via `@adhd/sox-mcp-runtime`).
+ `[dod.3]` **Capabilities complete** — each of `file-drop`, `config-merge (json|toml)`,
  `array-merge`, `bin-link`, `run-service`, `materialize` implements **apply / reverse / update(diff)
  / verify**, idempotent + scope+host-aware; shared-file merges reverse cleanly via the ledger.
+ `[dod.4]` **Host registry ships claude + codex** — detectors, scope resolvers, verified surface
  matrices; install host-detection defaults correctly; project-forbidden / managed keys are refused.
+ `[dod.5]` **Provenance ledger** — per scope; project ledger committed + portable; `diff`/`uninstall`
  driven by it; reality test: external edit → `diff` detects drift; `uninstall` removes only
  sox-owned entries.
+ `[dod.6]` **Old system gone** — single-string `install-target` path replaced; `memory-server`
  re-homed onto `@adhd/sox-mcp-runtime` (hand-rolled MCP loop + vendored `compilePolicyFromEnv` gone, grep
  empty); the vestigial `agent` `lifecycle` is **deprecated in the validator** (schema rejects it for
  `agent`).
+ `[dod.7]` **Generators** — `soxe init <type>` exposes the Appendix-A options (`--content @path`/
  `--from`, `--inject`, `--profile`/`--mode`, `--surface`, `--host`), emits the hybrid descriptor,
  born-conformant; `--content @source` fills the body.
+ `[dod.8]` **No regression** — `nx run-many build,lint,test` green; C6 enforcement + its e2e intact;
  `memory-*` still install/run.
+ `[dod.9]` **DoD reconcile** — `DOD.md`/`CLAUDE.md` split "run" into *run (process)* vs
  *placed+discoverable (declarative)*; the declarative half reality-verified.
+ `[dod.10]` **Non-goals** — NOT niche Claude surfaces beyond rules + settings injection; NOT
  OS-kernel sandboxing (C6 scope); NOT hosts beyond claude+codex; **NOT verifying the foreign host
  executed** the content (placement boundary).
+ `[dod.11]` **Reviewer = the founder** — proof: `scripts/audit_eim.py --phase final` exits 0
  (positive + negative + live + conformance) **+ founder approval**. Partial ≠ done.
+ `[dod.12]` **Rollback** — any capability that cannot cleanly reverse via the ledger aborts; a
  half-applied install must be fully reversible.
+ `[dod.13]` **Ingestion skill replaces `docs/ingestion/`** — one dogfooded soxe skill (itself a
  `type: skill` extension) encodes initialize → generalize+author → validate → publish → install →
  enable → remove-old, **delegating per-type/per-operation references**. An agent told "ingest
  `<source>` into sox" loads it and runs the full flow with no bespoke prompts. Reality check:
  ingest one real source (`swarm-cost`) driven solely by the skill; `docs/ingestion/prompts/*` +
  `migration-plan.md` removed (negative grep).

---

## Execution model

> Decided with the requester (Step 1b), before the graph.

+ **Parallel execution:** **yes**, where the DAG allows — `capability-engine` ∥ `host-registry`
  (after `schema-delta`); `mcp-runtime` ∥ `generators` ∥ `install-lifecycle` (after
  `audit-foundation`). Shared mutable files get a merge protocol in both contexts.
+ **Implementer agent(s):**
  + [x] `sox-active:typescript-pro` — all work + audit states (schema/engine/registry/runtime/
    generators/ingestion-skill).
+ **Review:** **yes** — (a) **architect reviews the authored plan before execution starts**
  (pre-dispatch gate, via `architect-reviewer`); (b) audit hold points after **foundation** and
  **enforcement**; (c) **founder** at `audit-final` (`[dod.11]`).
+ **Automatic dispatch:** **no** — resumable hand-off (multi-session; executor ≠ planner; needs
  build/test tooling). Step 8 prints the Dispatch line.

---

## Design invariants

(Full definitions in `contexts/_shared.md` as `[inv:*]`.)

+ **[inv:boundary]** Role B (reinjection) ends at *"right bytes at the host's discovery path for the
  right scope"* — execution is the host's; soxe never asserts the host ran the content.
+ **[inv:ledger-reversible]** Every shared-file write (`config-merge`/`array-merge`) is recorded in
  the per-scope ledger and reversible to the exact key/value; uninstall never touches non-soxe entries.
+ **[inv:host-agnostic-type]** The TYPE is host-agnostic; capability+target are host-specific, resolved
  from the registry. The same type maps to different capabilities per host (agent: file-drop on
  claude, config-merge on codex).
+ **[inv:format-aware-merge]** `config-merge` handles JSON *and* TOML; no json-only assumption.
+ **[inv:never-managed]** soxe never writes the managed tier (claude) or project-forbidden keys (codex).
+ **[inv:c6-holds]** `@adhd/sox-mcp-runtime` enforces declared permissions from policy-env in every spawn
  path (claude-stdio + sox-service); no unenforced path is introduced.
+ **[inv:no-regress]** `nx run-many build,lint,test`, the C6 e2e, and `memory-*` behavior stay green.

---

## Status at a glance

```bash
python3 -c "
import json
b='.workflow/plans/extension-install-model'
dag=json.load(open(b+'/dag.json')); st=json.load(open(b+'/state.json'))
print('current:', st['current_state'])
for slug,node in dag['nodes'].items():
    print(f\"  [{node['phase']}] {slug}: {st['states'].get(slug,{}).get('status','?')}\")
"
```
