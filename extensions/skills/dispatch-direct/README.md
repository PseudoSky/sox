# dispatch-direct

> The dispatcher's default playbook — direction in, dispatched and verified work out.

## Overview

Turns explicit user direction (a task, a list, a port, a refactor, a PR) into a Task tree,
dispatches `00-active` executors in the background under `dispatch-contract` briefs, verifies each
outcome from git/tests/state, review-gates and merges, and keeps the Task list and backlog in
sync.

## When to use

Loaded by `dispatcher` when the user gives direction that is not an issue report (that's
`dispatch-triage`) and not a plan reference (that's `dispatch-plan`). Explicit direction is
followed as given.

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform.

## Source

Ported verbatim from `categories/dispatch/skills/dispatch-direct/SKILL.md` in the `claude-agents`
catalog (`git@bitbucket.org:id8/agents.git`), v1.4.0, commit `6ffe0db1`. Provenance recorded in
`SKILL.md` frontmatter (`source` / `source-version`).

## Usage

```bash
soxe install dispatch-direct --host claude --scope user
soxe install dispatch-direct --host opencode --scope user
```

## License

MIT
