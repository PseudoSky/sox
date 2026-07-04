# CLAUDE.md — data/embed/embedding-provider

Rules for working in this package (agent-routing layer; keep authoritative + minimal).

## Interface contract

The authoritative interface spec for this package is:
**[docs/plan/memory-refactor/COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md)**

`src/index.ts` is a compileable skeleton of the interfaces — all types match that spec.
Do not add implementation code to `src/index.ts` directly; implementation lands via the
memory-refactor plan states.

## Invariants (do not violate)

- createEmbeddingProvider() THROWS ResolutionError synchronously or as a rejection if the config is invalid or the model/runtime cannot load — never silently downgrades to hash
- every provider advertises { modelId, dimensions, isRemote, isDeterministic, providerUri? } via metadata — callers never hardcode dims
- embedBatch() returns AsyncIterable<Float32Array> — callers receive first result before last batch finishes (critical for sequential local inference)
- warmUp() is a no-op when isDeterministic === false
- TransientEmbeddingError → caller may retry; PermanentEmbeddingError → caller must not retry; ResolutionError → factory-time only, never thrown mid-call

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform`
  (enforced by nx module-boundary lint).
- Published npm name (`@adhd/sox-embedding-provider`) is decoupled from this folder path —
  never rename the package name on a folder move.
- Declared deps: `fastembed`.
  Do not add undeclared deps without updating package.json + COMPILED_INTERFACES.md.

## Build / test

- `npx nx build embedding-provider` · `npx nx test embedding-provider` · `npx nx lint embedding-provider`
- Build via nx targets only — bare `tsc` emits into `src/` and bypasses project graph.
- This is a data-layer library; it is NOT registered in `registry/index.json` —
  skip `npx nx run registry:sync-index` after changes here.

## Backlog

Findings for this package live in **[`BACKLOG.md`](./BACKLOG.md)** — cross-referenced to the root
[`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs. **Read it before extending this package.**
- **BL-155 (HIGH, resolved):** never resolve worker/asset paths via `fileURLToPath(import.meta.url)`
  at module scope — `import.meta.url` is `undefined` in a CJS bundle (esbuild sets `import.meta={}`),
  which crash-looped the memory-server daemon. Use a bundler-safe path (`__dirname` / injected).
