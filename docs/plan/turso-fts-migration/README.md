# Plan — Turso FTS 0.7.x → 0.8.x migration

Single entry point for the driver-bump migration decision. Sibling to
`docs/plan/store-reclaim/` (which designs the *ongoing* page-reclamation engine; this
plan designs the *one-time* format migration that a 0.8.x pin requires).

## Why this plan exists

`@tursodatabase/database` 0.8.0 (2026-08-31, PR #8517; shipped in `v0.8.0`, 0.8.1 is
plumbing-only) replaced the FTS on-disk format (v1 whole-index Tantivy manifest →
v2 `fts2/` per-segment registry). On 0.8.x a 0.7-written store **opens** but its FTS
index is **refused on first read/write** until it is rebuilt. The 2026-09-30 measurement
(backlog `89849d2a` citation `e258aa0a`) established the leak is **fixed on 0.8.1**
(interleaved 264 vs single 266 pages) with the 0.7.1 control still reproducing it. So the
pin move is **not** a version edit — it is a **data migration**, and a store built under
0.7.x must have its **already-leaked pages reclaimed**, not merely stop leaking.

The pin has **not** been bumped and is not authorized. This is the decision input.

## Deliverable

- `DESIGN.md` — the spec: migration sequence, reclamation, gate + `2bf0b7c8` fix,
  rollback, blast radius, tests, blockers.
- `STATE.md` — resumable execution state (`plan-state-machine/v1-light`).
- `contexts/` — per-segment working context.

## Definition of Done

- [ ] `dod.1` Pre-flight spike (§6a): rollback (0.7←fts2) and cross-version VACUUM
      hazards measured, not assumed.
- [ ] `dod.2` Gate observability fixed (`2bf0b7c8`): both page_counts always emitted.
- [ ] `dod.3` Migration spec implemented as a CLI subcommand (ADR-0013 D4), offline-exclusive.
- [ ] `dod.4` `fts-format-migration.bl-89849d2a.spec.ts` written, seen RED, then GREEN.
- [ ] `dod.5` `fts-gate-evidence.bl-2bf0b7c8.spec.ts` written, seen RED, then GREEN.
- [ ] `dod.6` 0.7.1 control run retained and passing.
- [ ] `dod.7` `_key`/`verifyTursoFtsMaterialization` re-leak hazard resolved.
- [ ] `dod.8` Pin bump + relock applied only on owner authorization; lockfile committed
      in the same change.
- [ ] `dod.9` Migration verified on a production-store copy: counts equal, sentinel hits
      equal, integrity clean, page_count down, counter 0.
- [ ] `dod.10` Proposed ADR-0026 drafted and owner-approved before any file is written.

## Execution model

- Isolated worktree per segment (`BL-235`/`BL-456`: nx targets have no dry-run and
  rebuild upstream `dist/`). Quote
  `node tools/check-suite-tree-state.mjs --project <project>` with every suite result.
- nx targets only: `npx nx build|lint|test|typecheck <project>`.
- Red→green before any status marker (`BL-225`).
- Commit by explicit pathspec, hooks on; never `git add -A`/`.`/bare `git commit`/
  `--no-verify`/`git stash`/`reset --hard`/`--amend`.
- `registry/index.json` untouched (ADR-0021).

## Dispatch

```
Dispatch: docs/plan/turso-fts-migration — execute s1 (pre-flight spike) first; it is
entry-blocking. Do not dispatch s2+ until s1 returns measured results.
```
