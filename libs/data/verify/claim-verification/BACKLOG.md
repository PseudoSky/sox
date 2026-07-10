# Backlog — `@adhd/sox-claim-verification`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.

---

### BL-166 — HIGH [TRIAGE] (wire-in-or-remove): built but NEVER consumed — **RESOLVED (2026-07-10)** — VERIFIED consumed externally by `/Users/nix/dev/ai/agent-source` (declared as a `file:` dep in its `package.json`; 16 import sites across the three packages). The in-repo grep found zero importers because live objects cross the boundary via DI per ADR-0006 — production code imports the *type* and the composition root constructs it. See root BACKLOG BL-166.

This package is ~1,083 LOC of real, non-stub implementation, but a consumer scan found **zero live
importers** anywhere in `libs`/`extensions`/`apps` — it was built and never wired into the memory
system.

**Decide (owner):**
- **Wire in** — the most compelling role in a memory system is provenance / contradiction checking:
  when a new memory is written, verify it against existing claims and flag/supersede contradictions.
  This directly raises memory quality and is the most interesting of the orphaned packages to keep.
- **Remove** — delete the package if claim verification is not on the roadmap.

Do not leave it built-but-unconsumed (owner directive: fix/remove, don't defer). Root: BL-166.

**Triage context:** The natural integration point is an enrichment step after `memory_write`: verify
new claims against existing nodes (by topic/entity overlap) and flag or supersede contradictions.
This is the most intellectually valuable of the orphaned packages — it directly raises data quality
and addresses a real memory-system gap (conflicting information in the store). Wire-in effort is
medium (~1-2 days: add enrichment step, define what "contradiction" means for the memory domain,
tests). Remove cost is low (no consumers, but the contradiction-detection logic is non-trivial to
reconstruct). ~1.1k LOC of real implementation with clean deps.
