# Agent Memory Server

> Use this when an agent needs durable, searchable memory across sessions — persistent storage with hybrid recall under 50 ms and zero LLM calls on the read path.

## Overview

`memory-server` is the keystone of the sox-memory subsystem. It runs as a long-lived background singleton (via `memoryd`) and exposes 19 MCP tools over stdio JSON-RPC (default), SSE, or HTTP transport. All persistent state lives in a single SQLite file per scope, extended with the `sqlite-vec` vector extension (for approximate nearest-neighbour search) and FTS5 (for BM25 full-text search).

The read path (`memory_recall`) is strictly deterministic: local hash embedding, parallel vec+BM25+temporal search, RRF fusion, recency × importance reranking — all in-process, no provider calls, target <50 ms. The write path (`memory_write`) inserts an episode, runs synchronous enrichment (provenance, tags, topic, near-dup), and enqueues an async batch-enrich task; it never blocks on any external call. The batch enrichment pipeline (clustering, auto-links, importance) runs deterministically in `memory-daemon` via `@adhd/sox-memory-core` — zero LLM calls, no provider required.

## When to use

- When an agent needs to persist facts, observations, or decisions and recall them in future sessions.
- When you need federated memory across project, user, and org scopes with content-hash dedup and SUPERSEDES suppression.
- When you need session working-memory state saved and restored across conversation boundaries.

Do NOT use `memory-server` for transient scratchpad data that does not need to survive a session — keep ephemeral state in the host's context window instead.

## Tools

| Tool name                     | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `memory_write`                | Write a memory episode; runs sync enrichment; enqueues batch pass           |
| `memory_recall`               | Hybrid vec+BM25+temporal recall, <50 ms, zero LLM; returns ranked results  |
| `memory_topics`               | List topics in the store with episode counts                                |
| `memory_list_projects`        | List distinct project_path values with episode counts                       |
| `memory_list_entities`        | List entity nodes ranked by mention count                                   |
| `memory_search_entities`      | Search entity nodes by name or summary                                      |
| `memory_entity_episodes`      | Return episodes that mention a given entity                                 |
| `memory_related`              | Return graph neighbors of an episode at depth=1                             |
| `memory_supersession_chain`   | Return the full supersession chain for an episode                           |
| `memory_near_duplicates`      | List near-duplicate episode pairs (SAME_AS edges)                           |
| `memory_curate`               | Curation: retag, set topic, set importance, merge dups, recluster           |
| `memory_stats`                | Enrichment coverage and cluster quality statistics                          |
| `memory_get_community`        | Look up the community cluster for an entity or community node               |
| `memory_get_session_state`    | Retrieve working-memory state for a session                                 |
| `memory_save_session_state`   | Upsert working-memory state for a session                                   |
| `memory_invalidate`           | Bi-temporally invalidate a claim (sets `t_invalid`; never deletes)          |

## Recall algorithm

1. Local hash embedding (zero provider calls)
2. Parallel: vec0 KNN + FTS5 BM25 + temporal recency filter
3. Graph depth-1 expansion over live edges (project store)
4. RRF (k=60) fusion across all three signals
5. Rerank: `rrf_score × recency_decay(0.995/hr) × importance(1–10)`
6. Assemble results within `token_budget` (default 4000 tokens)

## Transport

Three transport profiles, selectable at install time via `soxe install memory-server --profile=<profile>`:

| Profile | Install command | Config | Server lifecycle |
|---------|----------------|--------|------------------|
| **stdio** (default) | `soxe install memory-server --host=opencode` | `type: "local"`, `soxe serve` | Per-session — dies with session |
| **sse** | `soxe install memory-server --profile=sse --host=opencode --scope=user` | `type: "remote"`, `http://localhost:3000/sse` | Persistent — requires `soxe service enable` |
| **http** | `soxe install memory-server --profile=http --host=opencode --scope=user` | `type: "remote"`, `http://localhost:3000/mcp` | Persistent — requires `soxe service enable` |

### Development (stdio)

```bash
soxe install memory-server --host=opencode --scope=project
soxe serve memory-server
```

The host spawns the server at session start. No persistent daemon.

### Published (sse / http)

```bash
soxe install memory-server --profile=sse --host=opencode --scope=user
soxe service enable memory-server --scope=user
```

The install creates a remote MCP config (`type: "remote"`). The server runs as a launchd daemon. Tools survive session restarts.

### Switching

```bash
soxe uninstall memory-server --host=opencode --scope=user
soxe install memory-server --profile=sse --host=opencode --scope=user
soxe service enable memory-server --scope=user
```

All profiles implement: `initialize`, `tools/list`, `tools/call`.

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
soxe install memory-server
# or install the full subsystem:
soxe install sox-memory-bundle
```

## License

MIT
