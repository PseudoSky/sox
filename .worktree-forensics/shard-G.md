# Shard G — abandoned-worktree forensics (read-only)

Repo `/Users/nix/dev/ai/sox-ecosystem`, `main` @ `051d033c` (docs(plan): spec the Turso FTS 0.7.x→0.8.x format migration).
No repository state changed: no add/commit/stash/reset/clean/checkout/restore/worktree-remove, no build, no test. Only write = this file.

Honest signals only: `main...HEAD --stat` (committed delta vs merge-base) and HEAD-relative numstat (`diff HEAD`).
`git diff main`/`diff --cached main` phantom figures deliberately not used.

## Stamp artifact (measured)

An identical uncommitted set — `keywords` / `repository` (github.com/PseudoSky/adhd) / `homepage` added to **29 `package.json`** files, +370/−29 — present in four of the five worktrees (`fix-fk-heal-fts-residue`, `memory-scope-empty`, `migration-fails-open`, `perf-memory-004`).
The change is **redundant with `main`**: e.g. `main:libs/memory-core/package.json` already ends with the exact same keywords/repository/homepage block (verified — the uncommitted diff re-creates main's metadata on a pre-refactor branch tip; not new work). `soxe upgrade` version-stamp shape.

## Verdicts

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| fix-fk-heal-fts-residue | `fix/fk-heal-fts-residue` | 0 | (empty — 0 files) | 0 | 0 | BL-506 / BL-507 / BL-508 | yes — every commit is an ancestor of `main` | **junk-stamp** | `main..HEAD` empty; only working-tree dirt is the 29-file package.json stamp, redundant with main. |
| memory-scope-empty | `feat/memory-scope-empty` | 0 | (empty — 0 files) | 0 | 0 | none unique (tip `76289093` = BL-215, shared with `cluster-full-pass-schedule`) | yes — fully contained in `main` | **junk-stamp** | `main..HEAD` empty; only dirt is the stamp. Tip commit shared with another branch. |
| memory-state-stale-prose | `docs/memory-state-stale-prose` | 1 | `docs/reporting/memory/{PLAN.md,STATE.md}` +75/−80 | 0 | **2** (`PLAN.md`, `STATE.md`) | bl435 (BL-435) | yes — 400 behind; main has 8+ later commits on the same two files | **superseded** | Unique commit `d6b72c2d` resyncs prose with the graph; `main` has since evolved those exact docs and merge-trees both → overtaken. |
| migration-fails-open | `feat/migration-fails-open` | 1 | `SPEC-MIGRATE-UNSAFE.md` +487/−0 (new file) | 0 | 0 | BUG-STOREADAPTER-MIGRATE-UNSAFE-001 | no — spec absent from `main` (956 behind) | **needs-owner** | Unmerged 487-line spec for a bug `main` still calls "not verified either way" (findings 2026-08-08); no code fix in store-adapter. |
| perf-memory-004 | `fix/perf-memory-004` | 0 | (empty — committed work all in `main`) | 1 (`libs/memory-core/src/perf-memory-004-write-importance-default.spec.ts`, 155 lines) | 0 | PERF-MEMORY-004 | yes — `main` already fixes it | **superseded** | Uncommitted `write.ts` +19/−3 re-implements PERF-MEMORY-004, but `main:write.ts` already fixes it (lines 203/311/324, `effectiveImportance = computeImportance`) and is refactored +229/−49 → spec is stale. |

## Bullets

- **migration-fails-open** — `feat/migration-fails-open` @ `944034a9` adds `SPEC-MIGRATE-UNSAFE.md` (487 lines, new, absent from `main`, 0 merge conflicts). Targets **BUG-STOREADAPTER-MIGRATE-UNSAFE-001** (migration fails open). `main`'s own 2026-08-08 reprioritization note lists it as *"Not verified either way … the code concern looks live … script not on any hot path"*; `git grep` finds no fail-open fix in `libs/data/store/store-adapter/src` (only an unrelated "fail-open" comment in `integrity.ts:3281`). This is an unmerged, un-owned design spec — owner must decide adopt / port into the `docs/plan/turso-fts-migration/` plan (main `051d033c`) / discard. Also carries the stamp dirt plus a 2-line `{PLAN,STATE}.md` edit.

## Stamp-only worktrees

`fix-fk-heal-fts-residue`, `memory-scope-empty` — ahead=0, zero non-stamp dirt, only artifact = the 29-file package.json stamp. Both are pure `junk-stamp`; nothing to rescue.

## Ticket ids found

BL-506, BL-507, BL-508 (`fix-fk-heal-fts-residue` commits, already in main) · bl435 / BL-435 (`memory-state-stale-prose`) · BUG-STOREADAPTER-MIGRATE-UNSAFE-001 (`migration-fails-open`) · PERF-MEMORY-004 (`perf-memory-004`, from name/filename; no graph-form BL/BUG id seen). `memory-scope-empty`: no unique id.

## Honest line totals (committed, `main...HEAD`)

fix-fk-heal-fts-residue 0/0 · memory-scope-empty 0/0 · memory-state-stale-prose +75/−80 · migration-fails-open +487/−0 · perf-memory-004 0/0 → **shard total +562 / −80**.
Plus non-stamp uncommitted in `perf-memory-004`: `write.ts` +19/−3 and one untracked 155-line spec (superseded; not counted as shard work).

## Conflicts (merge-tree, no mutation)

0 for four; `memory-state-stale-prose` = 2 (`docs/reporting/memory/PLAN.md`, `docs/reporting/memory/STATE.md`).
