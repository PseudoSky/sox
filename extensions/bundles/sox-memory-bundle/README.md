# sox-memory (graph memory subsystem)

> Install this when you want the full sox-memory graph-memory subsystem in one command.

## Overview

`sox-memory-bundle` is a meta-package that expands to four coordinated extensions at install time. Installing the bundle is exactly equivalent to installing all four members individually at their pinned versions, but lets you treat the subsystem as a single installable unit with its own version.

```bash
soxe install sox-memory-bundle
```

The four members together form a complete agent memory subsystem built entirely on ecosystem primitives: a durable graph store (Turso by default, `better-sqlite3` as a fallback), hybrid semantic recall under 50 ms, deterministic batch enrichment (clustering, importance, auto-links via `@adhd/sox-memory-core`), session persistence on conversation end, and administration commands for store lifecycle.

There is no separate daemon process. An earlier version of this subsystem ran a supervised Unix-socket writer daemon; batch enrichment now runs in-process inside `memory-server` on a periodic loop instead — nothing separate to install, enable, or supervise. The store's own multi-process story is unrelated to that daemon removal: with the default Turso backend, `memory-server` opens the store in `multiprocess_wal` mode, so multiple OS processes (several agents, several CLI invocations, several `memory-server` instances) can hold concurrent write connections to the same store file, serialized through a coordinator sidecar rather than through any in-process queue. The `better-sqlite3` fallback (`STORE_ADAPTER=sqlite`) remains single-writer.

## When to use

- Install this bundle when you want persistent, searchable agent memory and do not need to pick and choose individual components.
- Install individual members instead if you only need a subset (e.g. `memory-cli` alone for store administration).

## Members

| Extension id    | Type        | Role                                                                        |
| --------------- | ----------- | --------------------------------------------------------------------------- |
| `memory-server` | mcp-server  | 20 MCP tools over the graph store; hybrid recall; session state; in-process batch enrichment (clustering, importance, auto-links, stale-vector healing) |
| `memory-flush`  | hook        | `SessionEnd` persistence + episode enqueue; `ScopePromotionProposed` approval |
| `memory-cli`    | command     | Store lifecycle: init, status, list, registry, export, reembed, backup, compact, pipeline |
| `memory-usage`  | skill       | How-to guidance for recalling and writing via the `memory_*` tools           |

## Architecture summary

```
memory-server (mcp-server, stdio/http/sse)
  ├─ reads/writes one store file per scope (Turso default + multiprocess_wal, or SQLite fallback)
  ├─ exposes 20 memory_* MCP tools; write-time enrichment runs synchronously
  └─ runs periodic in-process batch enrichment
       └─ clustering, importance, auto-links, stale-vector healing (deterministic, zero LLM)

memory-flush (hook: SessionEnd, ScopePromotionProposed)
  └─ persists working memory + enqueues episodes → same store; optional markdown auto-export

memory-cli (command)
  └─ init | status | list | registry | export | reembed | backup | compact | pipeline (deterministic, no LLM)
```

## Usage

```bash
soxe install sox-memory-bundle
```

After installation, create a scope store via `memory-cli`'s `init` subcommand (see that package's README for exact invocation — as a host-installed `command` extension it's driven by the host/agent, not a standalone shell binary). Then configure your agent to call `memory_write` and `memory_recall` against the installed `memory-server` MCP server.

## License

MIT
