---
name: memory-usage
description: How to recall prior knowledge and store durable findings in the sox graph-memory system via the memory_* MCP tools. Use whenever you are about to research, decide, or could benefit from what was learned before — recall first; and whenever you produce a durable, generalized, sourced finding worth carrying forward — write it.
---

# memory-usage — using the sox graph memory system

<!-- markdownlint-disable MD013 -->

The sox memory system is a local, bi-temporal **knowledge graph** with hybrid
(vector + full-text + temporal) recall, served over MCP by `memory-server` (a
member of this same `sox-memory-bundle`). Embeddings are local
(bge-base-en-v1.5, 768-dim) — recall is offline and makes no network calls. The
store lives at **`~/.memory/memory.db`** (user scope).

Interact with it only through the `memory_*` MCP tools. Never open the DB file
directly.

## When to use this skill

- **Recall first.** Before researching a topic, making a non-obvious decision, or
  answering from scratch, `memory_recall` to check what is already known. Cite what
  you reuse by its `uid`.
- **Write durable findings.** After producing a generalized, sourced insight worth
  carrying forward (a research finding, a resolved gotcha, a pattern), `memory_write`
  it so the next agent benefits.

## When NOT to use this skill

- Transient chatter, project-secret-specific values, or unsourced claims — do not write them.
- Project-specific notes that name a repo/path/person belong in that project's files, not the shared graph memory.

## Input contract

`memory_recall` — recall ranked results for a query:

```jsonc
memory_recall({
  query: "how should an orchestrator decide a plan state is complete",
  db_path: "~/.memory/memory.db",   // REQUIRED; must be under ~/.memory/ (allowlist)
  token_budget: 50000,               // PASS THIS — see caveat
  limit: 8
})
```

`memory_write` — store one focused finding:

```jsonc
memory_write({
  content: "<the finding — one focused idea>",
  db_path: "~/.memory/memory.db",
  source: "document",      // message | tool_output | observation | document | reflection | import
  agent_id: "<your-agent-name>",
  metadata: { topic: "<topic>", original_path: "<source path if any>" },
  scope: "user"            // user = this machine, all agents
})
```

Other tools: `memory_search_entities`, `memory_invalidate({ claim_uid, reason })`,
`memory_get_community`, `memory_get_session_state` / `memory_save_session_state`.

## Output contract

`memory_recall` returns ranked results, each with `uid`, `content`, `score`,
`provenance` (`["vec","fts","temporal"]` — which signals matched), `agent_id`,
`content_hash`. `memory_write` returns `{ episode_uid }`, or
`{ code: "E_DEDUP", existing_uid }` (writes are content-hash idempotent).

## Caveats

- **Always pass a generous `token_budget`** (e.g. `50000`). The default is small and
  the assembler stops adding results once the budget is spent — a default-budget
  recall can return **one** result even when `limit` is higher.
- **Chunk large content.** Write one focused idea per node — not a whole document.
  A multi-section doc as one node embeds only its first ~512 tokens (the rest is
  unsearchable) and crowds recall. Split into a short summary node + per-section
  nodes, each prefixed with the source title.
- **`db_path` allowlist:** writes/recall must target `~/.memory/**`.
- **Provenance:** cite the `uid`; the `provenance` field reports which retrieval
  signals matched (vec/fts/temporal), not a source URL — source lives in the node's
  content/metadata.

## Examples

- *Recall before researching:* `memory_recall({query:"token cost optimization for multi-agent dispatch", db_path:"~/.memory/memory.db", token_budget:50000, limit:5})` → reuse the top findings by `uid`, research only the gap.
- *Write a finding:* `memory_write({content:"Thin orchestrator holds only board + state deltas; executors hold working context.", db_path:"~/.memory/memory.db", source:"document", agent_id:"workflow-researcher", metadata:{topic:"execution-context-partition"}, scope:"user"})`.

## Skill id

`memory-usage`
