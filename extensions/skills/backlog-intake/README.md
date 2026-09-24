# backlog-intake

> The dispatcher's intake step — burn the backlog while you're there.

## Overview

Before decomposing any direction, asks `backlog-operator` for related backlog items (by symbol,
path, error text) and applies a fixed inclusion policy: same root cause → recommend folding in;
small and in scope → fold in without asking; old or unverified → attach to the related executor as
check-and-confirm; unrelated → leave.

## When to use

Runs once per direction, inside `dispatch-direct`/`dispatch-triage`. Loaded at intake; never files
new items itself (that's `dispatch-triage`'s job).

## Dependencies

Declared in `extension.json` → `dependencies`: `backlog-operator`, the agent every backlog
operation in this skill routes through.

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform.

## Source

Ported verbatim from an external dispatch-agent catalog, v1.4.0.

## Usage

```bash
soxe install backlog-intake --host claude --scope user
soxe install backlog-intake --host opencode --scope user
```

## License

MIT
