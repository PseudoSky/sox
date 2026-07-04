# Backlog — `@adhd/sox-ingest`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.
This is the document-prep layer of the RAG substrate (chunk + extractive summary + deterministic tags
+ content-hash). Currently `private`.

---

### BL-165 — MEDIUM (owner decision: CONSOLIDATE) — ingest is barely used while its capabilities are duplicated

The system uses `ingest()` for ONLY its extractive summary (`memory-core/src/extractive.ts` →
`ingest(content).summary`). Its other capabilities are dead or reimplemented elsewhere: `chunkContent`
is UNUSED (memory-server has its own `splitIntoChunks` — the code that carried the BL-154 deadlock);
`hexSha256` is UNUSED (`memory-core/write.ts` has its own `crypto` SHA-256); `extractTags` is UNUSED
(tags are caller-supplied). So this package does not earn its ~1.4k LOC as wired.

**Owner decision (2026-07-04): consolidate** — make `ingest` the canonical ingestion layer: route
memory-server's chunking + write.ts's content-hashing (and tag derivation) THROUGH `ingest`, deleting
the duplicates. Preserve behavior (chunk boundaries + hash normalization — verify parity so recall/dedup
don't shift). Then resolve publishability (make `ingest` public so `memory-core` is cleanly installable,
or keep memory-core private). Tracked as SHARDS.md **S11**. Root: BL-165 (supersedes BL-113 private/
publishability). This directly serves the RAG-reuse question (external consumers need document prep).

### BL-115 — MEDIUM: AST chunker uses regex/brace-depth heuristics, not tree-sitter AST parsing

`src/ast-chunker.ts` implements a simplified cAST algorithm with regex + brace-depth counting; the spec
requires tree-sitter-backed AST parsing. `extractDeclaration()`'s brace-walking is fragile — mismatched
braces inside strings/comments/template-literals/nested-generics produce wrong declaration boundaries.
Fine for well-formed code, wrong on complex code. Root: BL-115.

### BL-117 — LOW: late chunking is a no-op flag

The `lateChunking.enabled` flag is parsed but not implemented (no store-boundary changes at ingest, no
recall-time fetch). Either implement late chunking (per-chunk store boundaries + recall-time assembly)
or remove the flag so it doesn't imply a capability that isn't there. Root: BL-117.
