# Agent Memory Server

> Durable, searchable agent memory — hybrid recall under 50 ms, zero LLM calls on either path.

## Overview

`@adhd/sox-extension-memory-server` is the keystone of the sox-memory subsystem: a single MCP server that owns 20 `memory_*` tools, all enrichment, clustering, and session-state persistence. There is no separate daemon process — everything, including periodic batch enrichment, runs in-process inside this one server.

All persistent state lives in one store file per scope, opened through `@adhd/sox-store-adapter`. **Turso is the default backend** and runs with `multiprocess_wal` enabled: multiple OS processes can hold concurrent write connections to the same store file, with writers serialized through a coordinator sidecar rather than one process owning the file. That means you can run several agents, several CLI invocations, and several `memory-server` instances against one store concurrently without external locking. Set `STORE_ADAPTER=sqlite` to fall back to `better-sqlite3`, which remains single-writer. Either backend is extended with vector search (Turso native vectors or `sqlite-vec`) and FTS5 for BM25 full-text search.

The read path (`memory_recall`) is strictly deterministic — local hash embedding, parallel vector + BM25 + temporal search, reciprocal-rank fusion, recency × importance reranking, all in-process with no provider call, targeting under 50 ms. The write path (`memory_write`) inserts an episode and runs synchronous write-time enrichment (provenance, tags, topic, near-duplicate check) before returning; it never blocks on an external call. Heavier batch enrichment (clustering, auto-links, importance) runs on a periodic in-process loop, or synchronously on demand via `memory_curate` with `op: "recluster"` — zero LLM calls, no provider required.

```bash
pnpm add @adhd/sox-extension-memory-server
```

## Quick start

### As an installed MCP server (the normal path)

```bash
soxe install memory-server --host=opencode --scope=project
soxe serve memory-server
```

