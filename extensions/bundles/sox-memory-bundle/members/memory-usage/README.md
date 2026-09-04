# memory-usage

> A declarative skill teaching an agent to recall prior knowledge before researching, and to write durable findings for the next agent — via the `memory_*` MCP tools.

## Overview

`@adhd/sox-extension-memory-usage` is a `type: skill` extension: the host reads its `SKILL.md` and injects the guidance below at invocation time — there is no code to run. It teaches an agent the everyday recall / write / update path against the sox-memory graph store served by `memory-server`, a sibling member of `sox-memory-bundle`. The store is a local, bi-temporal knowledge graph with hybrid (vector + full-text + temporal) recall; embeddings are local, so recall is offline and makes no network calls.

```bash
pnpm add @adhd/sox-extension-memory-usage
```

## Install

```bash
soxe install memory-usage
```

The host injects this skill when an agent is about to research, decide, or answer (recall first), and when it produces a durable, sourced finding worth carrying forward (write it). It is not for transient chatter, project-secret values, or unsourced claims — and project-specific notes that name a repo/path/person belong in that project's own files, not the shared graph memory.

## Recall before researching

`query` is optional — omit it for an importance-ranked listing instead of a semantic search. Always pass a generous `token_budget` (the tool default is small; the assembler stops adding results once the budget is spent, so a default-budget recall can return far fewer results than `limit` allows):

```jsonc
memory_recall({
  query: "how should an orchestrator decide a plan state is complete",
  token_budget: 50000,
  limit: 8,
  filters: {                          // all optional; exactly these eight keys are recognised
    topic: "execution-context-partition",
    tags: ["orchestration"],          // any-match by default; tags_match_all:true for all
    project_path: "/Users/you/repo",  // or { prefix: "/Users/you/" }
    importance_min: 3,
    t_created_after: "2026-01-01T00:00:00Z",
    t_created_before: "2026-06-01T00:00:00Z",
    kinds: ["episode"]                 // node kinds to include — see below, defaults to ["episode"] even when filters is omitted entirely
  }
})
```

The eight `filters` keys: `project_path`, `topic`, `tags`, `tags_match_all`, `importance_min`, `t_created_after`, `t_created_before`, and `kinds`.

**`kinds` is not cosmetic — it decides what shows up at all.** The graph stores several node kinds besides `episode`: `entity`, `community`, and `session` nodes exist for clustering and graph traversal, and carry no readable `content` — recall renders them as `[entity] <uid>: ` with nothing after the colon. Regardless of whether `filters` is passed at all, `memory_recall` defaults `kinds` to `["episode"]`, so those content-less nodes are excluded from ordinary recall automatically. Pass `filters: { kinds: ["episode", "entity"] }` (or any other combination) only when you deliberately want to see them — e.g. while inspecting the entity graph itself, not while recalling findings. Don't confuse this with the `kind:`/`audience:` tag-prefix convention below — that's an unrelated, purely tag-level organizing scheme for episodes.

`agent_id` is a **top-level** parameter, never a `filters` key — pass it to hard-scope recall to episodes written by that agent. It only applies on the query path: omit `query` for the importance-ranked listing and `agent_id` is not applied.

Before filtering on a `topic`/`project_path`/tag value you're not sure exists, call `memory_topics`, `memory_list_projects`, or `memory_list_entities` to see what's actually in the store — a filter on a value nothing carries returns nothing.

## Write durable findings

`project_path` is **required** — pass the calling agent's actual workspace root explicitly, every time. There is no cwd/env/git fallback: an omitted or empty value fails the call outright with `{ code: "E_MISSING_PROJECT_PATH" }` before anything is written, and a wrong guess can't be fixed by rewriting (the dedup key ignores `project_path`) — only `memory_update` can correct it in place. There is no `scope` parameter on `memory_write`; a write lands in whichever store `db_path` selects (default: the shared user-scope store) — don't pass `scope` here, it only exists on `memory_recall` as a cosmetic label.

```jsonc
memory_write({
  content: "<the finding — one focused idea>",
  project_path: "/Users/you/repo",   // REQUIRED — your actual workspace root, never inferred
  topic: "<topic>",                  // drives organization + filtered recall
  tags: ["<concept>"],               // also creates linkable entity nodes
  name: "<title>",                   // optional episode title
  summary: "<1-3 sentences>",        // optional; an extractive summary is generated if omitted
  source: "document",                // message | tool_output | observation | document | reflection | import
  agent_id: "<your-agent-name>",
  importance: 7,                     // optional, 1-10
  metadata: { original_path: "<source path if any>" }
})
```

