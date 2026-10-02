# Worktree forensics — shard K

Read-only. No repository state was changed. All measurements HEAD-relative; `git diff main...HEAD` used
(never `git diff main`, which is confounded by pre-refactor base divergence on every branch here).

> Re-verified during assembly: the on-disk `shard-K.md` holds shard K's own content (this fragment),
> not shard N's. Shard line total +1955/−117. Ticket ids: PKT-74/BL-448, PKT-75/BL-473,
> PKT-79/BL-452, PKT-55/BL-215, BL-391. Nothing to rescue.

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| .worktrees/pkt74-open-edge-rel | feat/pkt74-open-edge-rel | 0 | empty (0 files) | 0 | 0 | PKT-74 / BL-448 | yes | junk-stamp | HEAD=befb1ee5 ancestor of main; only dirt = 29 pkg.json stamp (adds keywords/repository/homepage), fields already in main |
| .worktrees/pkt75-backlog-tooling | feat/pkt75-backlog-tooling | 0 | empty (0 files) | 0 | 0 | PKT-75 / BL-473 | yes | junk-stamp | HEAD=9a951cc4 ancestor of main; only dirt = 29 pkg.json stamp, fields already in main |
| .worktrees/pkt79-release-cascade | feat/pkt79-release-cascade | 0 | empty (0 files) | 0 | 0 | PKT-79 / BL-452 | yes | junk-stamp | HEAD=c97f3ab6 ancestor of main; only dirt = 29 pkg.json stamp, fields already in main |
| .worktrees/recall-degradation-proof | proof/recall-degradation-proof | 0 | empty (0 files) | 0 | 0 | BL-391 | yes | superseded | HEAD=b5a90314 ancestor of main; uncommitted 4-file/+475 recall-degradation feature + spec already fully in main (main spec 343 lines vs worktree 335; main index.ts has `recall_degradations` + `_resetRecallDegradationCountersForTest`) |
| .worktrees/recall-golden-set | feat/recall-golden-set | 0 | empty (0 files) | 0 | 0 | PKT-55 / BL-215 | yes | junk-stamp | HEAD=76289093 ancestor of main; only dirt = 29 pkg.json stamp, fields already in main |

All four junk-stamp entries share: **0 ahead, tip an ancestor of `main`, only dirt = the 29-file
`package.json` stamp.**

## Stamp artifact (identical on the four junk-stamp worktrees; the only working-tree change)

`git diff --shortstat HEAD` = **29 files changed, 370 insertions(+), 29 deletions(-)** on pkt74,
pkt75, pkt79 and recall-golden-set — path-set sha1 `0c96070b78ff928cf7a06704dc4d910ae6e80686`
(the canonical stamp). Content: each file gains a `keywords` array + `repository`
(`git+https://github.com/PseudoSky/adhd.git`) + `homepage` (`https://github.com/PseudoSky/adhd`).
**Redundant with `main`**: `main:libs/memory-core/package.json` already carries the identical
`keywords` / `repository` / `homepage` fields, as does `main:apps/sox/package.json` (2 `PseudoSky/adhd`
hits). Nothing staged (`git diff --cached` empty); no untracked files on any of the five.

`git diff main -- <29 stamp paths>` is **nonzero** (712 lines on pkt74) — this is *not* work; it is the
pre-refactor base-divergence artifact (`main` has advanced: `main:libs/memory-core/package.json` is
`version 0.12.3` / `workspace:^` where the worktree working copy is `0.5.0` / `workspace:*`). The
honest signal is the HEAD-relative 29 files / 370+ / 29- above; the stamp's *added* fields are what is
already in `main`.

`.worktrees/recall-degradation-proof` carries **no stamp** — its uncommitted dirt is real code:
4 files, 475 insertions(+), 1 deletion(-), path-set sha1
`d4fc39d5490ccdac667187ad4c4c98871f55f023` (`libs/memory-core/src/recall.ts` +13 empty-corpus
degradation emit; `memory-server/src/index.ts` +117 handler passthrough + `RecallDegradationCounters`
exposed as `recall_degradations` in `memory_ping`; new `recall-degradation-visibility.spec.ts` 335
lines; `memory-server/CLAUDE.md` +11).

## Useful / needs-owner

None. The four stamp worktrees are merged-into-main history whose sole residue is the redundant stamp.
`recall-degradation-proof` is superseded: its entire uncommitted feature + test is already committed in
`main`, which is one refinement ahead (its spec (343 lines) adds the `__resetRecallVecCircuitForTest`
import + resets absent from the worktree's 335-line copy). Nothing worth rescuing.
