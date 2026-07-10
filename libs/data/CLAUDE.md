# CLAUDE.md — `libs/data/`

Area-level guidance for all `data/*` packages. Group-level `CLAUDE.md` stubs already exist
in each package directory — see those for package-specific rules.

## Boundary rules

- **`data→data|shared` ONLY** — any `import` from `area:platform` (e.g. `libs/authoring`, `libs/registry`,
  `libs/host-runtime`, the `sox` CLI, `@adhd/sox-nx`) fails `nx lint` via the `@nx/enforce-module-boundaries`
  rule. There is no exception. If you need platform-layer logic from a data package, inject it through the
  domain composer (`memory-core`) — never reach across the area boundary.
- **`data→memory-core` is also forbidden** — data packages are generic storage/processing; the domain composer
  imports them, never the reverse. If a data package needs session state, scope, or federation logic, the
  composer supplies it.
- Published npm names (`@adhd/sox-embedding-provider`, `@adhd/sox-vector-store`, etc.) are decoupled from
  folder paths. NEVER rename the published name on a folder move — it's the content-address key.

## Build rules

- **Build via nx targets only** — `npx nx build <package>` (e.g. `npx nx build vector-store`). Never bare
  `tsc` — it emits into `src/`, bypasses project-graph dependency ordering, and leaves `dist/` stale.
- **Before any memory test** — `npx nx build memory-core && npx nx build memory-server` first (BL-4 stale-dist).
  Data packages are dependencies of those bundles; stale data-package `dist/` → stale memory-core dist → stale
  memory-server bundle → tests pass against stale code. Always rebuild the chain.
- **After changing a data package** — lint (`npx nx lint <pkg>`), build (`npx nx build <pkg>`), test
  (`npx nx test <pkg>`). The registry sync (`npx nx run registry:sync-index`) is NOT needed for data packages
  since they are NOT registered in `registry/index.json` (libs only, not extensions).
- **Pure interface packages** (e.g. `vector-store`, `embedding-provider`) ship a compiled
  `dist/index.js` + `dist/index.d.ts`. Implementation code lives in the memory-refactor plan states;
  `src/index.ts` is a compileable skeleton.

## BL-11 — Embedding worker boundary

**The real `embed()` runs in a worker thread.** Do NOT load `onnxruntime-node` or `fastembed` inline
on the main thread alongside `openDb`. The worker boundary lives in
`libs/data/embed/embedding-provider/src/embedWorker.ts` (the only file that lazy-requires fastembed
at runtime). The bundle tool (`tools/bundle-extension.cjs`) must emit `dist/embedWorker.js` as a
sibling bundle — a missing sibling is a silent regression (the Worker spawn fails, no immediate error,
embed falls back to hash silently). After building the `embedding-provider`, confirm
`dist/embedWorker.js` exists.

## Key footguns

### 1. Dim hard-coding

The legacy code hard-coded `FLOAT[768]` everywhere. The embedding provider now ships ≥3 models
spanning dims (384, 768, 1024), making that a **hard failure**. Every provider advertises
`.dim` via its metadata — callers must read it, never assume it. `vector-store.ensureSpace(space)`
declares the dim at setup time; `upsert()` enforces it with `SpaceInvariantError`.

### 2. No silent embedding fallback

`createEmbeddingProvider()` **THROWS** `ResolutionError` if the configured model/runtime cannot load.
It never silently downgrades — there is no fallback path. The only backends are `auto` (fastembed real
model) and `real` (same, but fail-loud). `SOX_EMBED_BACKEND=hash` was removed with the hash backend.
If you see a provider running with `isDeterministic: true`, that's a test provider injected via
`_setEmbedProviderForTest()` — never a hash fallback.

### 3. Space invariant enforcement

`upsertVector` in `vector-store` **rejects** any vector whose `dim` or `modelId` ≠ the column's space.
A model switch is a **re-embed migration** — call `reembed()` explicitly to migrate vectors between
spaces; never hot-swap a different model into the same vec0 table. `reembed()` does NOT delete source
vectors — the caller decides when the old space is safe to drop.

