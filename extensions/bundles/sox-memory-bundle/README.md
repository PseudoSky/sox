# sox-memory (graph memory subsystem)

> Install this when you want the full sox-memory graph-memory subsystem in one command.

## Overview

`sox-memory-bundle` is a meta-package that expands to four coordinated extensions at install time. Installing the bundle is exactly equivalent to installing all four members individually at their pinned versions, but lets you treat the subsystem as a single installable unit with its own version.

The four members together form a complete, end-to-end proven agent memory subsystem built entirely on ecosystem primitives: a durable SQLite graph store, hybrid semantic recall under 50 ms, deterministic batch enrichment (clustering, importance, auto-links via `@adhd/sox-memory-core`, running in-process inside `memory-server` — zero LLM calls, no provider required), session persistence on conversation end, and a shell CLI for store administration.

**BL-162 / ADR-0007:** the subsystem previously shipped a separate `memory-daemon` service member (a supervised Unix-socket writer daemon). The single-writer architecture (ADR-0007) moved batch enrichment in-process into the `memory-server` writer backend, so the daemon member was removed — there is no separate daemon process to install, enable, or supervise.

## When to use

- Install this bundle when you want persistent, searchable agent memory and do not need to pick and choose individual components.
- Install individual members instead if you only need a subset (e.g. `memory-cli` alone for shell store administration).

## Members

| Extension id    | Type        | Role                                                                        |
| --------------- | ----------- | --------------------------------------------------------------------------- |
| `memory-server` | mcp-server  | 20 MCP tools over SQLite graph store; hybrid recall; session state; in-process batch enrichment (clustering, importance, auto-links, stale-vector healing) |
| `memory-flush`  | hook        | SessionEnd persistence; episode enqueue; ScopePromotionProposed approval    |
| `memory-cli`    | command     | Shell lifecycle: init, status, list, registry subcommands                   |
| `memory-usage`  | skill       | How-to guidance for the memory subsystem                                    |

## Architecture summary

```
memory-server (mcp-server, stdio)
  ├─ reads/writes ~/.memory/memory.db  (SQLite + sqlite-vec + FTS5)
  ├─ exposes 20 memory_* MCP tools; write-time enrichment runs synchronously
  └─ runs runBatchEnrich (memory-core) on a periodic in-process loop
       └─ clustering, importance, auto-links, stale-vector healing (deterministic, zero LLM, no daemon)

memory-flush (hook, SessionEnd)
  └─ persists working memory → .db

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
