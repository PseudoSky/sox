# Agent Memory Server

> Use this when an agent needs durable, searchable memory across sessions — persistent storage with hybrid recall under 50 ms and zero LLM calls on the read path.

## Overview

`memory-server` is the keystone of the sox-memory subsystem. It runs as a long-lived background singleton (via `memoryd`) and exposes 7 MCP tools over a stdio JSON-RPC transport. All persistent state lives in a single SQLite file per scope, extended with the `sqlite-vec` vector extension (for approximate nearest-neighbour search) and FTS5 (for BM25 full-text search).

The read path (`memory_recall`) is strictly deterministic: local hash embedding, parallel vec+BM25+temporal search, RRF fusion, recency × importance reranking — all in-process, no provider calls, target <50 ms. The write path (`memory_write`) inserts an episode and enqueues an async organizer task; it never blocks on LLM. The organizer (a separate `memory-organizer` agent) is the sole LLM caller in the subsystem.

## When to use

- When an agent needs to persist facts, observations, or decisions and recall them in future sessions.
- When you need federated memory across project, user, and org scopes with content-hash dedup and SUPERSEDES suppression.
- When you need session working-memory state saved and restored across conversation boundaries.

Do NOT use `memory-server` for transient scratchpad data that does not need to survive a session — keep ephemeral state in the host's context window instead.

## Tools

| Tool name                  | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| `memory_write`             | Write a memory episode; enqueues organizer, never blocks on LLM             |
| `memory_recall`            | Hybrid vec+BM25+temporal recall, <50 ms, zero LLM; returns ranked results  |
| `memory_search_entities`   | Search entity nodes by name or summary                                      |
| `memory_get_session_state` | Retrieve working-memory state for a session                                 |
| `memory_save_session_state`| Upsert working-memory state for a session                                   |
| `memory_get_community`     | Look up the community cluster for an entity node                            |
| `memory_invalidate`        | Bi-temporally invalidate a claim (sets `t_invalid`; never deletes)          |

## Recall algorithm

1. Local hash embedding (zero provider calls)
2. Parallel: vec0 KNN + FTS5 BM25 + temporal recency filter
3. Graph depth-1 expansion over live edges (project store)
4. RRF (k=60) fusion across all three signals
5. Rerank: `rrf_score × recency_decay(0.995/hr) × importance(1–10)`
6. Assemble results within `token_budget` (default 4000 tokens)

## Transport

stdio — one JSON-RPC 2.0 request per line, one JSON response per line.

Implements: `initialize`, `tools/list`, `tools/call`.

## Lifecycle

Runs as a host-supervised background singleton (`lifecycle.background: true`, `lifecycle.singleton: true`). Health-checked via Unix socket at `~/.memory/memoryd.sock`. The daemon is compiled and shipped inside the `memory-server` extension (`memoryd.js` in the package `dist/`).

## Configuration

| Variable / config key     | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `db_path` (tool argument) | Path to the `.db` file for each tool call           |

Scope-to-path conventions:
- `project` → `<cwd>/.memory/project.db`
- `user`    → `~/.memory/user.db`
- `org`     → `~/.memory/org.db`
- `local`   → `<cwd>/.memory/local.db`

## Usage

```bash
sox install memory-server
# or install the full subsystem:
sox install sox-memory-bundle
```

## License

MIT
