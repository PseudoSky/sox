# sox-memory (graph memory subsystem)

> Install this when you want the full sox-memory graph-memory subsystem in one command.

## Overview

`sox-memory-bundle` is a meta-package that expands to four coordinated extensions at install time. Installing the bundle is exactly equivalent to installing all four members individually at their pinned versions, but lets you treat the subsystem as a single installable unit with its own version.

The four members together form a complete, end-to-end proven agent memory subsystem built entirely on ecosystem primitives: a durable SQLite graph store, hybrid semantic recall under 50 ms, async LLM-powered knowledge organisation, session persistence on conversation end, and a shell CLI for store administration.

## When to use

- Install this bundle when you want persistent, searchable agent memory and do not need to pick and choose individual components.
- Install individual members instead if you only need a subset (e.g. `memory-server` alone for the MCP tools without the organizer agent).

## Members

| Extension id       | Type        | Role                                                                        |
| ------------------ | ----------- | --------------------------------------------------------------------------- |
| `memory-server`    | mcp-server  | 7 MCP tools over SQLite graph store; hybrid recall; session state; daemon   |
| `memory-organizer` | agent       | Async LLM organizer: relation extraction, importance scoring, reflection     |
| `memory-flush`     | hook        | SessionEnd persistence; episode enqueue; ScopePromotionProposed approval    |
| `memory-cli`       | command     | Shell lifecycle: init, status, list, registry subcommands                   |

## Architecture summary

```
host
  └─ spawns memoryd (background singleton, inside memory-server)
       ├─ reads/writes .memory/<scope>.db  (SQLite + sqlite-vec + FTS5)
       └─ invokes memory-organizer (async, on write queue)
           └─ 1–4 batched LLM calls (relation extraction, importance, reflection)

memory-flush (hook, SessionEnd)
  └─ persists working memory → .db → nudges memoryd socket

memory-cli (command)
  └─ init | status | list | registry  (deterministic, no LLM)
```

## Usage

```bash
sox install sox-memory-bundle
```

After installation, initialise a scope store:

```bash
memory init --scope project
```

Then configure your agent to call `memory_write` and `memory_recall` via the MCP server.

## License

MIT
