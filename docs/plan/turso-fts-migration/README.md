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

The pin is now `^0.8.1`: the bump **landed in segment s5** (commit `4e77e94a`), applied on
owner authorization (`STATE.md` Q1 resolved; commit `8c051cdc`), with all five manifests
and `pnpm-lock.yaml` relocked in the same change.

## Deliverable

- `DESIGN.md` — the spec: migration sequence, reclamation, gate + `2bf0b7c8` fix,
  rollback, blast radius, tests, blockers.
- `STATE.md` — resumable execution state (`plan-state-machine/v1-light`).
- `contexts/` — per-segment working context.

## Definition of Done

- [x] `dod.1` Pre-flight spike (§6a): rollback (0.7←fts2) and cross-version VACUUM
      hazards measured, not assumed.
- [x] `dod.2` Gate observability fixed (`2bf0b7c8`): both page_counts always emitted.
      Evidence: `fts-gate-evidence.bl-2bf0b7c8.spec.ts` proves both counts are emitted on
      both failure corners.
- [x] `dod.3` Migration spec implemented as a CLI subcommand (ADR-0013 D4), offline-exclusive.
      Evidence: `memory fts-migrate` (`memory-cli/src/index.ts`), backed by
      `migrateStoreFormatOffline` (`store-rebuild.ts`).
- [x] `dod.4` `fts-format-migration.bl-89849d2a.spec.ts` written, seen RED, then GREEN.
- [x] `dod.5` `fts-gate-evidence.bl-2bf0b7c8.spec.ts` written, seen RED, then GREEN.
- [x] `dod.6` 0.7.1 control run retained and passing. **N/A** — no in-tree 0.7.1 control run
      exists (owner declined to restore one); the leak is driver-fixed and all manifests pin
      `^0.8.1`. Not-applicable, not a claimed green.
- [x] `dod.7` `_key`/`verifyTursoFtsMaterialization` re-leak hazard resolved.
      **Repair path (BL-507/BL-461):** on 0.8.1 the in-process `DROP INDEX` is refused when
      the `_key` backing row is missing, so the orphan destroy and the `ensureFtsIndex`
      re-CREATE must both go out of band through `deleteSchemaRowsViaBetterSqlite3` (shared
      `destroyOrphanedFtsIndex` in `fts-repair.ts`; repair context supplied by
      `turso-adapter.ts`).
- [x] `dod.8` Pin bump + relock applied only on owner authorization; lockfile committed
      in the same change. Evidence: `4e77e94a` (`^0.8.1` across all five manifests +
      `pnpm-lock.yaml`).
- [x] `dod.9` Migration verified on a production-store copy: counts equal, sentinel hits
      equal, integrity clean, page_count down, counter 0. Verified PASS — base counts 14/14,
      sentinel hits 3/3, integrity ok / no new damage, `page_count` 46050→43704, file
      188,620,800→179,011,584 bytes, counter 6→0, live `fts_match` equal.
- [x] `dod.10` Proposed ADR. **OWNER-WAIVED** — no ADR written under `docs/decisions/` (owner
      judged it unnecessary ceremony; the offline CLI subcommand — not env/auto-heal — and the
      rollback contract are carried by the code + tests).

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
Dispatch: docs/plan/turso-fts-migration — COMPLETE. s1–s5 and s7 are LANDED on `main`
(migration engine + `fts-migrate` CLI verb `3df09bc5`; out-of-band orphan destroy s2+s3+s7
`0bb7b7ee`; pin bump s5 `4e77e94a`; rollback-image fix `660be41a`, merged `11e6960b`;
rollback hardening `f13c8912`, merged `e330a1f9`). s6/dod.9 is VERIFIED PASS on a
production-store copy. dod.6 is not-applicable and dod.10 is owner-waived (no ADR). Final
`main` HEAD `e944057d`.
```
