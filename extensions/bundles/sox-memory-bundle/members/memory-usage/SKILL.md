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

Every write is **enriched deterministically on the spot** — topic, tags, an
extractive summary, near-duplicate detection — with **zero LLM calls and no
provider** (the legacy LLM organizer was removed; clustering/auto-links run as a
deterministic batch pass in `memory-daemon`). `memory-server` exposes **19
`memory_*` tools** (v1.1.0). See the server's `CLAUDE.md` for full per-tool
schemas; this skill covers the everyday recall / write / update path.

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

`memory_recall` — recall ranked results. `query` is **optional** (omit it for an
importance-ranked listing). An optional `filters` object narrows the candidate set:

```jsonc
memory_recall({
  query: "how should an orchestrator decide a plan state is complete",
  db_path: "~/.memory/memory.db",   // REQUIRED; must be under ~/.memory/ (allowlist)
  token_budget: 50000,               // PASS THIS — see caveat
  limit: 8,
  filters: {                         // all optional
    topic: "execution-context-partition",
    tags: ["orchestration"],         // any-match (tags_match_all:true for all)
    project_path: "/Users/.../repo", // or { prefix: "/Users/.../" }
    importance_min: 3,
    t_created_after: "2026-01-01T00:00:00Z"
  }
})
```

`memory_write` — store one focused finding. `topic`/`tags`/`name`/`project_path`/
`summary` are **first-class fields** (not just `metadata`):

```jsonc
memory_write({
  content: "<the finding — one focused idea>",
  db_path: "~/.memory/memory.db",
  topic: "<topic>",         // first-class — drives organization + filtered recall
  tags: ["<concept>"],      // first-class — also creates linkable entity nodes
  source: "document",       // message | tool_output | observation | document | reflection | import
  agent_id: "<your-agent-name>",
  metadata: { original_path: "<source path if any>" }, // arbitrary structured data (JSON)
  scope: "user"             // user = this machine, all agents
})
```

`memory_update` — **edit an existing node in place** (the `uid` is immutable;
distinct from supersession). Use to correct/enrich a finding. Changing `content`
or `summary` re-embeds automatically; `metadata` **deep-merges** by default
(`metadata_merge: "replace"` to overwrite):

```jsonc
memory_update({
  uid: "<episode_uid>", db_path: "~/.memory/memory.db",
  metadata: { reviewed_by: "code-reviewer" },   // deep-merged into node.meta
  importance: 8                                 // and/or content/summary/name/topic/tags/t_occurred
})
```

To correct a *fact* (rather than edit a node), prefer **supersession**: `memory_write`
the new claim + `memory_invalidate({ claim_uid, reason, replacement_uid })` the old one
(bi-temporal — the old claim stays visible in `as_of` recall, drops from current recall).

### Other tools (19 total — see the server `CLAUDE.md` for schemas)

- **Discover filter values:** `memory_topics`, `memory_list_projects`,
  `memory_list_entities`, `memory_search_entities` — call these to learn valid
  `topic`/`project_path`/`tags`/entity values before a filtered `memory_recall`.
- **Graph traversal:** `memory_related` (neighbours), `memory_entity_episodes`
  (episodes mentioning an entity), `memory_get_community` (a cluster + members),
  `memory_supersession_chain`, `memory_near_duplicates`.
- **Curate:** `memory_curate` with `op` ∈ `retag | set_topic | set_importance |
  merge_duplicates | recluster | drop_lens | list_lenses` (filtered/subset reclustering
  + lens GC).
- **Session state:** `memory_get_session_state` / `memory_save_session_state`.
- **Health:** `memory_stats` (coverage + cluster quality; `tool_version` confirms the
  surface). `memory_invalidate` (above). `memory_ping`, `memory_link`.

## Output contract

`memory_recall` returns ranked results, each with `uid`, `content`, `score`,
`provenance` (`["vec","fts","temporal"]` — which signals matched), `agent_id`,
`content_hash`, plus the enrichment fields `summary`, `topic`, `tags`,
`project_path`, `importance`, `is_superseded`, `supersedes_uid`, and
`community_uid`. `memory_write` returns `{ episode_uid, enrichment: { topic,
project_path, summary, tags, near_dup } }`, or `{ code: "E_DEDUP", existing_uid }`
(writes are content-hash idempotent). `memory_update` returns
`{ uid, updated_fields, reembedded }`.

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
