# Memory System: Implementation Plan

Items: BL-2, BL-3, BL-8, BL-9, BL-10, BL-11, BL-12, BL-13, BL-14, BL-15

---

## Phase 0 — Non-Blocking Quick Fixes (Parallelizable, No Architectural Dependencies)

These items have zero architectural risk and can be done in any order, in parallel.

---

### P0-A: Export `reembedNodes` from `@sox/memory-core` (BL-12)

**Files to change:**
- `libs/memory-core/src/index.ts`

**Fix:**  
Add `reembedNodes` to the embedding export block at line 22–33:
```
export {
  EMBED_MODEL,
  EMBED_DIM,
  embed,
  embedText,
  vecToJson,
  vecToBuffer,
  getProviderCallCount,
  resetProviderCallCount,
  getActiveEmbedModel,
  reembedNodes,          // ← add this
  _resetEmbedSingleton,
} from './embed.js';
```

**Verification:**
- `require('@sox/memory-core').reembedNodes` is a function, not `undefined`.
- `npx nx build memory-core` exits 0.
- Existing unit tests pass.

---

### P0-B: Fix `initScope` to use `getActiveEmbedModel()` (BL-10)

**Files to change:**
- `libs/memory-core/src/db.ts`

**Fix:**  
Import `getActiveEmbedModel` and use it in the `initScope` INSERT at line 71:
```typescript
import { EMBED_MODEL, EMBED_DIM, getActiveEmbedModel } from './embed.js';
// ...
db.prepare(`INSERT INTO memory_scope(...) VALUES (?, ?, ?, ?, 1, ?)`)
  .run(scope, scopeId, getActiveEmbedModel(), EMBED_DIM, now);
// Also update the return value:
return { ..., embed_model: getActiveEmbedModel(), ... };
```

Note: `getActiveEmbedModel()` returns `'nomic-embed-text-v1.5-hash'` if called before
the first `embed()` resolves. The call site in `initScope` is typically before any embed.
Callers that need the real model pinned should call `await embed('warmup')` before
`initScope`, or accept the hash value and rely on the reindex mechanism to update it
after the daemon initializes.

**Verification:**
- Unit test: call `initScope()` after `await embed('warmup')` with backend='real'; confirm
  `memory_scope.embed_model` row is `'bge-base-en-v1.5'`.
- Existing initScope tests pass.

---

### P0-C: Document `db_path` allowlist in extension.json and CLAUDE.md (BL-15)

**Files to change:**
- `extensions/bundles/sox-memory-bundle/members/memory-server/extension.json`
- `extensions/bundles/sox-memory-bundle/members/memory-server/CLAUDE.md`

**Fix in extension.json:**  
Add a `description` field to the `memory_write` and `memory_recall` tool `db_path` property
clarifying the constraint:
```json
"db_path": {
  "type": "string",
  "description": "Absolute path to the SQLite memory store. Must be within ~/.memory/** (the fs allowlist declared in this extension's permissions block). Paths outside this prefix are denied by the host permission guard with no side effects."
}
```

**Fix in CLAUDE.md:**  
Add a "Permissions and db_path constraint" section under the transport section:

