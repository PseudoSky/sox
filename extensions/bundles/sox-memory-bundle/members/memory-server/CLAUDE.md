# Agent Memory Server — LLM Guidance

## Purpose

Use this when an agent needs durable, searchable memory across sessions — exposes **20 `memory_*` tools** (v1.1.0) over a single-file SQLite graph store with hybrid recall (<50 ms, zero LLM), deterministic enrichment (provenance, tags, topic, near-dup detection), session state, community/cluster lookup, curation, bi-temporal invalidation, and in-place node editing.

## When to call tools from this server

Call tools from `memory-server` when:
- You need to persist a fact, observation, or decision so it survives beyond the current context window.
- You need to retrieve memories relevant to the current task by semantic similarity, keyword, recency, or filter (topic/project/tags).
- You need to save or restore session working-memory state at conversation boundaries.
- You need to discover topics, projects, or entities in the memory store before filtering a recall.
- You need to look up near-duplicate pairs, supersession chains, or graph neighbors.
- You need to invalidate a claim that has been superseded without losing the historical record.
- You need to correct or enrich an existing episode in-place (e.g. fix a typo, add metadata, override topic) without creating a new node — use `memory_update`.

Do NOT use `memory_update` to change a node's identity (`uid` is always immutable). Do NOT call `memory_write` for transient scratchpad data — use context window state instead. Do NOT call `memory_recall` if you only need entity lookup by name — use `memory_search_entities` instead.

## Available tools

### `memory_write` (v1 — MODIFIED)

Write a memory episode. Runs deterministic enrichment synchronously (provenance, tags, topic, near-dup, extractive summary). Batch enrichments (clustering, auto-links, importance) run asynchronously in the daemon. Never blocks on LLM.

**New in v1:** `name`, `topic`, `project_path`, `derived_from_uid` inputs; `enrichment` in output.

**Input:**
```json
{
  "content":          "<string, required>",
  "db_path":          "<string, required — path to .db file>",
  "summary":          "<string, optional — persisted to node.summary>",
  "name":             "<string, optional — title for this episode>",
  "topic":            "<string, optional — explicit topic override>",
  "tags":             "<string[], optional — concept tags (also creates entity nodes)>",
  "metadata":         "<object, optional — persisted as node.meta JSON>",
  "project_path":     "<string, optional — auto-detected from cwd+git if omitted>",
  "derived_from_uid": "<string, optional — emits DERIVED_FROM edge to parent>",
  "session_id":       "<string, optional>",
  "t_occurred":       "<ISO timestamp, optional>",
  "agent_id":         "<string, optional>",
  "source":           "<'message'|'tool_output'|'observation'|'document'|'reflection'|'import', optional>",
  "importance":       "<number 1–10, optional>",
  "chunk_size":       "<number, default 500 — auto-split long content>"
}
```

**Output:** `{ "episode_uid": "<string>", "enrichment": { "topic", "project_path", "summary", "tags", "near_dup" } }`

---

### `memory_recall` (v1 — MODIFIED)

Hybrid vec+BM25+temporal recall, <50 ms, zero LLM. `query` is now optional — omit for importance-ranked listing. Results carry enrichment fields in v1.

**New in v1:** `filters` object (project_path, topic, tags, importance_min, time range); `query` optional.

**Input:**
```json
{
  "query":        "<string, optional — omit for importance-ranked listing>",
  "db_path":      "<string, required>",
  "scope":        "<'project'|'user'|'org'|'local', optional>",
  "agent_id":     "<string, optional>",
  "as_of":        "<ISO timestamp, optional>",
  "token_budget": "<number, default 4000>",
  "depth":        "<number, default 1>",
  "limit":        "<number, default 10>",
  "filters": {
    "project_path":    "<string | {prefix: string}, optional>",
    "topic":           "<string | string[], optional>",
    "tags":            "<string[], optional — any-match>",
    "tags_match_all":  "<boolean, default false>",
    "importance_min":  "<number, optional>",
    "t_created_after": "<ISO timestamp, optional>",
    "t_created_before":"<ISO timestamp, optional>"
  }
}
```

**Output:** `{ "results": [{ "uid", "content", "score", "t_valid", "scope", "provenance", "importance", "content_hash", "agent_id", "summary", "topic", "tags", "project_path", "is_superseded", "supersedes_uid", "community_uid" }], "provider_call_count": 0 }`

---

### `memory_search_entities` (unchanged)

