# Memory System: Design Flaws and Solution

## Executive Summary

The sox-memory subsystem has three layers of interconnected design debt. The first is a
process-boundary violation: `openDb()` (better-sqlite3 + sqlite-vec native) and `embed()`
(ONNX via fastembed) are both called in the same Node process, but their native addons
share a libc mutex that corrupts across async boundaries. This forces bulk ingest to go
through the MCP server as a workaround, adding latency and eliminating the in-process API
as a usable surface.

The second layer is API incompleteness: the 7 `memory_*` MCP tools expose write and recall
but no edge/link creation, no chunking, and a `token_budget` default that silently truncates
results to 1 node for document-scale content. Tool callers have no programmatic path to
build a graph; they must go through the organizer (which requires the daemon) or raw SQL.

The third layer is metadata and model-tracking drift: `initScope` pins
`memory_scope.embed_model` to the static `EMBED_MODEL` constant (`nomic-embed-text-v1.5-hash`)
rather than calling `getActiveEmbedModel()` after the first embed. When the real backend
(BGE-base-en-v1.5) loads, the pinned model is wrong, defeating the re-embed-on-model-change
mechanism. In parallel, `reembedNodes` is defined and used internally but not exported from
the package index, so external callers that need to re-embed on model change cannot reach it.

These three clusters of debt compound: the native-addon crash prevents in-process use,
which forces all callers into the MCP tool surface, which is then incomplete (no edges,
no chunking) and returns degraded results (tiny token budget, wrong recency weighting for
clustered writes). Fixing them independently produces partial wins; fixing them in order
delivers a coherent subsystem.

---

## Design Flaw 1: Native Addon Interference Across Async Boundaries (BL-11)

**What is broken:**  
`libs/memory-core/src/db.ts:openDb` loads `better-sqlite3` (native addon with a libsqlite3
file descriptor) and `sqlite-vec` (a second native loadable extension). In the same process,
`libs/memory-core/src/embed.ts:embed` (async) loads `fastembed` via `onnxruntime-node`
(a third native addon). When `await embed(text)` is called after `openDb()`, ONNX's internal
thread pool fires across an async boundary while better-sqlite3's connection is open. The
result is `TypeError: The database connection is not open` and
`libc++abi: terminating … mutex lock failed: Invalid argument` — the ONNX thread pool
corrupts the SQLite handle's internal mutex.

**Which BLs it explains:** BL-11 (the crash itself). It is a precondition for understanding
why BL-13 (chunking) is hard to fix in-process: chunked writes multiply the embed→db
call interleaving, making crashes more frequent.

**The correct design:**  
The embedding step must execute in a separate process from the SQLite write step. Two
viable approaches:

1. All writes go through the MCP server (a separate process): the MCP server is already
   across a process boundary from the caller, so each tool call issues one embed+write cycle
   without a caller that also holds an open DB handle.
2. A dedicated embed worker (child_process or worker_thread): the parent holds the DB,
   the worker runs ONNX, result is IPC'd back. More complex but enables in-process library
   use for tooling that does not want the MCP overhead.

The existing workaround ("bulk ingest must go through the MCP server") is correct but
undocumented and not enforced. The real fix is to document the constraint and ensure the
`@adhd/sox-memory-core` convenience wrappers (`write()`, `recall()`) either enforce the process
boundary or carry a clear warning.

**Why the current design drifted here:**  
`embed.ts` was originally a hash backend (pure JS, zero native). When the real ONNX backend
was added, the mutex conflict did not appear in unit tests because tests mock or stub embed.
In integration the conflict only surfaces under the specific interleave order
(openDb → await embed → db write), which only appears in full ingest flows.

---

## Design Flaw 2: Incomplete MCP Tool Surface (BL-9, BL-13, BL-14)