```
## Permissions and db_path constraint

The memory-server process declares an fs allowlist of `~/.memory/**` in its
`extension.json` permissions block. The host injects this as the enforcement boundary
at spawn time. Any `db_path` argument that resolves outside `~/.memory/**` is denied
by the in-process permission guard before the database is opened — no file is created,
no data is written.

To use a db at a non-default path, either:
1. Reconfigure the extension's fs allowlist via `sox config set memory-server` (adds to
   cascade; host regenerates policy on next spawn).
2. Symlink the target directory into `~/.memory/`.
```

**Verification:**
- Verify the updated description appears in `tools/list` response from memory-server.
- Verify CLAUDE.md renders with the new section.

---

### P0-D: Correct `EMBED_MODEL` naming drift (BL-2)

**Files to change:**
- `libs/memory-core/src/embed.ts`

**Fix:**  
Update the `EMBED_MODEL` constant to reflect what the real backend actually loads:
```typescript
// Keep for backwards compat (exported constant); real model name when backend=hash
export const EMBED_MODEL = 'nomic-embed-text-v1.5-hash';
// When backend=real, getActiveEmbedModel() returns 'bge-base-en-v1.5'
```
Add a comment at the `EMBED_MODEL` constant explaining the naming situation:
```typescript
// The EMBED_MODEL constant is the *hash backend* identifier.
// When backend='real' or 'auto' resolves to real, getActiveEmbedModel() returns
// 'bge-base-en-v1.5' (BGE-base-en-v1.5 via fastembed, 768-dim).
// Do not use EMBED_MODEL as a proxy for the active backend — use getActiveEmbedModel().
```

Also update `embed.ts` module-level comment (lines 1–22) to state: "real backend loads
`fast-bge-base-en-v1.5` (BGE-base-en-v1.5, 768-dim, not nomic-embed-text)."

**Verification:**
- `getActiveEmbedModel()` returns `'bge-base-en-v1.5'` after `await embed('warmup')` with
  backend='real'.
- `EMBED_MODEL` constant still exists (backwards compatibility for `import { EMBED_MODEL }`
  callers).

---

### P0-E: Add `memory_link` MCP tool to memory-server (BL-9)

**Files to change:**
- `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
- `extensions/bundles/sox-memory-bundle/members/memory-server/extension.json`

**Fix:**  
Add a `memory_link` handler in `index.ts` alongside the existing `memoryWriteHandler`:
```typescript
async function memoryLinkHandler(
  db: Database.Database,
  args: { src_uid: string; dst_uid: string; rel: string; weight?: number; meta?: Record<string, unknown> }
): Promise<{ edge_uid: string } | { isError: true; content: [{ type: 'text'; text: string }] }> {
  const VALID_RELS = ['MENTIONS', 'SUPPORTS', 'RELATES_TO', 'DERIVED_FROM', 'SUPERSEDES', 'ASSIGNED_TO'];
  if (!VALID_RELS.includes(args.rel)) {
    return { isError: true, content: [{ type: 'text', text: `Unknown rel: ${args.rel}` }] };
  }
  const srcRow = db.prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?').get(args.src_uid);
  const dstRow = db.prepare<[string], { rowid: number }>('SELECT rowid FROM node WHERE uid = ?').get(args.dst_uid);
  if (!srcRow) return { isError: true, content: [{ type: 'text', text: `src_uid not found: ${args.src_uid}` }] };
  if (!dstRow) return { isError: true, content: [{ type: 'text', text: `dst_uid not found: ${args.dst_uid}` }] };
  const edgeUid = `edge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  db.prepare(`INSERT INTO edge (src, dst, rel, origin, t_created, meta) VALUES (?, ?, ?, 'user_asserted', ?, ?)`)
    .run(srcRow.rowid, dstRow.rowid, args.rel, new Date().toISOString(), JSON.stringify(args.meta ?? {}));
  return { edge_uid: edgeUid };
}
```

Register `memory_link` in `handleToolCall` dispatch and in the `tools/list` response.

Add the tool definition to `extension.json` tools array.

**Verification:**
- `tools/list` from memory-server includes `memory_link`.
- `memory_link` with valid UIDs returns `{ edge_uid }`.
- `memory_link` with unknown `src_uid` returns `{ isError: true }`.
- `memory_link` with invalid `rel` returns `{ isError: true }`.

---

## Phase 1 — Recall Quality Fixes (BL-3, BL-8, BL-14)

These can be done in parallel within the phase. They do not depend on Phase 0 completing,
but Phase 0-A and 0-B should land first so the correct model is in scope metadata.

---

### P1-A: Raise `DEFAULT_TOKEN_BUDGET` and document (BL-8)

**Files to change:**
- `libs/memory-core/src/recall.ts`

**Fix:**  
Change line 55:
```typescript
const DEFAULT_TOKEN_BUDGET = 32000;  // was 4000 — too small for doc-scale nodes
```
Also update `extension.json` `memory_recall` tool schema to reflect the new default:
```json
"token_budget": { "type": "number", "default": 32000 }
```
Update `extensions/bundles/sox-memory-bundle/members/memory-server/extension.json`
line 63 similarly.

**Verification:**
- Write 10 document-scale nodes (~1000 words each).
- `memory_recall` with `limit: 10` and no explicit `token_budget` returns 10 results.
- `memory_recall` with `token_budget: 100` still stops early (budget guard still works).

---

### P1-B: Demote temporal RRF weight (BL-3)

**Files to change:**
- `libs/memory-core/src/recall.ts`

**Fix:**  
At lines 194–202, multiply each signal's RRF contribution by a configurable weight.
Add per-signal weight constants and apply them:
```typescript
const VEC_WEIGHT = 1.0;
const FTS_WEIGHT = 0.8;
const TEMPORAL_WEIGHT = 0.4;  // temporal is a tiebreaker, not a primary signal

// In the fusion loop:
if (vr !== undefined) score += VEC_WEIGHT * rrfScore(vr);
if (fr !== undefined) score += FTS_WEIGHT * rrfScore(fr);
if (tr !== undefined) score += TEMPORAL_WEIGHT * rrfScore(tr);
```

Expose as optional `RecallParams` fields so callers can override:
```typescript
export interface RecallParams {
  ...
  vec_weight?: number;
  fts_weight?: number;
  temporal_weight?: number;
}
```

**Verification:**
- Write 10 nodes about "authentication" with timestamps 1 minute apart.
- Write 1 node about "billing" 1 minute before the recall.
- `memory_recall({ query: 'authentication' })` must rank authentication nodes above the
  billing node despite billing being most recent.
- `memory_recall({ query: 'recent', temporal_weight: 2.0 })` inverts the ranking.

---

### P1-C: Add per-source diversity cap (BL-14)

**Files to change:**
- `libs/memory-core/src/recall.ts`

**Fix:**  
In the result assembly loop (lines 296–303), track how many results have come from each
`source_doc` (derived from `provenance[0]` or a new `source_uid` column). Cap per-source
at `max(2, Math.ceil(limit / 5))`:
```typescript
const sourceCounts = new Map<string, number>();
const MAX_PER_SOURCE = Math.max(2, Math.ceil(limit / 5));

// In addResult:
const sourceKey = node.content_hash ?? node.uid;  // proxy for source doc
const count = sourceCounts.get(sourceKey) ?? 0;
if (count >= MAX_PER_SOURCE) return false;  // skip this result
sourceCounts.set(sourceKey, count + 1);
```

Note: a proper MMR implementation requires embedding distances between candidates.
The diversity cap is a simpler proxy that does not require re-embedding.

**Verification:**
- Write 20 chunks all derived from the same document (same content_hash prefix).
- `memory_recall` with `limit: 10` returns at most `max(2, 2)=2` results from that
  document and fills remaining 8 slots from other documents.
- With a diverse corpus, recall returns up to `limit` results without artificial cap.

---

## Phase 2 — Native Addon Isolation (BL-11)

This phase must be done after Phase 0 is complete. It touches the most fundamental
invariant of the subsystem and requires its own verification gate.

---

### P2-A: Document the process-boundary constraint for in-process callers (BL-11, part 1)

**Files to change:**
- `libs/memory-core/src/index.ts`
- `libs/memory-core/README.md` (if exists, else add a section to the package's
  `package.json` description)

**Fix:**  
Add a prominent module-level comment to `libs/memory-core/src/index.ts`:
```typescript
/**
 * @sox/memory-core — shared internal library for the sox-memory subsystem.
 *
 * PROCESS BOUNDARY CONSTRAINT:
 * Do NOT call `openDb()` and `await embed()` in the same process when using the
 * real (ONNX) embedding backend. The ONNX native addon (onnxruntime-node) and
 * better-sqlite3 + sqlite-vec share a libpthread mutex that is corrupted across
 * async boundaries, producing "mutex lock failed: Invalid argument" crashes.
 *
 * Safe usage patterns:
 *   - Use openDb() in a process that never calls embed() with backend='real'.
 *   - Use embed() in a process that never calls openDb() with sqlite-vec loaded.
 *   - Route all writes through the MCP server (separate process, safe by default).
 *   - Use SOX_EMBED_BACKEND=hash to eliminate the ONNX addon entirely.
 */
