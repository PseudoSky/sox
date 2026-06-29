# memory-usage

> memory-usage extension

## Overview

A declarative how-to skill teaching agents to use the sox graph-memory system via the
`memory_*` MCP tools (served by `memory-server`, a sibling member of `sox-memory-bundle`):
recall prior knowledge before researching, write durable findings, and edit them in place.
The full how-to lives in [`SKILL.md`](./SKILL.md); the per-tool schemas live in
`memory-server`'s `CLAUDE.md`.

## When to use

The host injects this skill when an agent is about to research, decide, or answer — to
remind it to **recall first** — and when it produces a durable, sourced finding worth
**writing** for the next agent. Not for transient chatter or project-secret values.

## Runtime

`declarative` — the host reads `SKILL.md` and injects it at invocation time.
Install target resolved from host-registry at install time.

## Usage

```bash
sox install memory-usage
```

## License

MIT