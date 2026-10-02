# Shard E — abandoned worktree forensic inventory

Read-only. No repository state mutated. Signals used: `rev-list main..HEAD` (ahead),
`diff main...HEAD --stat` (honest divergence — `git diff main` is phantom due to a
pre-refactor base), HEAD-relative numstat, `ls-files --others --exclude-standard`,
`merge-tree --write-tree --name-only main <ref>`, is-ancestor supersession check.

All five worktrees: **ahead = 0** (every committed change is already an ancestor of `main`),
`main...HEAD` diffstat **empty**, **no untracked** files, **0 merge conflicts** vs `main`
(merge-tree rc=0 for all). Their only remaining delta over `main` is an uncommitted
**package.json metadata stamp** (adds `keywords` / `repository` / `homepage`) — 29 files in
four of them, 28 in `cf-test`.

> Stamp caveat: the task-named "known six-file soxe-upgrade stamp" is a **subset** of what
> these worktrees carry. Here the stamp is broader — 28–29 `package.json` files, same
> discoverability fields. Same artifact class, wider fan-out.

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| bug021-t3 | `bug021/t3` | 0 | empty | none | 0 | BUG-021 | yes — HEAD e68e9224 is ancestor of main | junk-stamp | commits already in main; sole dirt = 29×package.json stamp (+370/-29) |
| c-fix-fts | `fix/c-fts-object` | 0 | empty | none | 0 | BL-507 | yes — 7343ee0c ancestor; landed via `c2f1baee` (BL-506/507/508) | junk-stamp | commits already in main; sole dirt = 29×package.json stamp (+370/-29) |
| cf-test | (detached HEAD @ `6de81319`) | 0 | empty | none | 0 | none (draft cites `BL-NNN` placeholder) | yes — 6de81319 is ancestor of main | needs-owner | DETACHED + DIRTY; dirt = 28×package.json stamp **+ real uncommitted `libs/memory-core/src/cluster.ts` draft (+12/-2) not in main** |
| cluster-full-pass-schedule | `feat/cluster-full-pass-schedule` | 0 | empty | none | 0 | BL-215 | yes — ancestor; BL-215 landed (55574ae7, 1d2251b0) | junk-stamp | commits already in main; sole dirt = 29×package.json stamp (+370/-29) |
| debt-soxgraph-002 | `fix/debt-soxgraph-002` | 0 | empty | none | 0 | DEBT-SOXGRAPH-002 | yes — 9ca26d51 ancestor, merged via `8e747a17` | junk-stamp | commits already in main; sole dirt = 29×package.json stamp (+370/-29) |

## needs-owner

- **cf-test** — Detached HEAD at `6de81319` (an ancestor of `main`), **dirty**. Besides the
  stamp it holds an uncommitted, non-committed source draft in
  `libs/memory-core/src/cluster.ts` (+12/-2): `buildClusterResults` gains
  `membersWithVecs = members.filter((r) => rowidToVec.has(r)); if (membersWithVecs.length < 2) continue;`
  and drops the trailing `.filter(Boolean)` from `memberVecs`. The change references
  `(BL-NNN)` — a placeholder, no real ticket id. `main` does **not** contain
  `membersWithVecs` (`git grep` rc=1), but `main`'s caller already filters
  `rowids` to rows present in `rowidToVec` upstream, so the invariant may be handled
  elsewhere. Detached + dirty is the highest-risk shape here: an owner must decide
  **discard vs. recover** — do not silently drop.
