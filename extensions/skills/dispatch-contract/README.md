# dispatch-contract

> The brief every dispatcher dispatch carries and the return contract every executor must satisfy.

## Overview

Defines the brief template (goal, observable done-state, scope, tools/model, budget, return shape,
check-and-confirm items), the structured return block, the operator request shape, and the
one-line-per-dispatch telemetry format. Not a playbook — the other `dispatch-*` skills all assume
it. Loaded once per `dispatcher` session before the first dispatch.

## When to use

Loaded by the `dispatcher` agent at Step 0 of every session, and whenever assembling a brief,
reading a return, or writing a telemetry row.

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform. Ships two templates:
`templates/brief.md` and `templates/telemetry-row.md`.

## Source

Ported verbatim from `categories/dispatch/skills/dispatch-contract/SKILL.md` in the `claude-agents`
catalog (`git@bitbucket.org:id8/agents.git`), v1.4.0, commit `6ffe0db1`. Provenance recorded in
`SKILL.md` frontmatter (`source` / `source-version`).

## Usage

```bash
soxe install dispatch-contract --host claude --scope user
soxe install dispatch-contract --host opencode --scope user
```

## License

MIT
