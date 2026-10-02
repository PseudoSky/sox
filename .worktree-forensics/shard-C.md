# Worktree forensics — shard C

Repo `/Users/nix/dev/ai/sox-ecosystem`. Default branch `main` = `051d033cbb6358200a44cc913172356c50e001da`.
Read-only: no repo state changed; no merge trial performed (`git merge-tree --write-tree --name-only` only).

**Stamp artifact (shard variant):** 29 × `package.json` unstaged-modified (+370/−29 per worktree) — the
discoverability metadata stamp mandated by AGENTS.md rule 3: each file gains `repository`
(`git+https://github.com/PseudoSky/adhd.git`), `homepage` (`https://github.com/PseudoSky/adhd`) and
`keywords`. **Not** a version bump. It is the *only* dirt in four of these five. Note two corrections to
the "six-file" description: (a) the set here is a **29-file superset** (all publishable `libs/*` +
bundle members, not just the six), and (b) the stamp is **redundant with `main`** — `main` already
carries `repository`/`homepage`/`keywords` in `apps/sox/package.json` etc., so the worktree merely
re-applies metadata the branch's old HEAD predates.

**BASE-DIVERGENCE TRAP observed, avoided:** every one of these five is a pre-refactor branch — `git diff main`
shows hundreds of phantom files (e.g. `git diff main -- apps/sox/package.json` reports −15/+11 real
old-vs-current drift). The only honest signals are `main..HEAD` (all ∅) and HEAD-relative numstat.

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| bl472-shutdown-drain | feat/bl472-shutdown-drain | 0 | ∅ (0 files) | none | 0 | BL-472 | yes | superseded | tip `b3d27b27` ("close BL-472") + fix `08bec739` + test `d3645d39` all reachable from `main`; dirt = 29-file stamp |
| bl474-bgslot-contention | feat/bl474-bgslot-contention | 0 | ∅ (0 files) | none | 0 | BL-474 | yes | superseded | tip `4d06f755` + fixes `7edf8540`/`e96c9eea`/`c7409c0e` in `main`; dirt = stamp + stale `pnpm-lock.yaml` relock |
| bug-memory-001-write-loss | feat/bug-memory-001-write-loss | 0 | ∅ (0 files) | none | 0 | BUG-MEMORY-001 | yes | superseded | tip `df012ec9` (`instrumentAdapter` snapshot fix) reachable from `main`; dirt = 29-file stamp |
| bug-memory-002-004-error-and-doc-surface | feat/bug-memory-002-004-error-and-doc-surface | 0 | ∅ (0 files) | `check-probe-uids.mjs` | 0 | BUG-MEMORY-002, BUG-MEMORY-004 | yes | superseded | tip `80d963fe` + fix `af684ac0` in `main`; dirt = stamp + 1 throwaway probe script |
| bug-memory-003-recall-null-rows | feat/bug-memory-003-recall-null-rows | 0 | ∅ (0 files) | none | 0 | BUG-MEMORY-003 | yes | superseded | tip `9b475841` + fixes `c8fe93f0`/`d6bfaa4e` reachable from `main`; dirt = 29-file stamp |

## useful / needs-owner detail

- **None.** All five branches are fully contained in `main` (`git rev-list --count main..HEAD` = 0 for each;
  every branch tip verified via `git merge-base --is-ancestor <tip> main` = YES, and the named fix/test
  commits are present in `git log main`). No worktree holds unique unmerged work. **Rescue value: zero** —
  all five are safe to delete.

## Near-junk co-residents (not stamp, still disposable)

- **bl474 — `pnpm-lock.yaml` (+9, 30 modified files).** Adds the `libs/data/graph/graph-store/conformance-fixture`
  importer. `main`'s lockfile **already** contains that importer (`main:pnpm-lock.yaml:341`), so this is a stale
  mechanical relock against the old HEAD's tree — regenerable, not real work.
- **bug-memory-002-004 — untracked `libs/data/store/store-adapter/check-probe-uids.mjs` (14 lines).** A one-off
  debug probe: hardcodes three UIDs and a `/private/tmp/.../scratchpad/probe.db` path, queries `node`
  rows by hand. Throwaway investigative artifact, not a deliverable.

## Notes for the operator

- **Ticket ids confirmed** (extracted from branch names + commit subjects, not invented): BL-472, BL-474,
  BUG-MEMORY-001, BUG-MEMORY-002, BUG-MEMORY-003, BUG-MEMORY-004 (the `-002-004-` worktree covers **two** ids).
- **Stamp-only:** bl472-shutdown-drain, bug-memory-001-write-loss, bug-memory-003-recall-null-rows (exactly
  29 `package.json`, nothing else). Non-stamp clutter: bl474 (+lockfile), bug-memory-002-004 (+probe).
- Per shard-A convention, reachable-from-main + stamp-only dirt ⇒ `superseded` (not `junk-stamp`), since each
  branch carries real, landed ticket work rather than being a bare old-`main` pointer.
