# Worktree forensics — shard B

Read-only inventory. No repository state changed (no add/commit/stash/reset/clean/checkout/restore/worktree-remove, no builds, no tests). All figures from `git -C <wt> ...`; `main...HEAD` is merge-base→HEAD (the honest signal — a bare `git diff main` shows hundreds of phantom files because these branches fork from a pre-refactor `main`). Conflict count is `git merge-tree --write-tree --name-only main <branch>` (0 conflicted paths for all five; rc=0).

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| `.worktrees/bl373-sidecar-staleness` | `fix/bl373-sidecar-staleness` | 0 | (empty) | 0 | 0 | BL-373 | yes | junk-stamp | HEAD `7aface91` is an ancestor of main; only dirt = the shared 29-file AEO-metadata stamp (+370/−29), working tree ≈ main one version behind |
| `.worktrees/bl447-ddl-substring-probe` | `feat/bl447-ddl-substring-probe` | 0 | (empty) | 0 | 0 | BL-447 | yes | junk-stamp | HEAD `75690df6` ancestor of main; identical dirty set (name-list sha1 `0c96070b78ff928cf7a06704dc4d910ae6e80686`), no unique content |
| `.worktrees/bl460-changeset-backfill` | `feat/bl460-changeset-backfill` | 0 | (empty) | 0 | 0 | BL-460 | yes | junk-stamp | HEAD `658f68cc` ancestor of main; identical dirty set; related graph item `d01c0c86` (graph-store/vector-store changesets) is **resolved** |
| `.worktrees/bl460-changeset-close` | `feat/bl460-changeset-close` | 0 | (empty) | 0 | 0 | BL-460 | yes | junk-stamp | HEAD `8608c86d` ancestor of main; identical dirty set; no unique content |
| `.worktrees/bl466-wire-guards` | `feat/bl466-wire-guards` | 0 | (empty) | 1432 | 0 | BL-466 | yes | needs-owner | HEAD `88a9cee3` ancestor of main; index mass-unstaged — 1433 staged deletions (−326997, 0 insertions), 1432 on-disk files turned untracked; no unique content |

## Shared stamp artifact (four worktrees)

`bl373-sidecar-staleness`, `bl447-ddl-substring-probe`, `bl460-changeset-backfill`, `bl460-changeset-close` are in an **identical** state:

- `status --porcelain` = exactly **29 lines, all first-column ` M`** (unstaged modified; no staged entries, no deletions); `git diff --stat HEAD` = **29 files changed, +370/−29**.
- The 29 modified-file **name list is byte-identical** across all four (sha1 `0c96070b78ff928cf7a06704dc4d910ae6e80686`). All 29 are `package.json`: `.claude/skills/memory-usage/package.json`, `apps/sox/package.json`, `extensions/bundles/sox-memory-bundle/package.json` + its four `members/*/package.json`, and 22 `libs/**` / `libs/data/**` manifests. (This is the task's six-file stamp set — `apps/sox/package.json`, `.claude/skills/memory-usage/package.json`, the four bundle-member manifests — as a subset of a broader 29-file pass.)
- The dirt **adds AEO discoverability metadata** (`keywords` array, `repository` → `git+https://github.com/PseudoSky/adhd.git`, `homepage`) — i.e. it satisfies the AGENTS.md publishable-package rule.
- **The only distinction from `main` is a stale version.** `main` already carries the same metadata: diffing `git show main:libs/tokenguard-core/package.json` against the worktree's on-disk file yields exactly one hunk — `"version": "0.2.1"` (main) vs `"0.2.0"` (worktree). The committed HEAD of each branch predates the metadata (`git show HEAD:<pkg>` has zero `keywords|repository|homepage` matches), so each working tree literally holds **main's tree minus a version bump**, uncommitted.

Verdict **`junk-stamp`**: the sole dirt is the shared, stale, redundant stamp set; `main` already has the finished form. Nothing unique to rescue.

## `bl466-wire-guards` — needs-owner (higher risk)

- Index is **mass-unstaged**: `git ls-files` (index) = **21 entries**; `git ls-tree -r HEAD` = **1454 files**. So **1433 of 1454 tracked files are staged-deleted vs HEAD** and their on-disk copies became untracked — a `git rm -r --cached .`-style **revert bomb** (a bare `git commit` would delete the whole repo). `git diff --stat HEAD` = 1433 files, **−326997**, 0 insertions.
- Staged deletions by top dir: `libs` 553, `docs` 274, `.workflow` 156, `extensions` 151, `.opencode` 102, `tools` 64, `scripts` 36, `.claude` 23, `apps` 21, `packages` 15, `schemas` 3, `.github` 2, plus every root file (`package.json`, `pnpm-lock.yaml`, `nx.json`, `AGENTS.md`, `README.md`, …).
- **Prior-audit correction:** the earlier note that bl466's staged deletions are *only* `.changeset/config.json` + `.claude/agents/org-agent/*` **understates the current state** — those two are present (`D  .changeset/config.json`, `D  .claude/agents/org-agent/{CHANGELOG.md,README.md,extension.json,org-agent.md,package.json}`, plus `extensions/agents/org-agent/*`) but are just 6 entries inside a **1433-file whole-repo index wipe**.
- The **21 surviving index entries** are exactly the BL-466 guard-wiring surface: `tools/run-guards.mjs`, `tools/guards-manifest.mjs`, `tools/verify-native-abi.mjs`, and `tools/test-bl{222,409,416,446,454,456,457,463,464,465,466}-*.mjs`, plus `.github/workflows/ci.yml`, `.husky/pre-commit`, `BACKLOG.md`, `CHANGELOG.md`, `docs/reporting/memory/{PLAN,STATE}.md`, `project.json`.
- **No salvageable content:** every untracked file is byte-identical to its HEAD blob (sampled `package.json`, `vitest.config.ts`, `README.md`); a scan for untracked paths absent from HEAD returned empty. `git reflog` is empty. HEAD (`88a9cee3`, "resolve BL-466") is already in main.
- Related graph item `22f4f8ab` ("`tools/guards-manifest.mjs` claims BL-466-a exhaustiveness … nothing enforces the claim") is still **open** — but the branch holds no code beyond main.

Verdict **`needs-owner`**: zero unique content, yet the leftover index is a whole-repo revert bomb that must not be discarded blindly — an owner should confirm before the worktree is removed.

## Backlog references

- Implied ids from branch names: **BL-373**, **BL-447**, **BL-460** (both bl460 worktrees), **BL-466**. None invented.
- Graph (read-only): `d01c0c86` (BL-460 graph-store/vector-store changeset drift) = **resolved**; `22f4f8ab` (BL-466 guard-manifest claim) = **open**; BL-373 candidate `0d7c23c9` (live memory-server `-tshm` sidecar) = **BLOCKED**, BL-447 related CHECK items (`c5e4753e` etc.) = **resolved** — these two by grep, inconclusive as to the exact branch item.

## Bullets — useful / needs-owner

- **needs-owner — `.worktrees/bl466-wire-guards`**: no unique content (all untracked bytes == HEAD; BL-466 work already in main), but the index is staged-deleted for 1433 files (revert bomb). Owner must confirm before removal so an accidental `git commit` in that worktree cannot wipe the repo.
- (No `useful` worktrees in shard B: all five branches are ancestors of `main`, 0 commits ahead, 0 conflicts; the four non-bl466 worktrees hold only the shared junk stamp.)
