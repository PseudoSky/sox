# Backlog — `@adhd/sox-ingest`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.
This is the document-prep layer of the RAG substrate (chunk + extractive summary + deterministic tags
+ content-hash). Currently `private`.

---

### BL-165 — MEDIUM — consolidation completed (S11) — **RESOLVED (2026-07-04)**

The S11 consolidation landed. `hexSha256` and `splitIntoChunksSentence` are now exported from
`@adhd/sox-ingest` and re-exported through `memory-core/src/index.ts`. `memory-core/write.ts`
uses `hexSha256` from ingest (replaced inline `crypto.createHash`). `memory-server/src/index.ts`
uses `splitIntoChunksSentence` from ingest (replaced its own `splitIntoChunks`). Parity verified
in `ingest-parity.spec.ts` (27 chunking + 3 summary assertions).

**Remaining (deferred):** publishability — `private: true` kept until memory-core v1.0 publish
milestone (per BL-165 closeout in root BACKLOG.md). The `agent-mcp-authoring` dependency uses
local path `"file:../sox-ecosystem/..."` as workaround until then. Root: BL-165 (supersedes
BL-113).

### BL-115 — MEDIUM: AST chunker uses regex/brace-depth heuristics, not tree-sitter AST parsing

`src/ast-chunker.ts` implements a simplified cAST algorithm with regex + brace-depth counting; the spec
requires tree-sitter-backed AST parsing. `extractDeclaration()`'s brace-walking is fragile — mismatched
braces inside strings/comments/template-literals/nested-generics produce wrong declaration boundaries.
Fine for well-formed code, wrong on complex code. Root: BL-115.

### BL-117 — LOW: late chunking is a no-op flag

The `lateChunking.enabled` flag is parsed but not implemented (no store-boundary changes at ingest, no
recall-time fetch). Either implement late chunking (per-chunk store boundaries + recall-time assembly)
or remove the flag so it doesn't imply a capability that isn't there. Root: BL-117.
