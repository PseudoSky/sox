# Backlog — `@adhd/sox-claim-verification`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.

---

### BL-166 — HIGH (wire-in-or-remove): built but NEVER consumed

This package is ~1,083 LOC of real, non-stub implementation, but a consumer scan found **zero live
importers** anywhere in `libs`/`extensions`/`apps` — it was built and never wired into the memory
system.

**Decide (owner):**
- **Wire in** — the most compelling role in a memory system is provenance / contradiction checking:
  when a new memory is written, verify it against existing claims and flag/supersede contradictions.
  This directly raises memory quality and is the most interesting of the orphaned packages to keep.
- **Remove** — delete the package if claim verification is not on the roadmap.

Do not leave it built-but-unconsumed (owner directive: fix/remove, don't defer). Root: BL-166.
