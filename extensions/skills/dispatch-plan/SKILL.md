---
name: dispatch-plan
description: The dispatcher's playbook for plan-state-machine plans — used only when the user explicitly asks for a plan, points at docs/plan/<slug>/, or confirms after the dispatcher highlights that an existing plan covers the area. It never turns a direct request into a plan on its own. Delegates authoring/repair to plan-builder and execution to plan-orchestrator after a one-line confirmation; the dispatcher never authors, edits, or executes a plan itself. Load when a plan is named or discovered; otherwise stay in dispatch-direct.
source: git@bitbucket.org:id8/agents.git#categories/dispatch/skills/dispatch-plan/SKILL.md
source-version: v1.4.0 (6ffe0db1)
---

# dispatch-plan — plans on request, never by default

The user owns the choice to plan. This playbook exists so that when they make
it, the dispatcher hands off cleanly to the agents that own plans — and so that
when they do not, the existence of a plan is *mentioned*, not *imposed*.

## Entry conditions (any one)

- The user says "plan", "make a plan", "use the plan", "execute the plan", or names a slug/path.
- `Glob docs/plan/*/state.json` finds a plan whose slug or `README` plausibly covers the current direction — in which case the dispatcher says **one line**: "`docs/plan/<slug>/` covers this (state: `<current_state>`). Say the word to use it; otherwise I'll continue on the task list." — and continues on the task list unless told otherwise.

## Confirmation gate (always, before any plan agent is dispatched)

Ask exactly one question with the concrete action named:

- "Author a new plan for `<direction>` with plan-builder?"
- "Repair/update `docs/plan/<slug>/` with plan-builder for `<defect>`?"
- "Execute `docs/plan/<slug>/` with plan-orchestrator from `<current_state>`?"

No confirmation, no dispatch. A confirmation for one action is not a
confirmation for the others.

## Steps

1. **Discover.** `Glob docs/plan/*/state.json`; `Read` `state.json` for `current_state`, `claimed_by`/`claimed_at`, and the status map of any candidate. Report claimed plans as claimed (by whom, how old); never override a live claim.
2. **Confirm** (gate above).
3. **Delegate.**
   - Author/repair → dispatch `plan-builder` (opus) with the direction or defect list inline, per `dispatch-contract`; done-state: the plan dir exists / the named check passes.
   - Execute → dispatch `plan-orchestrator` (opus) with the plan path; done-state: `state.json.current_state` advanced or a halt with a proposed fix. Its orchestration ledger is the record; the dispatcher does not duplicate it.
4. **Track.** One Task entry per delegated action; `backlog-operator: transition` any linked items. Plan bookkeeping (`plan` fields) is set by the plan agents, not by the operator on the dispatcher's behalf.
5. **Verify.** Read `state.json` (execution) or the plan dir (authoring) directly; the plan agent's report is a pointer.
6. **Return.** Halts from `plan-orchestrator` are surfaced verbatim with its proposed fix; the dispatcher does not re-triage them (that agent already did).

## Hard rules

- Never author, edit, or execute a plan directly; never hand-edit `state.json`/`dag.json`.
- Never enter this playbook on discovery alone — highlight, then wait.
- Never dispatch a plan agent without the confirmation gate.
- Never take over a live claim.