The host spawns the process over stdio at session start (see [Transport](#transport) for persistent sse/http profiles). Once installed, an agent calls the tools directly:

> **No type declarations ship with this package.** It is built as an executable bundle, so
> `dist/` contains no `.d.ts` and `package.json` declares no `types` field. The examples below
> are JavaScript. Importing it from TypeScript under `noImplicitAny` raises
> `TS7016: Could not find a declaration file for module` — add your own ambient declaration, or
> drive the package through its command line / MCP interface, which is its intended seam.

```jsonc
// memory_write
{ "content": "Fixed the write-queue deadlock by adding a busy-timeout retry.",
  "project_path": "/Users/you/projects/my-repo",
  "tags": ["gotcha", "concurrency"] }
// → { "episode_uid": "ep-...", "enrichment": { "topic": "...", "tags": [...], "near_dup": null } }

// memory_recall
{ "query": "write-queue deadlock", "token_budget": 50000, "limit": 5 }
// → { "results": [{ "uid": "ep-...", "content": "...", "score": 0.83, "provenance": ["vec","fts"] }] }
```

### Programmatically, without a host

The package also exports its tool dispatcher directly, which is how its own test suite drives it — useful for embedding the server's logic in another Node process or for scripting against a store without spinning up stdio/HTTP:

```js
import { handleToolCall, TOOLS, resolveDbPath } from '@adhd/sox-extension-memory-server';

const dbPath = resolveDbPath(undefined); // → ~/.memory/memory.db by default

const write = await handleToolCall('memory_write', {
  db_path: dbPath,
  content: 'The write-queue deadlock was fixed by adding a busy-timeout retry.',
  project_path: process.cwd(),
  tags: ['gotcha', 'concurrency'],
});
const { episode_uid } = JSON.parse(write.content[0].text as string);

const recall = await handleToolCall('memory_recall', {
  db_path: dbPath,
  query: 'write-queue deadlock',
  token_budget: 50000,
  limit: 5,
});
console.log(JSON.parse(recall.content[0].text as string));

console.log(TOOLS.map((t) => t.name).length); // 20
```

`handleToolCall(name, args)` returns `{ content: [{ type: 'text', text: string }], isError?: boolean }` — the same shape every MCP tool call returns; the payload is JSON in `content[0].text`.

## When to use

- An agent needs to persist facts, observations, or decisions and recall them in future sessions.
- You need federated memory across project/user/org scopes with content-hash dedup and supersession.
- You need session working-memory state saved and restored across conversation boundaries.

Do not use `memory-server` for transient scratchpad data that doesn't need to survive a session — keep that in the host's own context window.

## Tools (20)

| Tool | Description |
| --- | --- |
| `memory_ping` | Liveness + health check. `ok:true` is only the RPC succeeding — read `status`/`store_ok`/`store_error`/`embed.state` for the real health verdict. |
| `memory_write` | Write one episode; runs synchronous write-time enrichment. |
| `memory_write_batch` | Write multiple episodes (a per-item dedup returns `ok:false`, not a batch failure); `project_path` required on every item. |
| `memory_recall` | Hybrid vec + BM25 + temporal recall, target <50 ms, zero LLM; returns ranked results. |
| `memory_search_entities` | Search entity nodes by name or summary. |
| `memory_get_session_state` | Retrieve working-memory state for a session. |
| `memory_save_session_state` | Upsert working-memory state for a session. |
| `memory_get_community` | Look up the community cluster for an entity or community node. |
| `memory_invalidate` | Bi-temporally invalidate a live node (sets `t_invalid`; never deletes). Idempotent on an already-invalid uid. |
| `memory_update` | In-place edit of an existing live node (content, summary, tags, importance, metadata, …). Distinct from supersession — the `uid` never changes; content/summary edits re-embed automatically. |
| `memory_link` | Create a directed edge between two existing nodes (`MENTIONS`, `SUPPORTS`, `RELATES_TO`, `DERIVED_FROM`, `SUPERSEDES`, `SAME_AS`, `ASSIGNED_TO`). |
| `memory_topics` | List topics with episode counts. |
| `memory_list_projects` | List distinct `project_path` values with episode counts. |
| `memory_list_entities` | List entity nodes ranked by mention count. |
| `memory_entity_episodes` | Return episodes that mention a given entity. |
| `memory_related` | Return graph neighbors of an episode at depth 1. |
| `memory_supersession_chain` | Return the full supersession chain for an episode. |
| `memory_near_duplicates` | List near-duplicate episode pairs (`SAME_AS` edges). |
| `memory_curate` | Curation ops: retag, set topic, set importance, merge duplicates, recluster. |
| `memory_stats` | Enrichment coverage, cluster quality, and the running tool-capability list. |

## Recall algorithm

1. Local hash embedding (zero provider calls).
2. Parallel: vector KNN + FTS5 BM25 + temporal recency filter.
3. Graph depth-1 expansion over live edges (project store).
4. Reciprocal-rank fusion across all three signals.
5. Rerank by `score × recency_decay × importance`.
6. Assemble results within `token_budget` (runtime default **32000** — pass a larger value like `50000` explicitly when you need more; the assembler stops adding results once the budget is spent, so a small budget can return far fewer results than `limit` allows). The tool's advertised JSON schema (`tools/list`) currently declares a stale `default: 4000` that disagrees with this runtime value — trust this document, not the schema, until that's fixed.

## Transport

Three transport profiles, selectable at install time:

| Profile | Install | Server lifecycle |
| --- | --- | --- |
| **stdio** (default) | `soxe install memory-server --host=opencode --scope=project` | Per-session — spawned by the host, dies with the session. |
| **http** | `soxe install memory-server --profile=http --host=opencode --scope=user` | Persistent — requires `soxe service enable memory-server --scope=user`. |
| **sse** | `soxe install memory-server --profile=sse --host=opencode --scope=user` | Persistent, same as http. Deprecated for Claude Code hosts — prefer `--profile=http` there; sse still works. |

```bash
# Development (stdio) — no persistent daemon
soxe install memory-server --host=opencode --scope=project
soxe serve memory-server

# Published (persistent) — runs as a host-supervised background singleton
soxe install memory-server --profile=http --host=opencode --scope=user
soxe service enable memory-server --scope=user
```

`soxe serve memory-server --port=3099` serves stdio and TCP together, proxying both to the same backend. All profiles implement `initialize`, `tools/list`, and `tools/call`.

## Lifecycle

- **stdio (default):** the host spawns the process at session start; it dies with the session — no background daemon.
- **http/sse (via `soxe service enable`):** runs as a host-supervised background singleton, health-checked over its HTTP/SSE listener by the host's OS-unit layer (`launchd` on macOS). This is the same generic service-lifecycle mechanism every `type: service` extension uses — `memory-server` has no daemon-specific IPC of its own; batch enrichment runs in-process inside this same server regardless of transport.

## Configuration

| Key | Description |
| --- | --- |
| `db_path` (tool argument) | Path to the store file for this call. Must resolve inside `~/.memory/**` when the host has permission enforcement active; omit it to use the scope default. |

Scope → default store path:

| Scope | Default path |
| --- | --- |
| `project` | `<cwd>/.memory/project.db` |
| `local` | `<cwd>/.memory/local.db` |
| `user` | `~/.memory/user.db` |
| `org` | `~/.memory/org.db` |

## Gotchas

- **`project_path` is required on every write** — there is no cwd/env inference. An omitted or empty value fails the call with `E_MISSING_PROJECT_PATH` before anything is written, and a wrong guess can't be corrected by rewriting (the content-hash dedup key ignores `project_path`); use `memory_update` to correct it in place. Reads (`memory_recall` and friends) treat an omitted `project_path` filter as "search every project" — that's a valid choice there, not an error.
- **Writes are async-embedded.** By default the vector embedding lands *after* `memory_write` returns: a fresh episode is keyword/temporal-recallable immediately but vector-recallable only once the async embed completes (typically well under a second). A purely semantic `memory_recall` fired microseconds after a write can come back empty — that's expected latency, not broken recall. `memory_ping`'s `store.embed_backlog` reports how many episodes are still waiting.
- **`memory_write`'s `near_dup` field is always `null`** in the immediate response — near-duplicate detection runs asynchronously. Call `memory_near_duplicates` afterward to check whether a `SAME_AS` edge was created.

## Usage

```bash
soxe install memory-server
# or install the full subsystem:
soxe install sox-memory-bundle
```

## License

MIT
