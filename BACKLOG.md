# Backlog

Project backlog for sox-ecosystem. Each item: what's wrong, where, severity, and a fix sketch.
Observations below were surfaced during the sox-memory real-embedding / MCP-runtime work
(branches `feat/memory-real-embedding` → `fix/tokenguard-workspace-protocol` →
`fix/memory-server-c7-dedupe`, 2026-06-21).

---

## Open

### ~~BL-1~~ — `pnpm typecheck` exits 2 on latent tokenguard + scripts errors — **Resolved**

**Severity:** Low (code hygiene; no runtime impact) · **Status:** Resolved (2026-06-21)
Surfaced after the `@sox/tokenguard-core` workspace-protocol fix (`dabe9ea`) unmasked them.
**Verified fixed:** `pnpm typecheck` (root `tsc --noEmit`) now exits **0**; all nine cited
files are inside the compilation (`--listFilesOnly` confirms) and every cited error is gone
(e.g. `proxy.ts:309` now reads `(vs[0] ?? '')` — the prescribed `undefined` guard). The
mechanical fixes are realized in the working tree (tokenguard `cli.ts`/`mapstore.ts`/`proxy.ts`,
`scripts/new-extension.ts`, `scripts/check-registry-sync.ts) — **pending commit.**

9 errors (historical):

_tokenguard source:_

- `extensions/services/tokenguard/src/cli.ts(23,1)` — TS6133 `'readline'` unused
- `extensions/services/tokenguard/src/mapstore.ts(32,10)` — TS6133 `'now'` unused
- `extensions/services/tokenguard/src/proxy.ts(170,19)` — TS6133 `'mapper'` unused
- `extensions/services/tokenguard/src/proxy.ts(170,27)` — TS6133 `'adapter'` unused
- `extensions/services/tokenguard/src/proxy.ts(309,19)` — TS2322 `string | string[] | undefined` not assignable to `string | string[]` (needs an undefined guard)

_repo scripts (unrelated to tokenguard):_

- `scripts/check-registry-sync.ts(35,7)` — TS6133 `'tmpRoot'` unused
- `scripts/check-registry-sync.ts(162,7)` — TS6133 `'liveJson'` unused
- `scripts/new-extension.ts(82,96)` — TS2366 function lacks ending return
- `scripts/new-extension.ts(281,91)` — TS2366 function lacks ending return

**Fix sketch:** remove unused declarations; add an `undefined` guard at `proxy.ts:309`;
add explicit returns (or `: void`/`undefined` return types) in `new-extension.ts`. All
mechanical, no behavior change. After: `pnpm typecheck` exits 0.

### BL-2 — `embed.ts` real backend uses `bge-base-en-v1.5`, not the nominal nomic model

**Severity:** Low (works; naming/quality) · **Status:** Open
The `EMBED_MODEL` constant historically read `nomic-embed-text-v1.5-hash`. The real backend
actually loads **bge-base-en-v1.5** (768-dim) because `fastembed` 2.x does not ship
nomic-v1.5. Verified semantically correct (cos(query,relevant)≈0.74–0.82 vs cos(query,unrelated)≈0.50).
If nomic is desired, swap to a lib/runtime that ships it at 768-dim and re-embed (the
`memory_scope.embed_model` pin already forces a clean reindex on model change).

### BL-3 — `memory_recall` RRF temporal-recency can outrank semantic similarity for closely-timed writes

**Severity:** Low (tuning) · **Status:** Open / needs-decision
Observed: with three docs written seconds apart, the most-recently-written (less relevant)
doc out-ranked an older, more-relevant doc, because the temporal component of the RRF fusion
dominated the tiny rank-based score deltas. Embeddings are correct; this is a fusion-weight
tuning question. Consider down-weighting recency relative to semantic rank, or widening the
score spread, when corpus writes cluster in time.

### BL-4 — Local build hygiene: composite `tsc` leaves stale `dist`; trust `nx build`, not vitest aliases

**Severity:** Low (dev ergonomics) · **Status:** Note
`libs/memory-core` and the memory-server bundle use `composite: true`. A bare `tsc` after a
source change (or after `rm -rf dist`) can emit nothing because the `.tsbuildinfo` thinks
outputs are current — leaving a **stale `dist`**. `dist` is gitignored and the nx graph wires
`memory-server:build → dependsOn memory-core:build`, so a clean `nx build memory-server`
is correct. But: a vitest run (which transforms TS source, or uses a `resolve.alias` to
source) can PASS while the built `dist` is stale — so "tests pass" does **not** prove the
runtime/MCP path. Always verify runtime behavior against `nx build` output, not vitest.

### ~~BL-5~~ — `@sox/mcp-runtime` consolidation — **Resolved**

**Status:** Resolved. `memory-server` now uses `serve()` + `defineTool()` from `@sox/mcp-runtime`;
hand-rolled readline loop removed. Vendored `compilePolicyFromEnv` kept (standalone child process
cannot reach `@sox/host-runtime` at runtime). Type escape hatches removed; `handleToolCall`
returns `Promise<ToolResult>`, `TOOLS` typed as `Array<Omit<ToolDefinition, 'handler'>>`.

### BL-6 — Verify the other sox-memory-bundle members build/run post workspace-glob widening

**Severity:** Low · **Status:** Open
The workspace-glob widening (`bec9914`) now links `@sox/memory-core` into all five members
(server/cli/flush/daemon/organizer). Only `memory-server` was deep-tested (build + real MCP
recall). Confirm `memory-cli`, `memory-flush`, `memory-daemon`, `memory-organizer` build and
resolve `@sox/memory-core` at runtime too.

### BL-7 — `install` should persist the resolved scope so `serve` needs no `--scope` flag

**Severity:** Medium (DX / correctness footgun) · **Status:** Open
`soxe install --scope=user` writes the user-scope lockfile (`~/.config/extensions/extensions.lock`),
but `soxe serve <id>` defaults to `--scope=project` (cwd-rooted). So a user-scope-installed
extension is invisible to `serve` unless the caller _also_ passes `--scope=user` — which means
the scope decision has to be re-stated at every invocation site (the `~/.claude.json` MCP
entry, `.mcp.json`, etc.). That conditional handling at install-time/launch files is exactly
what we want to avoid.

**Desired:** install should make the resolved scope self-describing so `serve` finds the
extension without a flag. Options to evaluate:

- `serve` resolves across scopes by precedence (project → user → org) instead of a single
  default scope, so a user-scope install is found automatically.
- and/or install records the scope in a stable, cwd-independent index (e.g. the
  `~/.sox`/`SOX_HOME` install-registry) that `serve` consults regardless of cwd.
- and/or install stamps the chosen scope into the generated launch/config artifact so no
  caller has to pass `--scope`.

**Follow-up (do this once BL-7 lands):** remove the `--scope=user` argument from the global
MCP entry in `~/.claude.json` (`mcpServers."memory-server".args`) — it is a temporary
workaround for this gap and should be deleted once `serve` resolves user-scope installs on
its own. Track that removal as the closing step of BL-7.

## Memory subsystem (`@sox/memory-core` + sox-memory-bundle)

Surfaced while migrating a 95-document research corpus into `~/.memory/memory.db` and exercising `memory_recall` via the live MCP (2026-06-21).

### BL-8 — `memory_recall` default `token_budget` is far too small for document-scale nodes

**Severity:** Medium (recall correctness) · **Status:** Open
`memoryRecall` defaults `token_budget` to ~4000 (`recall.ts`), and `federatedRecall` to 4000. The assembler stops adding results once the budget is exceeded (`recall.ts:279`), so with document-sized nodes a single result fills the budget and recall returns **1 hit even when `limit` is 10**. Confirmed empirically: same query returned 1 result at default, 10 at `token_budget: 50000`. Fix: raise the default to a sane multi-result value, make it scale with `limit`, and/or document that callers must pass `token_budget`. The `limit` parameter is misleading while the budget silently caps below it.

### ~~BL-9~~ — No edge/link MCP tool; relationships require the organizer or raw SQL — **Resolved**

**Severity:** Medium (graph completeness) · **Status:** Resolved (2026-06-21)
A `memory_link` tool now exists (memory-server `src/index.ts:294` definition, `:620` handler),
creating directed edges between existing nodes (`DERIVED_FROM`, `SUPERSEDES`, `RELATES_TO`,
`SUPPORTS`, `MENTIONS`). Bulk importers can link chunks to their source document via the MCP
without the organizer or raw SQL. **Verified in working tree — pending commit.**

### BL-10 — `initScope` records the `EMBED_MODEL` constant, not the active model

**Severity:** Medium (bug — embed-model pin is wrong) · **Status:** Open
`initScope` (`db.ts`) writes `EMBED_MODEL` (the legacy hash constant, `nomic-embed-text-v1.5-hash`) into `memory_scope.embed_model`, even when the active backend is `real` (bge-base-en-v1.5). The scope's pin is then false, which defeats the whole "pin forces re-embed on model change" mechanism and misleads any consistency check. Fix: record `getActiveEmbedModel()` at scope-init time.

### ~~BL-11~~ — In-process `embed()` + `better-sqlite3` crashes ("mutex lock failed") — **Resolved**

**Severity:** High (blocks programmatic/bulk ingest) · **Status:** Resolved (2026-06-21)
ONNX inference is now isolated in a worker thread (`libs/memory-core/src/embedWorker.ts`,
referenced from `embed.ts:92` and `index.ts:9-10` with explicit "resolves BL-11" notes), so
onnxruntime-node and better-sqlite3 no longer share the libpthread mutex that was corrupted
across the async boundary. The library is safe to call in-process (openDb → embed → memoryWrite).
**Verified in working tree — `embedWorker.ts` is untracked, pending commit.**

### BL-12 — `reembedNodes` is defined but not re-exported from the package index

**Severity:** Low (API consistency) · **Status:** Open
`reembedNodes` lives in `embed.ts` and is in its `.d.ts`, but `index.ts` re-exports only `enqueueReindex` (from `memoryd`). `require('@sox/memory-core').reembedNodes` is `undefined`; callers must reach into the submodule. Re-export it from the index.

### ~~BL-13~~ — `memory_write` stores whole content as one node; no chunking + embedding truncation — **Resolved**

**Severity:** Medium (recall quality) · **Status:** Resolved (2026-06-21)
`memory_write` now chunks large content server-side: `splitIntoChunks()` (memory-server
`src/index.ts:360`) splits content exceeding `chunk_size` (param at `:198`, default ~500
tokens) at sentence boundaries, storing each chunk as a separate episode with a `DERIVED_FROM`
edge to the parent. Callers no longer need to pre-chunk document-sized input for usable
default-budget recall. **Verified in working tree — pending commit.**

### BL-14 — `memory_recall` lacks result diversity (one verbose source crowds top-N)

**Severity:** Medium (recall quality) · **Status:** Open
After chunked ingest, a single long finding (`work-order-compiler`, many sections) had enough chunks that 3–4 of them filled the top-5 for unrelated queries, burying the genuinely most-relevant finding from another source (e.g. `plan-scheduling/dag-merging` ranked #4 for "parallel scheduling of dependent plan tasks", under work-order-compiler chunks). Add per-source diversity to recall — cap chunks-per-`original_path`/document, or apply MMR — so top-N spans distinct sources.

### BL-15 — `serve` permission guard `db_path` allowlist is `~/.memory/**` only

**Severity:** Low (note) · **Status:** Open
The memory-server `extension.json` fs allowlist is `~/.memory/**`; any caller-supplied `db_path` outside it is denied (correct, but undocumented for tool callers). Worth surfacing in the tool description so agents know writes/recall must target `~/.memory/`.

---

## Resolved (this engagement)

- **Embedding was a hash stub (ADR audit A6)** → configurable backend (`auto|real|hash`),
  real = in-process fastembed bge-base-768 auto-downloaded to a global cache. (`f7ba7c4`, `ccff191`)
- **`pnpm install` 404 on `@sox/tokenguard-core`** → `workspace:*` protocol. (`dabe9ea`)
- **memory-server MCP fell back to hash at runtime** → workspace-glob widening links the
  bundle members so `@sox/memory-core` resolves; verified real semantic recall over the
  MCP stdio path. (`bec9914`, C7 dedupe `8c96865`)