> **[BL-256] `memory-core` no longer uses this multi-space API.** As of the BL-92 fix, `memory-core`'s
> own `reembedStore()` migrates the single fixed-schema `vec_node` table in place — it does **not** call
> `vector-store`'s `ensureSpace()` / generic `vec_<model>` / `_vector_spaces` machinery. That generic
> multi-space abstraction is retained for **external consumers** (`agent-source` imports `VectorBackend`
> and `VectorSpace` as a `file:` dep). So: the re-embed-migration story above is the *vector-store
> library's* contract for external callers, not the path memory-recall takes. Do not "fix" memory-core
> to route through `ensureSpace` on the strength of this section.

### 4. `INSERT OR REPLACE` on vec0 tables

sqlite-vec `vec0` virtual tables do NOT implement OR-REPLACE conflict resolution. `INSERT OR REPLACE`
silently fails (SQLite error but the transaction is not rolled back). Always use UPDATE-then-INSERT:
check if the row exists, UPDATE if so, INSERT if not. `vector-store` enforces this internally.

### 5. `memory-core` / `memory-enrich` have NO area tags

Do not add `area:*` tags to `memory-core` or `memory-enrich`. They are the domain composer — they
sit **above** data and import from it. Adding an `area:data` tag would make boundary lint fail on
every data→composer cross-import.

### 6. `better-sqlite3` native bindings

Data packages that depend on `better-sqlite3` (vector-store, graph-store) externalize it — they
do not bundle the native `.node` binding. Callers must `pnpm rebuild better-sqlite3` on a new
Node ABI. The root `postinstall` script does this.

### 7. Top-level await in a data package breaks every CJS consumer — BL-231

`memory-core` compiles to **CommonJS** (`tsconfig.lib.json` → `"module": "CommonJS"`), and
`tools/bundle-extension.cjs` bundles **every** sox extension with esbuild `format: 'cjs'`. Neither
can consume an ESM module containing a top-level `await`:

```
Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph with top-level await.
Top-level await is currently not supported with the "cjs" output format
```

A data package that adds a module-scope `await` — however legitimate as ESM — therefore breaks
`nx build`, `nx test`, and `scripts/smoke-test.mjs` for everything downstream of `memory-core`.
This happened: `c01ddeb` added `await Parser.init()` to `ingest/src/ast-chunker.ts` and silently
zeroed two test suites and the repo-wide smoke gate for two days.

**Rule:** if a data package needs async initialization, keep it out of the module graph any CJS
consumer imports. `ingest` does this with a `./core` subpath export (TLA-free, CJS-safe) alongside an
ESM-only root that carries the async-init surface. See `libs/data/ingest/ingest/AGENTS.md`.
Guard: `node tools/test-bl231-cjs-boundary.mjs`.

`exports` maps alone are not enough — TypeScript's legacy `node10` `moduleResolution`, which CJS
consumers are pinned to, cannot read them. A `typesVersions` block is required for the subpath's
types to resolve.

### 8. `nx build` deletes `dist/` before it knows the rebuild succeeds — BL-235

Several `build` targets begin with `rm -rf .../dist`. A build against non-compiling source therefore
**destroys a working artifact and cannot restore it**. A merely diagnostic `npx nx build <pkg>` is a
destructive operation, and doubly so in a shared checkout with concurrent agents. Before running a
build purely to see an error, know that you may not get the old artifact back.

## Package listing

| Package | Path | Published | Key concern |
|---------|------|-----------|-------------|
| `embedding-provider` | `libs/data/embed/embedding-provider/` | PUBLIC | text→vector; 3+ models; worker-backed |
| `vector-store` | `libs/data/vectors/vector-store/` | PUBLIC | multi-space vec0; space invariant; re-embed migration |
| `graph-store` | `libs/data/graph/graph-store/` | PUBLIC | bi-temporal graph; FTS5; supersession chains |
| `hybrid-search` | `libs/data/search/hybrid-search/` | PUBLIC | vec+BM25 fusion; degrade-to-text; field boosting |
| `analysis` | `libs/data/analysis/analysis/` | PUBLIC | clustering; near-dup; importance; graph algorithms |
| `ingest` | `libs/data/ingest/ingest/` | PUBLIC | content-hash; extractive summary; deterministic tags |

For detailed concerns and invariants per package, see the auto-generated
[`libs/data/INDEX.md`](INDEX.md) or the machine-readable [`docs/routing/map.json`](../docs/routing/map.json).
For intent→scope routing (what to edit for a given task), see [`docs/routing/ROUTER.md`](../docs/routing/ROUTER.md).
