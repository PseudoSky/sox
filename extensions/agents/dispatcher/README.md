# dispatcher

> Live orchestrator that lists and drives token-optimized dispatch of already-authored
> plan-state-machine plans.

## Overview

The dispatcher takes an **already-authored** `plan-state-machine` plan (a directory with
`dag.json` + `state.json` + `contexts/` + guards) and drives it to completion — state by state,
wave by wave — while spending the fewest tokens that still clears every guard. It is the
orchestrator role in the skill's three-role vocabulary:

- `plan-builder` authors the plan (demo-driven, research-informed);
- the executor does one state and stops;
- **dispatcher** runs the advance/retry/escalate/halt loop, choosing *who* executes each state
  from the available executor roster, at *what* model/effort tier, with *how little* context.

The dispatcher never authors plans, never hand-edits `state.json`/`dag.json` (the scripts own
those), and never invents executor capabilities.

## Modes

- `list` — enumerate discoverable plan-state-machine plans with their current state and status
  rollup. Read-only, one-shot. No dispatch.
- `execute` — drive the named plan to completion via the wave-by-wave dispatch loop. The
  orchestrate flow.

## When to use

Use this agent when a plan-state-machine plan has already been authored under `docs/plan/` and
needs to be executed to completion — "list plans", "execute plan <path|slug>".

Do **not** use it to author plans (that is `plan-builder`), or to do a single state's work (that
is the executor).

## Runtime

`declarative` — the host reads `dispatcher.md` and injects it as a subagent definition.
No process is spawned. Install target resolved from host-registry at install time.

## Source

The opencode-host definition was migrated from
`~/.config/opencode/agents/dispatcher.md` (itself adapted from
`~/dev/ai/claude-agents/categories/workflow/agents/plan-orchestrator.md` v1.4.0).
Provenance recorded in `extension.json` → `install.source`.

## Usage

```bash
soxe install dispatcher --host claude --scope user
soxe install dispatcher --host opencode --scope user
```

## License

MIT