```

**Verification:**
- Documentation added.
- Existing unit tests still pass (they use hash backend or mock embed, so are unaffected).

---

### P2-B: Needs spike — evaluate embed worker thread approach (BL-11, part 2)

**Status:** Needs spike before implementation.

**What to investigate:**
- Can `onnxruntime-node` be loaded in a Node `worker_thread` while `better-sqlite3`
  is loaded in the main thread, with only Float32Array results IPC'd back?
- If worker_thread isolation prevents the mutex conflict, implement an `embedWorker.ts`
  that accepts `{text: string}` via `parentPort.on('message')` and responds with a
  `Float32Array`.
- The `embed()` function in `embed.ts` would then proxy to the worker for backend='real'.

**Files to change (after spike):**
- `libs/memory-core/src/embed.ts` — add worker proxy path
- `libs/memory-core/src/embedWorker.ts` — new worker thread

**Verification:**
- `openDb()` + `await embed(text, {backend:'real'})` + `db.prepare(...).run(...)` in a
  single Node process does not crash.
- Existing unit tests pass.
- The full ingest benchmark (`tools/bench-scale.js`) completes without crash.

---

## Phase 3 — Chunking Pipeline (BL-13)

This phase depends on Phase 2 (native addon isolation) being resolved, or being
explicitly scoped to route through the MCP server boundary. Do not implement
in-process chunking until the addon constraint is resolved or explicitly accepted.

---

### P3-A: Add optional chunking to `memory_write` (BL-13)

**Files to change:**
- `libs/memory-core/src/write.ts` (add chunking logic to `memoryWrite`)
- `libs/memory-core/src/index.ts` (export `chunkContent` helper if extracted)
- `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
  (update `memoryWriteHandler` to pass through `auto_chunk` / `chunk_size`)