**What is broken:**  
The 7 `memory_*` tools (`extension.json` lines 28–135) provide write and recall but no
edge/link creation. The schema has an `edge` table and a well-defined edge model
(`MENTIONS`, `SUPPORTS`, `RELATES_TO`, `DERIVED_FROM`, `SUPERSEDES`), but no MCP tool
exposes it. Importers and agents that want to link two nodes — e.g., chunk→parent
(`DERIVED_FROM`) — must either call the organizer pipeline (async, requires daemon) or
bypass the API entirely with raw SQL.

`memory_write` (`extension.json` line 34, `libs/memory-core/src/write.ts:memoryWrite`)
stores entire content as a single node and embeds it in one call. BGE-base-en-v1.5
(the real backend) encodes only the first ~512 tokens. For document-scale input, later
content is not semantically indexed. There is no chunking layer in `memoryWrite` or in
the MCP handler; callers must pre-chunk.

`memory_recall` (`libs/memory-core/src/recall.ts`, line 296) collects top-N by RRF score,
but when many chunks come from the same document they all rank together. One verbose source
can fill all top-N slots. No per-source cap or MMR diversity filter exists in the
post-ranking step (lines 271–313).

**The correct design:**

- Add `memory_link` MCP tool: `{src_uid, dst_uid, rel, weight?, meta?}` → insert into
  `edge` table. Guards: both UIDs must exist; rel must be a known enum.
- Add optional chunking to `memory_write`: if `auto_chunk: true` or `chunk_size: N` is
  passed, split content, embed each chunk, insert nodes, link them with `DERIVED_FROM`
  edges to a synthetic parent summary node. Return `{episode_uid, chunk_uids[]}`.
- Add diversity cap to `memoryRecall` results assembly (lines 293–303): track
  `source_uid` (derived from `provenance` or a new `source_doc` column), enforce max 2
  results per source before filling remaining slots from other sources.

**Why the current design drifted here:**  
The 7-tool surface was designed as a P1 MVP. Edges were intended for the organizer
pipeline (async, LLM-driven entity/relation extraction). Chunking was left to callers.
Diversity was not considered at P1 because the corpus was small. These are all known
TODOs that were not blocked behind an architectural gate.

---

## Design Flaw 3: Embedding Model Tracking Inconsistency (BL-2, BL-10, BL-12)

**What is broken:**  
`libs/memory-core/src/embed.ts` exports two things with the same purpose but different
values:

- `EMBED_MODEL` (line 41): a frozen string constant `'nomic-embed-text-v1.5-hash'`
  that never changes.
- `getActiveEmbedModel()` (line 35): a function that returns `_activeModel`, which is
  updated to `'bge-base-en-v1.5'` when the real backend initializes (line 121).

`initScope` in `libs/memory-core/src/db.ts` (line 71) calls
`INSERT INTO memory_scope … EMBED_MODEL …` — it imports and uses the frozen constant,
not `getActiveEmbedModel()`. So the first time a scope is initialized, it records
`'nomic-embed-text-v1.5-hash'` as the active model even when the real BGE backend has
already been loaded. The `re-embed-on-model-change` mechanism compares
`memory_scope.embed_model` against the active model; since the scope always shows the
wrong value, the comparison is always false and reindex is never triggered.

`reembedNodes` is defined at `libs/memory-core/src/embed.ts` line 228 and imported by
`libs/memory-core/src/memoryd.ts` line 29, but `libs/memory-core/src/index.ts` does not
re-export it (the export block at line 22–33 omits `reembedNodes`). External callers
(`require('@adhd/sox-memory-core').reembedNodes`) receive `undefined`.

**The correct design:**  
`initScope` must call `getActiveEmbedModel()` (not the constant) when writing
`memory_scope.embed_model`. The constant `EMBED_MODEL` should be deprecated or removed;
all callers that need the active model must use `getActiveEmbedModel()`.

`reembedNodes` must be added to the export block in `index.ts`.