`memory_write_batch` enforces the same rule per item — any item missing `project_path` rejects the whole batch before any of it is written.

**Chunk large content.** Write one focused idea per node, not a whole document — a multi-section doc as one node embeds only its first ~512 tokens (the rest is unsearchable) and crowds recall. `memory_write`'s `chunk_size` (default 500 tokens) splits oversized content at sentence boundaries into separate episodes linked back to the parent by a `DERIVED_FROM` edge — or split manually into a short summary node plus per-section nodes yourself.

### `kind:`/`audience:` — tag-prefix conventions, not fields

Lifecycle and audience axes are plain tag prefixes recalled through `tags`, not dedicated fields:

```jsonc
// write — mark the intended reader and lifecycle kind
memory_write({
  content: "Orchestrators: dispatch.json depends_on must declare a dep for any shared file.",
  project_path: "/Users/you/repo",
  tags: ["audience:orchestrator", "kind:pattern"],
  source: "observation", agent_id: "flash-impl"
})

// recall — pull everything addressed to orchestrators
memory_recall({
  query: "parallel dispatch file-conflict safety",
  filters: { tags: ["audience:orchestrator"] },
  token_budget: 50000, limit: 8
})
```

## Edit or correct a finding

`memory_update` edits an existing node in place — the `uid` is the required selector and is immutable. Changing `content` or `summary` re-embeds automatically; `metadata` deep-merges by default:

```jsonc
memory_update({
  uid: "<episode_uid>",
  metadata: { reviewed_by: "code-reviewer" },  // deep-merged into node.meta
  importance: 8                                 // and/or content/summary/name/topic/tags/t_occurred
})
```

To correct a *fact* rather than a node, prefer supersession: `memory_write` the replacement episode, then `memory_invalidate` the old one with a `replacement_uid` pointing at the new episode's uid — the old claim stays visible under `as_of` point-in-time recall but drops from current recall.

## Other tools

- **Discover valid filter values:** `memory_topics`, `memory_list_projects`, `memory_list_entities`, `memory_search_entities`.
- **Graph traversal:** `memory_related` (neighbours), `memory_entity_episodes` (episodes mentioning an entity), `memory_get_community` (a cluster + members), `memory_supersession_chain`, `memory_near_duplicates`.
- **Curate:** `memory_curate` with an `op` of `retag`, `set_topic`, `set_importance`, `merge_duplicates`, or `recluster`.
- **Session state:** `memory_get_session_state` / `memory_save_session_state`.
- **Health:** `memory_stats` (coverage + cluster quality), `memory_ping` (liveness), `memory_link` (create an edge between two existing nodes).

`memory-server`'s own README documents the full input/output schema for all 20 tools.

## Output shapes

`memory_recall` returns ranked results, each with `uid`, `content`, `score`, `provenance` (which of `vec`/`fts`/`temporal` matched), `agent_id`, `content_hash`, plus `summary`, `topic`, `tags`, `project_path`, `importance`, `is_superseded`, `supersedes_uid`, and `community_uid`. `memory_write` returns `{ episode_uid, enrichment: { topic, project_path, project_path_source, summary, tags, near_dup } }` (`project_path_source` is `"explicit"` for a caller-supplied value), or `{ code: "E_DEDUP", existing_uid }` for a content-hash duplicate — writes are idempotent by content hash. `near_dup` is always `null` in that immediate response; near-duplicate detection is asynchronous — call `memory_near_duplicates` afterward to check whether a `SAME_AS` edge landed. `memory_update` returns `{ uid, updated_fields, reembedded }`.

## Gotchas

- **Writes are async-embedded.** The embedding lands *after* `memory_write` returns: a fresh episode is keyword/temporal-recallable immediately but vector-recallable only once the async embed completes (typically well under a second). A purely semantic recall fired right after a write can come back empty — that's expected latency, not broken recall.
- **`db_path` allowlist:** writes and recalls must target `~/.memory/**` when the host enforces permissions.
- **Provenance is retrieval signals, not a source URL.** `provenance` reports which of `vec`/`fts`/`temporal` matched — cite the `uid`, and keep the actual source in the node's content or metadata.

## Examples

- *Recall before researching:* `memory_recall({query:"token cost optimization for multi-agent dispatch", token_budget:50000, limit:5})` — reuse the top findings by `uid`, research only the gap.
- *Write a finding:* `memory_write({content:"Thin orchestrator holds only board + state deltas; executors hold working context.", project_path:"/Users/you/repo", source:"document", agent_id:"workflow-researcher", metadata:{topic:"execution-context-partition"}})`.

## License

MIT
