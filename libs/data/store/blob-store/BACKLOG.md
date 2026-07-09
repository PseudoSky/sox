# Backlog — `@adhd/sox-blob-store`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.

---

### BL-166 — HIGH [TRIAGE] (wire-in-or-remove): built but NEVER consumed

This package is ~1,828 LOC of real, non-stub implementation, but a consumer scan found **zero live
importers** anywhere in `libs`/`extensions`/`apps` — it was built and never wired into the memory
system (or anything else). It is currently dead weight.

**Decide (owner):**
- **Wire in** — the natural role is large-content / attachment offload: keep big blobs out of SQLite
  `node.content` rows (content-addressed storage), with the graph/vector rows referencing blob hashes.
  This is genuinely useful for a RAG system ingesting large documents/media.
- **Remove** — delete the package if large-content offload is not on the roadmap.

Do not leave it built-but-unconsumed (owner directive: fix/remove, don't defer). Root: BL-166.

**Triage context:** The natural integration point is the memory write path — when `content` exceeds
`chunk_size`, store the large blob in blob-store (content-addressed) instead of inline in the
`node.content` row. This is the same pattern as S11's chunking consolidation and directly serves the
RAG-with-large-documents use case. Wire-in effort is medium (~1-2 days to add offload to the write
path + integration tests). Remove cost is low (no consumers, spec exists if re-created later). The
~1.8k LOC is real implementation, not a stub — it compiles, tests pass, deps are clean.