**Why the current design drifted here:**  
`EMBED_MODEL` predates the dual-backend architecture. When `getActiveEmbedModel()` was
added as a migration path, `initScope` was not updated. The `EMBED_MODEL` constant was
kept for backwards compatibility with `import { EMBED_MODEL }` callers, but the comment
at line 38–41 does not make the `initScope` call site risk obvious.

---

## Design Flaw 4: Recall Quality — RRF Fusion Weights and Token Budget (BL-3, BL-8)

**What is broken:**  
`memoryRecall` fuses three signals via RRF with equal weight:

- Vec KNN (semantic similarity)
- FTS5 BM25 (keyword)  
- Temporal recency (most recently created nodes)

For writes clustered in time (all within minutes of each other), the temporal component
contributes approximately equal RRF score across all candidates. With small semantic
rank-score deltas (e.g., several episodes about the same topic), the temporal signal
dominates the ranking, returning "most recent" rather than "most semantically similar"
results.

`DEFAULT_TOKEN_BUDGET` (line 55) is 4000 tokens. The budget-check at `recall.ts:279`
(`if (tokenCount + tokens > token_budget && results.length > 0) return false`) exits
on the first node that would exceed budget. For document-scale nodes (single large content),
one node can consume 4000 tokens, causing `limit: 10` to silently return 1 result.

**The correct design:**  

- Expose explicit per-signal RRF weights as parameters: `vec_weight`, `fts_weight`,
  `temporal_weight`, with defaults that demote temporal when the corpus is temporally
  clustered. A reasonable default: vec=1.0, fts=0.8, temporal=0.4 (not the current
  implicit 1:1:1).
- Raise `DEFAULT_TOKEN_BUDGET` to 32000 (the practical floor for useful multi-result
  recall), or scale with `limit` parameter: `DEFAULT_TOKEN_BUDGET = limit * 2000`.
- Document that callers should set `token_budget` explicitly when using document-scale
  content.

**Why the current design drifted here:**  
Equal weights were an MVP default. The temporal signal was added to surface recent episodes
that had not yet been organized by the daemon; it was intended as a secondary boost, not
a primary ranking signal. Token budget was set to 4000 to match a small context window
assumption from P1.

---

## Design Flaw 5: Missing `memory_link` Tool Exposes the Edge/Node API Gap (BL-9 cross-reference with Flaw 2)

This is fully described under Flaw 2. It is listed separately because the fix is
independent of chunking and can be shipped in Phase 0.

---

## Cross-References Between Flaws

- **Flaw 1 (native addon crash) × Flaw 2 (chunking):** Adding chunking to `memory_write`
  multiplies the embed→db call interleaving. Chunking MUST NOT be implemented in-process
  until Flaw 1 is resolved or until chunking is routed through the MCP server boundary.
- **Flaw 3 (model tracking) × Flaw 1 (native addon crash):** `reembedNodes` (BL-12) is
  called by the daemon's reindex op, which runs in a separate process (the daemon). Since
  the daemon does not share a process with the MCP server, Flaw 1 does not affect
  `reembedNodes`. However, `reembedNodes` being unexported means external tooling cannot
  trigger reindex without going through the daemon's queue.
- **Flaw 4 (token budget) × Flaw 2 (chunking):** If chunking is added first, the token
  budget default becomes less critical (each chunk is small). If token budget is raised
  first, it partially mitigates the document-scale recall problem without solving root cause.

---

## Non-Goals

- OS-kernel sandboxing of SQLite writes (explicit non-goal per C6 scope).
- Replacing the SQLite backend with a server database.
- Redesigning the organizer pipeline or the LLM step.
- Fixing `memory-organizer` type/role classification (tracked in ecosystem-feedback plan).
- Any changes to the `@adhd/sox-mcp-runtime` consolidation (BL-5); that is tracked in
  ecosystem-feedback plan.
- Performance benchmarking or SLA-setting for recall latency beyond what the existing
  `<50ms` invariant covers.
