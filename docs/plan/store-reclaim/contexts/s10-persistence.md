# s10-persistence — land the plan (this directory)

**Phase:** foundation · **Deps:** none (or after all) · **Tier:** easy · **Status: DONE** (authored this
session).

## Goal

Ensure the design survives a killed run by living in a committed plan directory.

## File ownership

- **creates:** `docs/plan/store-reclaim/README.md`, `STATE.md`, `DESIGN.md`, `contexts/**`

## Acceptance criteria

1. `DESIGN.md` contains the full spec body §0–§16 (premise corrections P1–P7, the expiry half, the two-phase
   trigger, the segment table).
2. `STATE.md` carries objective, per-segment acceptance criteria, serialization constraints (s3/s4/s4_5/s5
   serialized; s6↔s8 serialized), Blocker B1, and open questions Q2/Q6; names the ADR-0026 **proposal** and
   its P7 requirement.
3. Committed **by explicit pathspec**, hooks on; `git diff --exit-code registry/index.json` clean; no file
   outside `docs/plan/store-reclaim/` modified.
4. `git status --porcelain` shows only plan files from this task.

## Commit points

- Commit `docs/plan/store-reclaim/` by **explicit pathspec** immediately.

## Notes

- Authoring session had no shell; the skill's CLI scripts were not run. A later session may run
  `node "$SKILL/gap-check.js" docs/plan/store-reclaim` to validate mechanically.
