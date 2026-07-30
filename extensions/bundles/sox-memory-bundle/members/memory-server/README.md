# Agent Memory Server

> Use this when an agent needs durable, searchable memory across sessions — persistent storage with hybrid recall under 50 ms and zero LLM calls on the read path.

## Overview

`memory-server` is the keystone of the sox-memory subsystem — the canonical backend that manages enrichment, clustering, session state, and all MCP tool dispatch (there is no separate daemon). All persistent state lives in a single SQLite-compatible file per scope, served by the **TursoAdapter** (default) with `multiprocess_wal` enabled for concurrent readers and serialized writers across processes. The SqliteAdapter (`better-sqlite3`) fallback is available via `STORE_ADAPTER=sqlite`. The store is extended with vectors (Turso native vectors or sqlite-vec depending on adapter) and FTS5 (for BM25 full-text search).

The read path (`memory_recall`) is strictly deterministic: local hash embedding, parallel vec+BM25+temporal search, RRF fusion, recency × importance reranking — all in-process, no provider calls, target <50 ms. The write path (`memory_write`) inserts an episode and runs synchronous write-time enrichment (provenance, tags, topic, near-dup); it never blocks on any external call. Batch enrichment (clustering, auto-links, importance) runs in-process inside this server on a periodic loop (and synchronously on demand via `memory_curate recluster`) via `@adhd/sox-memory-core` — zero LLM calls, no provider required, no separate daemon process (BL-162).

## When to use

- When an agent needs to persist facts, observations, or decisions and recall them in future sessions.
- When you need federated memory across project, user, and org scopes with content-hash dedup and SUPERSEDES suppression.
- When you need session working-memory state saved and restored across conversation boundaries.

Do NOT use `memory-server` for transient scratchpad data that does not need to survive a session — keep ephemeral state in the host's context window instead.

## Tools

| Tool name                     | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `memory_write`                | Write a memory episode; runs sync write-time enrichment (batch pass runs in-process on a periodic loop) |
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

All three transports are served simultaneously when using `soxe serve --port`:

| Transport | Endpoint | Use case |
|-----------|----------|----------|
| stdio | stdin/stdout JSON-RPC | `type: "local"` host config |
| HTTP | `POST /mcp` | StreamableHTTP — direct JSON-RPC |
| SSE | `GET /sse` + `POST /messages?sessionId=<id>` | Server-Sent Events transport |

All profiles implement: `initialize`, `tools/list`, `tools/call`.

### Dual transport

```bash
soxe serve memory-server --port=3099
```

Starts the shim listening on both stdio and TCP port 3099 simultaneously, proxying both to the same backend. The `--port` flag is compatible with proxy mode.

## Lifecycle

Per-session (stdio, default): the host spawns `memory-server` at session start via `soxe serve`; the process dies with the session — no background daemon.

Persistent (sse/http, via `soxe service enable memory-server`): runs as a host-supervised background singleton (`lifecycle.background: true`, `lifecycle.singleton: true`), health-checked over its HTTP/SSE listener by the host's OS-unit layer (launchd on macOS). This is the generic service-lifecycle mechanism shared with every other `type: service` extension — memory-server has no daemon-specific IPC (BL-162 removed the separate `memory-daemon` Unix-socket writer; batch enrichment now runs in-process inside this same server, see "Overview" above).

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