Search entity nodes by name or summary text.

**Input:** `{ "query": "<string>", "db_path": "<string>", "entity_type": "<string, optional>", "limit": "<number, default 10>" }`

---

### `memory_topics` (NEW — C2.3)

List topics in the store with episode counts and cluster backing status. Use before `memory_recall` to discover valid topic filter values.

**Input:** `{ "db_path": "<string>", "project_path"?: string, "search"?: string, "sort_by"?: "episode_count"|"avg_importance"|"last_written", "limit"?: number, "offset"?: number }`

**Output:** `{ "topics": [{ "topic", "episode_count", "avg_importance", "last_written", "community_uid", "has_community" }], "total" }`

---

### `memory_list_projects` (NEW — C2.4)

List distinct `project_path` values in the store with episode counts.

**Input:** `{ "db_path": "<string>", "limit"?: number, "offset"?: number }`

**Output:** `{ "projects": [{ "project_path", "episode_count", "last_written" }], "total" }`

---

### `memory_list_entities` (NEW — C2.5)

List entity nodes ranked by mention count. For lookup by name/type, use `memory_search_entities` instead.

**Input:** `{ "db_path": "<string>", "project_path"?: string, "topic"?: string, "search"?: string, "limit"?: number, "offset"?: number }`

**Output:** `{ "entities": [{ "uid", "name", "mention_count", "first_seen", "last_seen" }], "total" }`

---

### `memory_get_community` (v1 — MODIFIED)

Get a community node and its members. Now accepts `community_uid` directly in addition to `entity_uid`.

