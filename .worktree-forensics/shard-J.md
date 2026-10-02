# Worktree forensics — shard J

Read-only. No repository state was changed. All measurements HEAD-relative; `git diff main...HEAD` used
(never `git diff main`, which is confounded by pre-refactor base divergence on every branch here).

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| .worktrees/pkt59-type-policy | feat/pkt59-type-policy | 0 | empty (0 files) | 0 | 0 | PKT-59 / BL-440 | yes | junk-stamp | HEAD=77ecc308 ancestor of main (0 ahead, 1077 behind); only dirt = 29 pkg.json stamp, byte-identical to main |
| .worktrees/pkt60-memory-ontology-seam | feat/pkt60-memory-ontology-seam | 0 | empty (0 files) | 0 | 0 | PKT-60 / BL-441 | yes | junk-stamp | HEAD=291535f8 ancestor of main (0 ahead, 1052 behind); only dirt = 29 pkg.json stamp, byte-identical to main |
| .worktrees/pkt61-operator-migration | feat/pkt61-operator-migration | 0 | empty (0 files) | 0 | 0 | PKT-61 / BL-442 | yes | junk-stamp | HEAD=e5917c27 ancestor of main (0 ahead, 1054 behind); only dirt = 29 pkg.json stamp, byte-identical to main |
| .worktrees/pkt62-tarball-conformance | feat/pkt62-tarball-conformance | 0 | empty (0 files) | 0 | 0 | PKT-62 / BL-443 | yes | junk-stamp | HEAD=741d04f5 ancestor of main (0 ahead, 1056 behind); only dirt = 29 pkg.json stamp, byte-identical to main |
| .worktrees/pkt63-release-060 | feat/pkt63-release-060 | 0 | empty (0 files) | 0 | 0 | PKT-63 / BL-444 | yes | junk-stamp | HEAD=c58b5c14 ancestor of main (0 ahead, 1002 behind); only dirt = 29 pkg.json stamp, byte-identical to main |

## Stamp artifact (identical on all five; the only working-tree change)

`git diff --shortstat HEAD` = **29 files changed, 370 insertions(+), 29 deletions(-)** on every worktree.
Content: adds `repository` (`git+https://github.com/PseudoSky/adhd.git`) + `homepage`
(`https://github.com/PseudoSky/adhd`) to each file. **Redundant**: `git diff main -- <those 29 paths>`
= 0 lines on all five ⇒ the working-tree stamp is byte-identical to `main`; `main:apps/sox/package.json`
already carries both fields (2 `PseudoSky/adhd` hits). Nothing staged (`git diff --cached` empty).
No untracked files in any of the five.

Raw `git diff HEAD | shasum` = `ec4acb8a…` (pkt59/60/61/62) and `3863317c…` (pkt63) — the pkt63 delta
is base-blob `index …` lines only; diff-of-diffs confirms added/removed **content is identical**.

## Useful / needs-owner

None. All five are merged-into-main history whose sole residue is the redundant stamp.
