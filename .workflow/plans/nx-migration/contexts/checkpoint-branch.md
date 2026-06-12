# checkpoint-branch — CHECKPOINT THE SESSION'S FIXES + BRANCH

> **Slug is identity.** Immutable. Legacy P0. Ordering comes from `dag.json`.

**Phase:** checkpoint · **Depends on:** (none) · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/checkpoint-branch.sh`

---

## Goal

All work in the repo is currently **uncommitted**, including this session's fixes
([def:session-fixes]). Before any migration touches anything, that work must
survive in git. This state commits the entire working tree, tags it
`pre-nx-baseline`, and creates the `feat/nx-migration` branch every later state
works on. It exists first because the resumability and the fix-carry-forward
invariant ([inv:fix-carry-forward]) of every later state depend on this tag.

No code changes beyond committing what already exists.

---

## Semantic Distillation

- **Primitive:** WIRE git — commit + tag + branch the existing working tree.
- **Reference Pattern:** the current uncommitted working tree; `CLAUDE.md` (status
  inventory of what is green); ADR-0001 §Consequences step 0.
- **Delta Spec:** `git add -A`; commit with a message enumerating the fixes;
  `git tag pre-nx-baseline`; `git checkout -b feat/nx-migration`. Then `pnpm test`
  — if red, fix the specific failures and amend before tagging. Captures `$?`
  directly per [inv:capture-exit]. The state's produced artifact is its guard
  script (it performs no source edits — its product is the committed baseline,
  proven by the guard).
- **Invariants:** [inv:fix-carry-forward], [def:session-fixes], [def:reality-check].
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/checkpoint-branch.sh`
  — clean tree, `pre-nx-baseline` exists, HEAD is `feat/nx-migration`, suite green.

---

## Acceptance criteria

Checked by `audit-foundation` as slug-keyed IDs.

- [ ] **[checkpoint-branch.1]** Clean working tree on `feat/nx-migration` with the
      `pre-nx-baseline` tag present.
      `git diff --quiet && git diff --cached --quiet && git rev-parse --verify pre-nx-baseline && [ "$(git rev-parse --abbrev-ref HEAD)" = feat/nx-migration ]`
- [ ] **[checkpoint-branch.2]** Full test suite green at the baseline (`pnpm test`
      exits 0) — nothing regressed by the commit.

---

## Reservations

```text
read_only:  ["CLAUDE.md",
             "docs/decisions/0001-nx-and-self-hosting.md"]
mutates:    [".workflow/plans/nx-migration/scripts/guards/checkpoint-branch.sh"]
```

---

## Contract Promise

- **Added:** the `pre-nx-baseline` tag; the `feat/nx-migration` branch; the
  checkpoint commit; the guard script.
- **Modified:** none (no source edits — commit/tag/branch only).
- **Deleted:** none.

---

## Commit points

- [ ] **After staging + committing the session fixes** — `git add -A` then
      `chore: checkpoint session fixes before nx migration (recall alias, fireIsolated, enable-reactivation, stop-via-supervisor, registry drift gate, typecheck)`
- [ ] **After the guard passes** (mandatory) — commit the guard script + the
      `state.json`/`dag.json` updates: `chore(nx-migration): checkpoint-branch complete — guard green`

---

## Notes for executor

- Do NOT begin any nx setup or code changes — commit/tag/branch only.
- If `pnpm test` is red, FIX the specific failures (read the output, repair the
  breakage) and `git commit --amend` before creating the tag — never tag a red
  baseline.
- `pnpm` is on PATH or at `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm` ([def:root]).
- Skipping the tag breaks every later state's [inv:fix-carry-forward].

**Mandatory completion step.** Update `state.json` (status `done`, timestamps,
transition_log) and commit (R1) before stopping at the state boundary.