**New in v1:** `community_uid` input; output has `label`, `member_count`, `mean_intra_sim`, `centroid_episode_uid` (instead of v0's `name` field).

**Input:** `{ "db_path": "<string>", "entity_uid"?: string, "community_uid"?: string, "level"?: number }`

**Output:** `{ "community": { "uid", "label", "member_count", "mean_intra_sim", "centroid_episode_uid", "t_created" }, "members": [{ "uid", "summary", "topic", "importance", "t_created", "project_path", "tags" }] }`

**Breaking change from v0:** `community.name` is now `community.label`.

---

### `memory_entity_episodes` (NEW — C2.7)

Return episodes that mention a given entity via MENTIONS edges, ranked by importance.

**Input:** `{ "db_path": "<string>", "entity_uid"?: string, "entity_name"?: string, "limit"?: number, "offset"?: number }`

**Output:** `{ "entity": { "uid", "name" }, "episodes": [EpisodeSummary], "total" }`

---

### `memory_related` (NEW — C2.8)

Return graph neighbors of an episode at depth=1 (RELATES_TO, DERIVED_FROM, SUPPORTS, SAME_AS).

**Input:** `{ "db_path": "<string>", "uid": "<string>", "rel"?: string[], "limit"?: number }`

**Output:** `{ "source_uid": string, "edges": [{ "episode": EpisodeSummary, "rel", "weight", "direction": "outbound"|"inbound" }] }`

---

### `memory_supersession_chain` (NEW — C2.9)

Return the full supersession chain for an episode — what it supersedes and what supersedes it.

**Input:** `{ "db_path": "<string>", "uid": "<string>" }`

**Output:** `{ "canonical_uid": string, "chain": [{ "uid", "t_created", "t_invalid", "reason" }], "is_current": boolean }`

---

### `memory_near_duplicates` (NEW — C2.10)

List near-duplicate episode pairs connected by SAME_AS edges.

**Input:** `{ "db_path": "<string>", "project_path"?: string, "topic"?: string, "threshold"?: number, "limit"?: number, "offset"?: number }`

**Output:** `{ "pairs": [{ "uid_a", "uid_b", "cosine_sim", "content_preview_a", "content_preview_b", "already_merged" }], "total" }`

---

### `memory_curate` (NEW — C2.11)

Curation operations: retag, set topic, override importance, merge near-duplicates, or trigger re-cluster.

**Input:** `{ "db_path": "<string>", "op": "retag"|"set_topic"|"set_importance"|"merge_duplicates"|"recluster", "uid"?: string, "tags"?: string[], "topic"?: string, "importance"?: number, "uid_keep"?: string, "uid_drop"?: string, "dry_run"?: boolean }`

**Outputs by op:**
- `retag`: `{ op, uid, tags_added, new_entity_uids }`
- `set_topic`: `{ op, uid, old_topic, new_topic }`
- `set_importance`: `{ op, uid, old_importance, new_importance }`
- `merge_duplicates`: `{ op, uid_kept, uid_dropped, same_as_edge_uid, dry_run }`
- `recluster`: `{ op, enqueued, dry_run? }`

---

### `memory_stats` (NEW — C2.12)

Return enrichment coverage and cluster quality statistics. `tool_version: "1.1.0"` signals the v1.1 surface (including `memory_update`) is present.

**Input:** `{ "db_path": "<string>", "project_path"?: string }`

**Output:** `{ "tool_version", "enrich_version", "embed_model", "total_episodes", "with_topic", "with_summary", "with_tags", "with_project_path", "with_community", "legacy_episodes", "stale_episodes", "cluster_count", "largest_cluster_size", "mean_intra_cluster_sim", "coverage", "cluster_quality" }`

---

### `memory_update` (NEW — v1.1)

In-place editor for an existing live node. Distinct from supersession: the `uid` is immutable and the existing node is modified rather than replaced. Use when you need to correct, enrich, or extend an existing episode. When `content` or `summary` changes, the embedding is refreshed automatically (re-embed). FTS is auto-synced by the database trigger.

**Input:**
```json
{
  "uid":            "<string, required — UID of the live node to update>",
  "db_path":        "<string, required>",
  "content":        "<string, optional — replaces node.content; triggers re-embed>",
  "summary":        "<string, optional — replaces node.summary; triggers re-embed>",
  "name":           "<string, optional>",
  "topic":          "<string, optional>",
  "tags":           "<string[], optional — replaces existing tags wholesale>",
  "importance":     "<number 1–10, optional>",
  "metadata":       "<object, optional — merged into or replaces node.meta>",
  "metadata_merge": "<'deep'|'replace', default 'deep'>",
  "t_occurred":     "<ISO timestamp, optional>",
  "t_valid":        "<ISO timestamp, optional>"
}
```

**`metadata_merge` semantics:**
- `'deep'` (default): recursive merge — nested objects are merged field-by-field; **arrays are replaced** (not concatenated).
- `'replace'`: overwrites `node.meta` wholesale with the supplied object.

**Output (success):**
```json
{ "uid": "<string>", "updated_fields": ["content", "topic", ...], "reembedded": true }
```

**Output (error):**
```json
{ "code": "E_NOT_FOUND", "message": "..." }
{ "code": "E_NO_FIELDS",  "message": "..." }
```

**Immutability contract:**
- `uid` — never changes (identity anchor).
- `t_created` — never touched (audit anchor).
- `t_updated` — set to `now` on every successful update.

---

### `memory_get_session_state` / `memory_save_session_state` (unchanged)

Retrieve or upsert session working-memory state (a JSON blob keyed by session_id).

---

### `memory_invalidate` (unchanged)

Bi-temporally invalidate a claim: sets `t_invalid` on the node (never deletes). Optionally records a SUPERSEDES edge to a replacement.

## Error handling

Tools return `{ "isError": true, "content": [{ "type": "text", "text": "..." }] }` on error. Common error codes:
- `E_NOT_FOUND` — episode, entity, or community not found
- `E_DEDUP` — duplicate content (write path)
- `E_AMBIGUOUS` — ambiguous lookup (entity_name matches multiple, or both entity_uid and community_uid supplied)
- `E_MISSING` / `E_MISSING_INPUT` — required parameter not supplied for the operation
- `E_UNKNOWN_OP` — unknown `op` value for memory_curate

## Transport

stdio — one JSON-RPC 2.0 request per line, one JSON response per line.

Implements: `initialize`, `tools/list`, `tools/call`.

## Server version

`memory-server` v1.1.0. Check `memory_stats` → `tool_version` to confirm the surface version: `"1.1.0"` signals v1.1 (including `memory_update`) is active.

## Permissions and db_path constraint

This extension declares an `fs` allowlist covering `~/.memory/**` (both read and write). The host runtime injects this allowlist as an environment policy at spawn time.

The `db_path` parameter accepted by every tool is validated against this allowlist by the in-process permission guard before any database operation begins. If the resolved path falls outside `~/.memory/**`, the guard denies the operation and returns an error — no file is created, no partial write occurs, and no side effects are left on disk.

To use a `db_path` outside `~/.memory/`:
- Reconfigure the `fs.write` and `fs.read` allowlist in this extension's `permissions` block to include the desired path, then re-install.
- Or create a symlink inside `~/.memory/` pointing to the external location.
