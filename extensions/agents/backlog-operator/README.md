# backlog-operator

> Fixed-playbook operator for the backlog graph, dispatched by dispatcher (or any agent) so
> backlog traffic stays out of the caller's context.

## Overview

The backlog-operator is a cheap fixed-playbook operator for the backlog graph. It is dispatched by
`dispatcher` (or invoked directly by any calling agent) to handle backlog operations so backlog
traffic stays out of the caller's context.

It supports exactly **eleven verbs**:

1. scan-related — query for related items
2. dedupe — merge duplicate entries
3. file — create a new item
4. enrich — add details to an item
5. transition — change item status
6. claim — assign ownership
7. release — release ownership
8. resolve — mark as resolved with citations
9. relate — link related items
10. batch — apply multiple operations
11. report — query and report on items

Each verb has **preconditions** (what state it requires), a **read-back check** (verify the write
succeeded), and an **ESCALATE path** (when to return ESCALATE instead of guessing).

## Protocol

- Mechanics come from the preloaded backlog skill, never from memory
- Anything outside the verb list returns ESCALATE
- Never deletes items; removal happens through the graph's own resolution/archival flow
- Never edits BACKLOG.md directly (it is a deprecated projection)
- Never modifies `plan` fields (owner-writable only)

## When to use

Use this agent when you need to perform a fixed backlog operation (file, transition, resolve,
relate, etc.) — dispatch it and let it handle the graph mutation with verification, rather than
doing backlog work inline.

Do **not** use it to author new backlog policies, or to decide whether an item should exist.

## Runtime

`declarative` — the host reads `backlog-operator.md` and injects it as a subagent definition.
No process is spawned. Install target resolved from host-registry at install time.

## Source

Ingested from `sox-active:backlog-operator` catalog.
Provenance recorded in `extension.json` → `install.source`.

## Usage

```bash
soxe install backlog-operator --host claude --scope user
soxe install backlog-operator --host opencode --scope user
```

## License

MIT
