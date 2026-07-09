# Backlog — `@adhd/sox-ingest`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.
This is the document-prep layer of the RAG substrate (chunk + extractive summary + deterministic tags
+ content-hash). Published: `private: false` / `publishConfig.access: "public"`.

---

### BL-165 — MEDIUM — consolidation completed (S11) — **RESOLVED (2026-07-04)**

The S11 consolidation landed. `hexSha256` and `splitIntoChunksSentence` are now exported from
`@adhd/sox-ingest` and re-exported through `libs/memory-core/src/index.ts`. `libs/memory-core/src/write.ts`
uses `hexSha256` from ingest (replaced inline `crypto.createHash`). `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
uses `splitIntoChunksSentence` from ingest (replaced its own `splitIntoChunks`). Parity verified
in `libs/data/ingest/ingest/src/ingest-parity.spec.ts` (27 chunking + 3 summary assertions).

**Publishability — DONE:** the package is now `private: false` with `publishConfig.access: "public"`
(commit `f4897aa`), so `@adhd/sox-ingest` is publishable/installable for external RAG reuse. (The
earlier plan to keep `private: true` until the memory-core v1.0 milestone was dropped — the flip
landed ahead of it.) Root: BL-165 (supersedes BL-113).

### BL-115 — MEDIUM: AST chunker uses regex/brace-depth heuristics, not tree-sitter AST parsing — **RESOLVED (2026-07-08)**

`ast-chunker.ts` now parses with a real `web-tree-sitter` (WASM) parser, grammars from
`tree-sitter-wasms` (typescript/python/java/c_sharp — prebuilt, no native build toolchain). The regex
`DECL_PATTERNS` table and brace/indent-depth `extractDeclaration()` walker are gone; top-level
declaration boundaries are now real AST node spans (`collectTopLevelDeclarations()`), recursing
transparently through pure scoping containers (C# `namespace`) so nested classes chunk correctly. The
`Chunker` interface (`id`, `supportedLanguages`, `chunk()`, `estimate()`) is unchanged and both remain
fully synchronous — grammars are eagerly preloaded once via top-level await at module-evaluation time
(real ESM, not a mock/stub), so no call site needs to change. Along the way: (a) fixed a pre-existing
bug where trailing content after the last declaration was silently dropped (now emitted as its own
chunk — full, lossless document partition); (b) fixed short-declaration merges to also absorb any
intervening gap text, so `lines.slice(sourceStartLine, sourceEndLine + 1)` always reconstructs `text`
exactly; (c) added `MixedFormatChunker` (`mixed:markdown`/`mixed:mdx`/`mixed:rst`/`mixed:asciidoc`) —
heading chunker runs first (parent), AST chunker runs on detected fenced code blocks within each
section (child, nested via shared `metadata.heading` + array adjacency), covering the mixed-format
ordering requirement from the retrieval-infrastructure SPEC §3B; (d) scoped `heading-chunker.ts`'s
RST underline-heading detection to `syntax === 'rst'` only — it was previously matching AsciiDoc's
`----` code-block delimiters (and any `---`/`===` run in Markdown) as false headings, which would have
split fenced code blocks across bogus heading boundaries. Real fixtures + tests in
`src/__fixtures__/` (TS, JS via the TS grammar, Python, Java, C#, Markdown/RST/AsciiDoc-with-code) and
`ast-chunker.spec.ts` / `mixed-format-chunker.spec.ts` (112 tests total across the package) assert
AST-aligned boundaries against an independent ground-truth tree-sitter parse — no mocks. Root: BL-115.

### BL-117 — LOW: late chunking is a no-op flag

The `lateChunking.enabled` flag is parsed but not implemented (no store-boundary changes at ingest, no
recall-time fetch). Either implement late chunking (per-chunk store boundaries + recall-time assembly)
or remove the flag so it doesn't imply a capability that isn't there. Root: BL-117.
