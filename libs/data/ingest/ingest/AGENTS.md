# CLAUDE.md — data/ingest/ingest

Rules for working in this package (agent-routing layer; keep authoritative + minimal).

> `CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`.

## ⛔ THE ONE THING TO KNOW — this package has TWO entry points, and they are not interchangeable

| Entry | Module system | Contains | Who imports it |
|---|---|---|---|
| `@adhd/sox-ingest/core` | **CJS-safe** (no top-level await) | `ingest`, `hexSha256`, `splitIntoChunksSentence`, `Ingest*` types | **every CommonJS consumer** — incl. `@adhd/sox-memory-core` |
| `@adhd/sox-ingest` (root) | **ESM-only** | all of the above **+** the full chunker surface (`AstChunker`, `MixedFormatChunker`, `HeadingChunker`, `ChunkerRegistry`) | ESM consumers only |

**The root cannot be `require()`d.** `src/ast-chunker.ts` performs a module-scope
`await Parser.init()` to preload tree-sitter WASM grammars — necessary because
`AstChunker.chunk()`/`.estimate()` are synchronous by contract and `web-tree-sitter@0.25.10`
exposes no `initSync`. `src/index.ts` statically re-exports `AstChunker`, so any import of the
root drags that top-level await into the module graph:

```
Error [ERR_REQUIRE_ASYNC_MODULE]: require() cannot be used on an ESM graph with top-level await.
```

esbuild fails the same way under `format: 'cjs'` (which `tools/bundle-extension.cjs` uses for
**every** sox extension bundle):

```
Top-level await is currently not supported with the "cjs" output format
```

**This actually happened.** Commit `c01ddeb` shipped the real tree-sitter chunker (BL-115, correct
code) and silently took `nx test memory-server` and `nx test memory-flush` to **zero tests**, killed
`nx build memory-server`, and hard-blocked `scripts/smoke-test.mjs` **repo-wide** for two days. See
**BL-231**.

### Rules

- **A CJS consumer imports `@adhd/sox-ingest/core`.** Never the root. `memory-core` compiles to
  CommonJS (`tsconfig.lib.json` → `"module": "CommonJS"`) and is the canonical example.
- **`src/core.ts` must never import a chunker** — not `ast-chunker.js`, not
  `mixed-format-chunker.js`, not `chunker-registry.js`, not `index.js`. Its graph must stay free of
  top-level await. There is no lint rule for this; there is a test.
- **The guard is `tools/test-bl231-cjs-boundary.mjs`.** Run it after touching either entry point. It
  asserts `require()` of `core.js` and of `memory-core/dist/index.js` both succeed, that the compiled
  memory-core never requires the ESM-only root, and that `core.js`'s emitted graph has no top-level
  await. It **fails loudly** when dist artifacts are missing rather than skip-passing.
- **`typesVersions` is load-bearing.** TypeScript's legacy `node10` `moduleResolution` — which CJS
  consumers are pinned to — cannot read `exports` maps at all. `package.json`'s `typesVersions` block
  is what lets them resolve `@adhd/sox-ingest/core`'s types. Deleting it breaks `nx build memory-core`
  with `TS2307: Cannot find module '@adhd/sox-ingest/core'`.

## Invariants (do not violate)

- **`ingest()` is zero-LLM, zero-I/O, synchronous** — a pure function, always safe to call in the
  write path with no latency budget concern. It lives in `src/core.ts` and reaches no chunker.
  *(The `AstChunker` WASM grammar load IS disk I/O — but it is not on `ingest()`'s path. Do not
  read the zero-I/O invariant as covering the chunker surface.)*
- **deterministic + byte-reproducible** — same input always produces the same hash, summary, and tags
  (no random or time-based components).
- **PUBLIC** — `private: false` with `publishConfig.access: "public"` (commit `f4897aa`); publishable
  so `memory-core` is cleanly installable for external RAG reuse.

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform`
  (enforced by nx module-boundary lint).
- Published npm name (`@adhd/sox-ingest`) is decoupled from this folder path —
  never rename the package name on a folder move.

## Build / test

- `npx nx build ingest` · `npx nx test ingest` · `npx nx lint ingest`
- Build via nx targets only — bare `tsc` emits into `src/` and bypasses project graph.
- This is a data-layer library; it is NOT registered in `registry/index.json` —
  skip `npx nx run registry:sync-index` after changes here.
- **After changing either entry point:** `node tools/test-bl231-cjs-boundary.mjs` (needs
  `nx build ingest && nx build memory-core` first).

## STATUS: consolidation landed (S11 / BL-165)

Content-hashing routes through ingest's `hexSha256` (`libs/memory-core/src/write.ts:185`) and chunking
through `splitIntoChunksSentence` (memory-server `index.ts:1006`), both re-exported via
`libs/memory-core/src/index.ts:328`. The extractive summary is also consumed. All three now import
from `@adhd/sox-ingest/core`.

## Backlog

Findings live in **[`BACKLOG.md`](./BACKLOG.md)**, cross-referenced to the root
[`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs. **Read it before extending this package.**

- **BL-165** (RESOLVED 2026-07-04) — ingest is the canonical ingestion layer; package flipped PUBLIC.
- **BL-115** (RESOLVED 2026-07-08, `c01ddeb`) — real `web-tree-sitter` AST chunker. Shipping it caused BL-231.
- **BL-231** (RESOLVED 2026-07-08) — the `/core` CJS-safe subpath above. Read it before touching `index.ts`.
- **BL-117** (Open, LOW) — late-chunking flag is a no-op in `memory-core/src/recall.ts:811-823`.
