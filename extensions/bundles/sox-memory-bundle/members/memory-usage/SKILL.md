---
name: memory-usage
description: How to recall prior knowledge and store durable findings in the soxe graph-memory system via the memory_* MCP tools. Use whenever you are about to research, decide, or could benefit from what was learned before — recall first; and whenever you produce a durable, generalized, sourced finding worth carrying forward — write it.
---

# memory-usage — using the soxe graph memory system

<!-- markdownlint-disable MD013 -->

The soxe memory system is a local, bi-temporal **knowledge graph** with hybrid
(vector + full-text + temporal) recall, served over MCP by `memory-server` (a
member of this same `sox-memory-bundle`). Embeddings are local
(bge-base-en-v1.5, 768-dim) — recall is offline and makes no network calls. The
store lives at **`~/.memory/memory.db`** (user scope).

Every write is **enriched deterministically on the spot** — topic, tags, an
extractive summary, near-duplicate detection — with **zero LLM calls and no
provider** (the legacy LLM organizer was removed; clustering/auto-links run as a
deterministic batch pass in-process inside `memory-server` itself — no separate
daemon process. This is unrelated to store concurrency: with the default Turso
backend the store itself runs in `multiprocess_wal` mode, so multiple processes
may hold concurrent write connections to it; only the `better-sqlite3` fallback
is single-writer). `memory-server` exposes **20 `memory_*` tools**. See that
package's own README for full per-tool schemas; this skill covers the everyday
recall / write / update path.

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
  db_path: "~/.memory/memory.db",   // optional — omit it; defaults to the user store (BL-55)
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
`summary` are **first-class fields** (not just `metadata`). **`project_path` is REQUIRED** —
pass your actual workspace root explicitly, always. There is no cwd/env/git fallback: an omitted
or empty `project_path` fails the call outright with `{ code: "E_MISSING_PROJECT_PATH" }` before
anything is written, and a wrong guess would permanently mis-attribute the finding (the dedup key
ignores `project_path`, so you can't fix it by re-writing — see `memory_update` in the server's
`CLAUDE.md` for the only in-place remediation path). **There is no `scope` parameter on
`memory_write`** — a write lands in whichever store `db_path`/`store` selects, and the default is the
user-scope `~/.memory/memory.db` shared by every agent on this machine. (`scope` exists only on
`memory_recall`, and there it is a cosmetic label.) Do **not** pass `scope` on a write.

```jsonc
memory_write({
  content: "<the finding — one focused idea>",
  db_path: "~/.memory/memory.db", // optional — omit to use the default user store
  project_path: "/Users/.../repo", // REQUIRED — your actual workspace root, never inferred
  topic: "<topic>",         // first-class — drives organization + filtered recall
  tags: ["<concept>"],      // first-class — also creates linkable entity nodes
  name: "<title>",          // optional — episode title (node.name)
  summary: "<1-3 sentences>", // optional — node.summary; extractive fallback if omitted
  source: "document",       // message | tool_output | observation | document | reflection | import
  agent_id: "<your-agent-name>",
  importance: 7,            // optional — user-asserted 1–10
  metadata: { original_path: "<source path if any>" } // arbitrary structured data (JSON)
})
```

`memory_write_batch` enforces the same rule per item — any item missing `project_path` rejects the
whole batch before any of it is written.

Reads are the opposite: `memory_recall`/`memory_topics`/`memory_list_entities`/`memory_stats` never
infer `project_path` either, but omitting it there is a **valid, deliberate "search every project"
request** — not an error. Pass `filters.project_path` only when you actually want to narrow the
search to one project.

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

To correct a *fact* (rather than edit a node), prefer **supersession**: `memory_write` the
replacement episode + `memory_invalidate({ claim_uid: <old episode_uid>, reason,
replacement_uid: <new episode_uid> })` the old one — `claim_uid` accepts the plain
`episode_uid` from `memory_write` directly, there is no separate "claim" identity to wait for
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

## Finding the right memories

Recall is only as good as the axis you scope it on. Every recipe below is
copy-paste-ready and validated against the live `memory_recall` schema. Two
things to internalize first:

1. **`agent_id` is a TOP-LEVEL param, never a `filters` field.** It hard-scopes
   recall to episodes written by that agent (a SQL `AND n.agent_id = ?` on the
   vec/FTS/temporal channels).
2. **`filters` accepts exactly seven keys** — `project_path`, `topic`, `tags`,
   `tags_match_all`, `importance_min`, `t_created_after`, `t_created_before`.
   Anything else is silently dropped. Lifecycle/audience axes like `kind:` and
   `audience:` are **tag-prefix conventions**, recalled through `tags` — there is
   no standalone `kind` or `audience` filter field.

### Recall only what *I* wrote (self-scoping)

Pass `agent_id` at the top level (not inside `filters`). Recall is hard-filtered
to your own episodes:

```jsonc
memory_recall({
  query: "how we resolved the write-queue deadlock",
  db_path: "~/.memory/memory.db",
  agent_id: "memory-refactor-impl",  // TOP-LEVEL — scopes to episodes YOU wrote
  token_budget: 50000,
  limit: 8
})
```

