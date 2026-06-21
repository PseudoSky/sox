---
name: sox-memory
description: How to recall prior knowledge and store durable findings in the sox graph-memory system via the memory_* MCP tools. Use whenever you are about to research, decide, or could benefit from what was learned before — recall first; and whenever you produce a durable, generalized, sourced finding worth carrying forward — write it.
---

# sox-memory — using the graph memory system

The sox memory system is a local, bi-temporal **knowledge graph** with hybrid
(vector + full-text + temporal) recall, served over MCP by `memory-server`.
Embeddings are local (bge-base-en-v1.5, 768-dim) — recall is offline and makes
no network calls. The store lives at **`~/.memory/memory.db`** (user scope).

You interact with it only through the `memory_*` MCP tools. Never open the DB
file directly.

## When to use it

- **Recall first.** Before researching a topic, making a non-obvious decision, or
  answering from scratch, `memory_recall` to check what is already known. Cite what
  you reuse by its `uid`.
- **Write durable findings.** After producing a generalized, sourced insight worth
  carrying forward (a research finding, a resolved gotcha, a pattern), `memory_write`
  it so the next agent benefits.
- Do **not** write transient chatter, project-secret-specific values, or unsourced
  claims.

## Recall — `memory_recall`

```jsonc
memory_recall({
  query: "how should an orchestrator decide a plan state is complete",
  db_path: "~/.memory/memory.db",   // REQUIRED; must be under ~/.memory/ (allowlist)
  token_budget: 50000,               // PASS THIS — see caveat below
  limit: 8                            // max results
})
```

Returns ranked results, each with: `uid`, `content`, `score`, `provenance`
(`["vec","fts","temporal"]` — which signals matched), `agent_id`, `content_hash`.

> **Caveat (load-bearing): always pass a generous `token_budget`** (e.g. `50000`).
> The default is small and the assembler stops adding results once the budget is
> spent — so a default-budget recall can return **one** result even when `limit`
> is higher. Passing `token_budget` is the difference between 1 and N results.

## Write — `memory_write`

```jsonc
memory_write({
  content: "<the finding text — one focused idea>",
  db_path: "~/.memory/memory.db",
  source: "document",      // message | tool_output | observation | document | reflection | import
  agent_id: "<your-agent-name>",
  metadata: { topic: "<topic>", original_path: "<source path if any>" },
  scope: "user"            // user = this machine, all agents
})
```

Returns `{ episode_uid }`, or `{ code: "E_DEDUP", existing_uid }` if the exact
content already exists (writes are content-hash idempotent — safe to re-run).

> **Chunk large content.** Write **one focused idea per node**, not a whole
> document. A multi-section document stored as a single node embeds only its first
> ~512 tokens (the rest is not searchable) and crowds recall. Split long material
> into a short summary node plus per-section nodes, each prefixed with the source
> title for context.

## Other tools

- `memory_search_entities({ query, db_path })` — entity-name lookup (graph nodes).
- `memory_invalidate({ claim_uid, reason, db_path })` — mark a claim no longer valid
  (bi-temporal; superseded claims drop out of recall rather than being deleted).
- `memory_get_community({ entity_uid, db_path })` — the cluster a node belongs to.
- `memory_get_session_state` / `memory_save_session_state` — resumable session state.

## Constraints

- **`db_path` allowlist:** writes/recall must target `~/.memory/**`; other paths are
  denied by the server's permission guard.
- **Offline:** embeddings run locally; first use downloads the model once, then no
  network on the read path.
- **Provenance, not prose:** trust the `uid` + `content` a result carries; cite the
  `uid`. The `provenance` field reports which retrieval signals matched (vec/fts/
  temporal), not a source URL — source lives in the node's content/metadata.