- `extensions/bundles/sox-memory-bundle/members/memory-server/extension.json`
  (add `auto_chunk` and `chunk_size` to `memory_write` inputSchema)

**Fix approach:**
When `auto_chunk: true` or `chunk_size: N` is passed to `memory_write`:
1. Split content at sentence boundaries every N tokens (default 256).
2. For each chunk, call `memoryWrite` recursively without the chunking flag to
   get individual `episode_uid` values.
3. Create a synthetic parent node with a summary (title = first 100 chars of content).
4. Call `memory_link` internally with `rel: 'DERIVED_FROM'` to link each chunk to parent.
5. Return `{ episode_uid: parentUid, chunk_uids: [...] }`.

**Verification:**
- Write a 2000-word document with `auto_chunk: true`.
- `memory_recall({ query: 'term from paragraph 8' })` returns a result from that chunk.
- Without chunking, the same query returns at most 1 result (the whole document).
- `chunk_uids` are linked to parent with `DERIVED_FROM` edges verifiable in SQLite.

---

## BL Assignment Summary

| BL   | Phase  | Task |
|------|--------|------|
| BL-2 | P0-D   | Fix EMBED_MODEL naming comment |
| BL-3 | P1-B   | Demote temporal RRF weight |
| BL-8 | P1-A   | Raise DEFAULT_TOKEN_BUDGET to 32000 |
| BL-9 | P0-E   | Add memory_link MCP tool |
| BL-10| P0-B   | Fix initScope to call getActiveEmbedModel() |
| BL-11| P2-A, P2-B | Document constraint; spike embed worker |
| BL-12| P0-A   | Export reembedNodes from index.ts |
| BL-13| P3-A   | Add optional chunking to memory_write |
| BL-14| P1-C   | Add per-source diversity cap |
| BL-15| P0-C   | Document db_path allowlist |
