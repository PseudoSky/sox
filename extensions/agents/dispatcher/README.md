# dispatcher

> Orchestration authority that never executes.

## Overview

Decomposes ad-hoc user direction into a Task tree, dispatches `00-active` executors in the
background under `dispatch-contract` briefs, verifies every outcome from git/tests/state (never
from a subagent's report), review-gates every merge, and keeps the live Task list and the backlog
graph (via `backlog-operator`) in sync. Playbooks — `dispatch-direct`, `dispatch-triage`,
`dispatch-plan`, `dispatch-status`, `backlog-intake` — load on demand and are never forced;
explicit user direction always wins.

Unlike `plan-builder` (authors document-based `docs/plan/<slug>/` plans) or `architect` (designs
and returns the plan structure), dispatcher takes ad-hoc direction. Plans are crafted **into the backlog** — `product` prioritizes, `architect` returns the structured items
with their `part_of` / `blocks` edges, `backlog-operator` files and links them, and dispatcher
executes from the **ready view**. An existing plan is surfaced in one line.

## When to use

Use this agent for direction that is not an issue report (that's the `dispatch-triage` playbook)
and not a plan reference (that's `dispatch-plan`) — a task, a list, a bug report, a PR. It does
**not** design the plan: `product` prioritizes and `architect` returns the
structured items; the dispatcher has `backlog-operator` land them and executes the ready view.

## Runtime

`declarative` — the host reads the prose body (`dispatcher.md`) and renders the host-specific
header from `extension.json`'s `agent`/`render` blocks at install time. No process is spawned.

The agent is multi-host: `install.hosts` covers `claude` and `opencode`.

## Dependencies

Declared in `extension.json` → `dependencies`: the six dispatch skills it loads on demand —
`dispatch-contract` (always loaded before the first dispatch), `dispatch-direct`,
`dispatch-triage`, `dispatch-plan`, `dispatch-status`, and `backlog-intake`.

## Source

Ported verbatim (body unchanged) from an external dispatch-agent catalog, v1.4.0.

## Usage

```bash
soxe install dispatcher --host claude --scope user
soxe install dispatcher --host opencode --scope user
```

## License

MIT
