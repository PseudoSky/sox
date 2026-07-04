# Backlog — `@adhd/sox-blob-store`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.

---

### BL-166 — HIGH (wire-in-or-remove): built but NEVER consumed

This package is ~1,828 LOC of real, non-stub implementation, but a consumer scan found **zero live
importers** anywhere in `libs`/`extensions`/`apps` — it was built and never wired into the memory
system (or anything else). It is currently dead weight.

**Decide (owner):**
- **Wire in** — the natural role is large-content / attachment offload: keep big blobs out of SQLite
  `node.content` rows (content-addressed storage), with the graph/vector rows referencing blob hashes.
  This is genuinely useful for a RAG system ingesting large documents/media.
- **Remove** — delete the package if large-content offload is not on the roadmap.

Do not leave it built-but-unconsumed (owner directive: fix/remove, don't defer). Root: BL-166.
