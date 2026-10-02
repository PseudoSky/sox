# Worktree forensics — shard F

Repo `/Users/nix/dev/ai/sox-ecosystem`. Default branch `main` = `051d033cbb6358200a44cc913172356c50e001da`.
Read-only: no repo state changed; no merge trial performed (`git merge-tree --write-tree --name-only` only).

**Stamp artifact:** 29 × `package.json` unstaged metadata (`keywords`/`repository`/`homepage`),
name-list sha1 `0c96070b78ff928cf7a06704dc4d910ae6e80686`, `+370/−29` — the AGENTS.md rule-3
discoverability stamp re-applied by `soxe upgrade`. Proven redundant with `main`: each file's
**committed** HEAD blob lacks the metadata, the working tree adds it, and `main`'s committed blob
**already carries it** (e.g. `libs/memory-core/package.json` — HEAD has none; working tree adds
`keywords` L42 / `repository` L49 / `homepage` L53; `main` has all three at the same lines).

Every branch tip below is reachable from `main` (`git merge-base --is-ancestor <tip> main` = 0):
**no unique commits, no untracked files, zero conflicts in all five.**

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| debt003-t2 | debt003/t2 | 0 | ∅ (0 files) | none | 0 | DEBT-003 | yes | junk-stamp | tip `89350ada` in `main`; only dirt = 29-file stamp (+370/−29) |
| debt031-telemetry | telemetry/debt031 | 0 | ∅ (0 files) | none | 0 | DEBT-031, BL-569, BUG-014 | yes | junk-stamp | tip `d89ffcf6` in `main`; stamp (+370/−29) + stale PLAN/STATE count-drift on obsolete base (+4/−4) |
| delete-markdown-backlog | feat/delete-markdown-backlog | 0 | ∅ (0 files) | none | 0 | BL-482, BL-441, BL-443 | yes | junk-stamp | tip `1c6a9db2` in `main`; stamp + redundant `pnpm-lock.yaml` importer (+9) already on `main`:341 |
| embed-warmup-cold-retry | feat/embed-warmup-cold-retry | 0 | ∅ (0 files) | none | 0 | bl376, BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001, BL-215 | yes | junk-stamp | tip `5850c81a` in `main`; only dirt = 29-file stamp (+370/−29) |
| engine-guard | fix/engine-guard | 0 | ∅ (0 files) | none | 0 | BL-508, BL-505, BL-504, BL-500, DEBT-SOXGRAPH-001 | yes | junk-stamp | tip `bcd190f2` in `main`; only dirt = 29-file stamp (+370/−29) |

Totals (uncommitted, HEAD-relative): debt003-t2 +370/−29 · debt031-telemetry +374/−33 ·
delete-markdown-backlog +379/−29 · embed-warmup-cold-retry +370/−29 · engine-guard +370/−29.

## useful / needs-owner detail

**None.** No worktree in this shard is `useful` or `needs-owner`:

- All five tips are ancestors of `main` → nothing to rescue; no unique commits.
- No untracked files, no staged deletions, no detached HEAD, no stash-recovery state.
- Work landed in `main` is independently confirmed: `main` carries
  `libs/data/store/store-adapter/src/engine-guard.ts` + `__tests__/engine-guard.bl508.test.ts`
  (BL-508) and `lazy-connect.debt003.spec.ts` (DEBT-003).
- The two non-stamp extras are worthless: `debt031-telemetry`'s PLAN/STATE edit targets lines
  (`Open backlog items…`) that no longer exist on current `main`; `delete-markdown-backlog`'s
  `pnpm-lock.yaml` importer (`libs/data/graph/graph-store/conformance-fixture`) is already on
  `main` (L341).

Verdicts: 5 × `junk-stamp`, 0 × `useful`, 0 × `needs-owner`, 0 × `superseded`, 0 × `empty`.
