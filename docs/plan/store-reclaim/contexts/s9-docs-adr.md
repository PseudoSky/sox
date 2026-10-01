# s9-docs-adr — documentation updates + ADR proposal

**Phase:** close · **Deps:** all work segments · **Tier:** medium · **Est:** ~150 R / ~500 W

## Goal

Land the DESIGN §15 doc table (except the two excluded docs) and **propose** ADR-0026 to the owner.

## File ownership

- **mutates:** `docs/spec/sox-executor.md` (§6.6 #2, L658), `libs/data/CLAUDE.md`
- **creates:** nothing that writes an ADR without approval
- **does NOT touch:** `docs/ops/memory-server-playbook.md`, `docs/spec/service-lifecycle.md`,
  `docs/decisions/0015-…`, `docs/decisions/0007-…` (separate doc updates / ADR revision loop — out of scope)

## Acceptance criteria

1. `docs/spec/sox-executor.md` §6.6 #2 names the built two-phase reclaim + the expiry packaging.
2. `libs/data/CLAUDE.md` notes `store-reclaim.ts` + `pruneBackupSets`.
3. **ADR-0026 is PROPOSED to the owner, not written.** The proposal text states: status Proposed; next
   number = max existing `0025` + 1; decisions (offline-child reclaim, durable obligation, single-flight
   lock, per-store thresholds, one expiry policy + one unlinker, never-expire guard, double-disk bound, live
   build + gated swap); and **must cite the P7 topology correction**.
4. No ADR file exists on disk until the owner approves (verify with a read/ls; `git status` shows none).

## Commit points

- After docs land: commit the two doc files by **explicit pathspec**.

## Notes

- ADR-0007 D6 gets an annotation **only via the ADR revision loop** — do not edit it in this segment; note
  the follow-up instead.