Caveat: `agent_id` scoping is applied only on the **query** path. If you omit
`query` (the importance-ranked listing), `agent_id` is **not** applied — so pass a
query whenever you want self-scoped recall.

### `target:` / `audience:` — write for a specific reader

`tags` is a freeform string array (each tag also becomes a linkable entity node).
Adopt an `audience:` (or `target:`) prefix at write time to mark who a note is
for, then recall by that tag:

```jsonc
// write — mark the intended reader
memory_write({
  content: "Orchestrators: dispatch.json depends_on must declare a dep for any shared file.",
  db_path: "~/.memory/memory.db",
  project_path: "/Users/.../repo",  // REQUIRED
  tags: ["audience:orchestrator", "kind:pattern"],
  source: "observation", agent_id: "flash-impl"
})

// recall — pull everything addressed to orchestrators
memory_recall({
  query: "parallel dispatch file-conflict safety",
  db_path: "~/.memory/memory.db",
  filters: { tags: ["audience:orchestrator"] },  // any-match on the tag array
  token_budget: 50000, limit: 8
})
```

`tags` is **any-match** by default (an episode matches if it has *any* listed
tag); add `tags_match_all: true` to require *all* of them.

### `kind:` — lifecycle / note-type filter

Same mechanism: `kind:` is a tag prefix, not a dedicated field. Tag writes with a
lifecycle kind (`kind:decision`, `kind:lesson`, `kind:gotcha`, `kind:pattern`, …)
and recall through `tags`:

```jsonc
memory_recall({
  query: "embedding worker boundary",
  db_path: "~/.memory/memory.db",
  filters: { tags: ["kind:gotcha"] },
  token_budget: 50000, limit: 8
})
```

### Combine axes — self + kind + importance + recency

All axes compose (top-level `agent_id` AND every `filters` clause are ANDed):

```jsonc
memory_recall({
  query: "how we resolved the write deadlock",
  db_path: "~/.memory/memory.db",
  agent_id: "memory-refactor-impl",
  filters: {
    tags: ["kind:gotcha"],
    importance_min: 5,
    t_created_after: "2026-06-01T00:00:00Z"
  },
  token_budget: 50000, limit: 10
})
```

**Discover valid values first.** Before filtering on `topic`/`project_path`/tags
you can't recall from memory, call `memory_topics`, `memory_list_projects`, or
`memory_list_entities` to enumerate what actually exists in the store — a filter
on a value no node carries returns nothing.

## Output contract

`memory_recall` returns ranked results, each with `uid`, `content`, `score`,
`provenance` (`["vec","fts","temporal"]` — which signals matched), `agent_id`,
`content_hash`, plus the enrichment fields `summary`, `topic`, `tags`,
`project_path`, `importance`, `is_superseded`, `supersedes_uid`, and
`community_uid`. `memory_write` returns `{ episode_uid, enrichment: { topic,
project_path, summary, tags, near_dup } }`, or `{ code: "E_DEDUP", existing_uid }`
(writes are content-hash idempotent). `near_dup` is always `null` in this response — near-dup
detection is asynchronous (see `memory_write`'s own tool description); to check after the fact
whether a written episode picked up a `SAME_AS` edge, call `memory_near_duplicates` scoped by
that episode's `project_path`/`topic` and look for its uid in the returned `uid_a`/`uid_b`
pairs. `memory_update` returns `{ uid, updated_fields, reembedded }`.

## Caveats

- **Always pass a generous `token_budget`** (e.g. `50000`). The default is small and
  the assembler stops adding results once the budget is spent — a default-budget
  recall can return **one** result even when `limit` is higher.
- **Chunk large content.** Write one focused idea per node — not a whole document.
  A multi-section doc as one node embeds only its first ~512 tokens (the rest is
  unsearchable) and crowds recall. Split into a short summary node + per-section
  nodes, each prefixed with the source title.
- **Writes are async-embedded — recall right after a write may miss it.** By
  default the embedding lands *after* `memory_write` returns (two-phase write): a
  fresh episode is **keyword/temporal-recallable immediately** but
  **vector(semantic)-recallable only once the async embed completes** (typically
  <1s; `memory_ping` → `store.embed_backlog` counts episodes still waiting). A
  purely semantic recall fired microseconds after a write can therefore come back
  empty — this is expected latency, not broken recall. Set `SOX_SYNC_EMBED=1`
  server-side to force fully synchronous embedding
  (`libs/memory-core/src/embed-pipeline.ts:40,62,67`).
- **`db_path` allowlist:** writes/recall must target `~/.memory/**`.
- **Provenance:** cite the `uid`; the `provenance` field reports which retrieval
  signals matched (vec/fts/temporal), not a source URL — source lives in the node's
  content/metadata.

## Examples

- *Recall before researching:* `memory_recall({query:"token cost optimization for multi-agent dispatch", db_path:"~/.memory/memory.db", token_budget:50000, limit:5})` → reuse the top findings by `uid`, research only the gap.
- *Write a finding:* `memory_write({content:"Thin orchestrator holds only board + state deltas; executors hold working context.", project_path:"/Users/.../repo", source:"document", agent_id:"workflow-researcher", metadata:{topic:"execution-context-partition"}})`.

## Skill id

`memory-usage`
