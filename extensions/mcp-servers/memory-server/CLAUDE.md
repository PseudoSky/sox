# Agent Memory Server — LLM Guidance

## Purpose

Use this when an agent needs durable, searchable memory across sessions — exposes 7 `memory_*` tools over a single-file SQLite graph store with hybrid recall (<50 ms, zero LLM), write-enqueue, session state, community lookup, and bi-temporal invalidation.

## When to call tools from this server

Call tools from `memory-server` when:
- You need to persist a fact, observation, or decision so it survives beyond the current context window.
- You need to retrieve memories relevant to the current task by semantic similarity, keyword, or recency.
- You need to save or restore session working-memory state at conversation boundaries.
- You need to look up an entity's community cluster for graph-level context.
- You need to invalidate a claim that has been superseded without losing the historical record.

Do NOT call `memory_write` for transient scratchpad data — use context window state instead. Do NOT call `memory_recall` if you only need entity lookup by name — use `memory_search_entities` instead.

## Available tools

### `memory_write`

Write a memory episode to the store. Enqueues async organisation by `memory-organizer`; never blocks on LLM.

**Input:**
```json
{
  "content":    "<string, required>",
  "db_path":    "<string, required — path to .db file>",
  "session_id": "<string, optional>",
  "t_occurred": "<ISO timestamp, optional>",
  "agent_id":   "<string, optional>",
  "source":     "<'message'|'tool_output'|'observation'|'document'|'reflection'|'import', optional>",
  "importance": "<number 1–10, optional>"
}
```

**Output:** `{ "episode_uid": "<string>" }`

---

### `memory_recall`

Hybrid vec+BM25+temporal recall, <50 ms, zero LLM. Returns ranked results within a token budget.

**Input:**
```json
{
  "query":        "<string, required>",
  "db_path":      "<string, required>",
  "scope":        "<'project'|'user'|'org'|'local', optional>",
  "agent_id":     "<string, optional — boosts matching agent's episodes ×1.25>",
  "as_of":        "<ISO timestamp, optional — point-in-time recall>",
  "token_budget": "<number, default 4000>",
  "depth":        "<number, default 1 — graph expansion depth>",
  "limit":        "<number, default 10>"
}
```

**Output:** `{ "results": [{ "uid", "content", "score", "t_valid", "scope", "provenance", "importance", "content_hash", "agent_id" }], "provider_call_count": 0 }`

---

### `memory_search_entities`

Search entity nodes by name or summary text.

**Input:** `{ "query": "<string>", "db_path": "<string>", "entity_type": "<string, optional>", "limit": "<number, default 10>" }`

---

### `memory_get_session_state` / `memory_save_session_state`

Retrieve or upsert session working-memory state (a JSON blob keyed by session_id).

---

### `memory_get_community`

Look up the community cluster for an entity by uid and hierarchy level.

---

### `memory_invalidate`

Bi-temporally invalidate a claim: sets `t_invalid` on the node (never deletes). Optionally records a SUPERSEDES edge to a replacement.

## Error handling

Tools return `{ "isError": true, "content": [{ "type": "text", "text": "..." }] }` on error. Common error codes: `E_NOT_FOUND` (claim or entity not found).

## Transport

stdio — one JSON-RPC 2.0 request per line, one JSON response per line.

Implements: `initialize`, `tools/list`, `tools/call`.

## Server id

`memory-server`
