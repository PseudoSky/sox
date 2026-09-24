# dispatcher

> Orchestration authority that never executes.

## Overview

Decomposes ad-hoc user direction into a Task tree, dispatches `00-active` executors in the
background under `dispatch-contract` briefs, verifies every outcome from git/tests/state (never
from a subagent's report), review-gates every merge, and keeps the live Task list and the backlog
graph (via `backlog-operator`) in sync. Playbooks — `dispatch-direct`, `dispatch-triage`,
`dispatch-plan`, `dispatch-status`, `backlog-intake` — load on demand and are never forced;
explicit user direction always wins.

Unlike `plan-orchestrator` (drives an already-authored `docs/plan/<slug>/` plan wave-by-wave) or
`workflow-architect` (routes workflow-plugin engagements), dispatcher takes ad-hoc direction and
only proposes a plan when one already covers the area — it hands execution of a named plan to
`plan-orchestrator` rather than re-implementing its loop.

## When to use

Use this agent for direction that is not an issue report (that's the `dispatch-triage` playbook)
and not a plan reference (that's `dispatch-plan`) — a task, a list, a bug report, a PR. Do **not**
use it to execute an already-authored plan-state-machine plan directly (that is `plan-orchestrator`).

## Runtime

`declarative` — the host reads the prose body (`dispatcher.md`) and renders the host-specific
header from `extension.json`'s `agent`/`render` blocks at install time. No process is spawned.

The agent is multi-host: `install.hosts` covers `claude` and `opencode`.

## Dependencies

Declared in `extension.json` → `dependencies`: the six dispatch skills it loads on demand —
`dispatch-contract` (always loaded before the first dispatch), `dispatch-direct`,
`dispatch-triage`, `dispatch-plan`, `dispatch-status`, and `backlog-intake`.

## Source

Ported verbatim (body unchanged) from
`categories/dispatch/agents/dispatcher.md` in the `claude-agents` catalog
(`git@bitbucket.org:id8/agents.git`), v1.4.0, commit `6ffe0db1`. Provenance recorded in
`extension.json` → `source` / `source-version`.

## Usage

```bash
soxe install dispatcher --host claude --scope user
soxe install dispatcher --host opencode --scope user
```

## License

MIT
