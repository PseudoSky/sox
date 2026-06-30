# sox-memory (graph memory subsystem)

> Install this when you want the full sox-memory graph-memory subsystem in one command.

## Overview

`sox-memory-bundle` is a meta-package that expands to five coordinated extensions at install time. Installing the bundle is exactly equivalent to installing all five members individually at their pinned versions, but lets you treat the subsystem as a single installable unit with its own version.

The five members together form a complete, end-to-end proven agent memory subsystem built entirely on ecosystem primitives: a durable SQLite graph store, hybrid semantic recall under 50 ms, deterministic batch enrichment (clustering, importance, auto-links via `@adhd/sox-memory-core` — zero LLM calls, no provider required), session persistence on conversation end, and a shell CLI for store administration.

## When to use

- Install this bundle when you want persistent, searchable agent memory and do not need to pick and choose individual components.
- Install individual members instead if you only need a subset (e.g. `memory-server` alone for the MCP tools without the daemon).

## Members

| Extension id    | Type        | Role                                                                        |
| --------------- | ----------- | --------------------------------------------------------------------------- |
| `memory-daemon` | service     | Singleton Unix-socket daemon; drains enrich queue; runs deterministic batch enrichment |
| `memory-server` | mcp-server  | 19 MCP tools over SQLite graph store; hybrid recall; session state          |
| `memory-flush`  | hook        | SessionEnd persistence; episode enqueue; ScopePromotionProposed approval    |
| `memory-cli`    | command     | Shell lifecycle: init, status, list, registry subcommands                   |
| `memory-usage`  | skill       | How-to guidance for the memory subsystem                                    |

## Architecture summary

```
host
  └─ spawns memory-daemon (background singleton, Unix socket)
       ├─ reads/writes ~/.memory/memory.db  (SQLite + sqlite-vec + FTS5)
        └─ runs runBatchEnrich (memory-core) on write queue drain
           └─ clustering, importance, auto-links (deterministic, zero LLM)

memory-server (mcp-server, stdio)
  └─ exposes 19 memory_* MCP tools; enqueues to memory-daemon on write

memory-flush (hook, SessionEnd)
  └─ persists working memory → .db → nudges memoryd socket

memory-cli (command)
  └─ init | status | list | registry  (deterministic, no LLM)
```

## Usage

```bash
soxe install sox-memory-bundle
```

After installation, initialise a scope store:

```bash
memory init --scope project
```

Then configure your agent to call `memory_write` and `memory_recall` via the MCP server.

## License

MIT
