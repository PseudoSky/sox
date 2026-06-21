# Backlog

Project backlog for sox-ecosystem. Each item: what's wrong, where, severity, and a fix sketch.
Observations below were surfaced during the sox-memory real-embedding / MCP-runtime work
(branches `feat/memory-real-embedding` → `fix/tokenguard-workspace-protocol` →
`fix/memory-server-c7-dedupe`, 2026-06-21).

---

## Open

### BL-1 — `pnpm typecheck` exits 2 on latent tokenguard + scripts errors

**Severity:** Low (code hygiene; no runtime impact) · **Status:** Open
Surfaced after the `@sox/tokenguard-core` workspace-protocol fix (`dabe9ea`) unmasked them —
TS previously aborted on `TS2307 Cannot find module '@sox/tokenguard-core'` before reaching
them. Pre-existing; not regressions from that fix (a dep-spec change cannot introduce `TS6133`).

9 errors:

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

### BL-5 — `@sox/mcp-runtime` consolidation (ADR-0002) still pending for memory-server

**Severity:** Medium (architecture) · **Status:** Open (tracked in ADR-0002)
`memory-server` currently hand-rolls a newline-delimited JSON-RPC stdio loop (`readline` on
stdin) instead of using the shared `@sox/mcp-runtime` wrapper ADR-0002 specifies. ADR-0002
explicitly calls for "memory-server's hand-rolled loop + vendored guard [to] collapse into it."
Until then the bundle ships its own transport + permission-guard.

### BL-6 — Verify the other sox-memory-bundle members build/run post workspace-glob widening

**Severity:** Low · **Status:** Open
The workspace-glob widening (`bec9914`) now links `@sox/memory-core` into all five members
(server/cli/flush/daemon/organizer). Only `memory-server` was deep-tested (build + real MCP
recall). Confirm `memory-cli`, `memory-flush`, `memory-daemon`, `memory-organizer` build and
resolve `@sox/memory-core` at runtime too.

---

## Resolved (this engagement)

- **Embedding was a hash stub (ADR audit A6)** → configurable backend (`auto|real|hash`),
  real = in-process fastembed bge-base-768 auto-downloaded to a global cache. (`f7ba7c4`, `ccff191`)
- **`pnpm install` 404 on `@sox/tokenguard-core`** → `workspace:*` protocol. (`dabe9ea`)
- **memory-server MCP fell back to hash at runtime** → workspace-glob widening links the
  bundle members so `@sox/memory-core` resolves; verified real semantic recall over the
  MCP stdio path. (`bec9914`, C7 dedupe `8c96865`)
