# dispatch-triage

> The dispatcher's playbook for an issue report — evidence before anything.

## Overview

A bug, a red test, a reviewer finding, an executor's out-of-scope observation, or any
"pre-existing / unrelated / skipped" claim. Root-causes with `debugger` first (evidence, never the
dispatcher's own guess), plans the fix with `architect-reviewer` when the decision is technical,
then implements through `dispatch-direct` and review-gate. Nothing is filed to the backlog or
surfaced to the user as fact until triage has evidence.

## When to use

Loaded on any issue report; the user's explicit direction still overrides (dispatcher rule 0).

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform.

## Source

Ported verbatim from `categories/dispatch/skills/dispatch-triage/SKILL.md` in the `claude-agents`
catalog (`git@bitbucket.org:id8/agents.git`), v1.4.0, commit `6ffe0db1`. Provenance recorded in
`SKILL.md` frontmatter (`source` / `source-version`).

## Usage

```bash
soxe install dispatch-triage --host claude --scope user
soxe install dispatch-triage --host opencode --scope user
```

## License

MIT
