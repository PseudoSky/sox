# dispatch-status

> The dispatcher's read-only playbook — what is true right now.

## Overview

Answers "where are we" for the current run — in-flight and finished dispatches with their
verified state, Task-list status, backlog items touched this run, open plans and claims, and
unrecorded transitions. Also run before every `dispatcher` return to prove nothing is orphaned.
Dispatches nothing, writes nothing.

## When to use

Loaded on "status", "what's in flight", "what's left", or at close of every `dispatcher` run.

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform.

## Source

Ported verbatim from an external dispatch-agent catalog, v1.4.0.

## Usage

```bash
soxe install dispatch-status --host claude --scope user
soxe install dispatch-status --host opencode --scope user
```

## License

MIT
