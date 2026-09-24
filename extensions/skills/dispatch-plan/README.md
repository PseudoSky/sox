# dispatch-plan

> The dispatcher's playbook for plan-state-machine plans — plans on request, never by default.

## Overview

Used only when the user explicitly asks for a plan, points at `docs/plan/<slug>/`, or confirms
after the dispatcher highlights that an existing plan covers the area. Never turns a direct
request into a plan on its own. Delegates authoring/repair to `plan-builder` and execution to
`plan-orchestrator` after a one-line confirmation gate — `dispatcher` never authors, edits, or
executes a plan itself.

## When to use

Loaded when a plan is named or discovered; otherwise `dispatcher` stays in `dispatch-direct`.

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform.

## Source

Ported verbatim from `categories/dispatch/skills/dispatch-plan/SKILL.md` in the `claude-agents`
catalog (`git@bitbucket.org:id8/agents.git`), v1.4.0, commit `6ffe0db1`. Provenance recorded in
`SKILL.md` frontmatter (`source` / `source-version`).

## Usage

```bash
soxe install dispatch-plan --host claude --scope user
soxe install dispatch-plan --host opencode --scope user
```

## License

MIT
