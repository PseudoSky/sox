# Worktree forensics — shard N

Read-only. No repository state was changed. All measurements HEAD-relative; `git diff main...HEAD` used
(never `git diff main`, which is confounded by pre-refactor base divergence on every branch here).

> Reconstructed fragment. Shard N's agent mis-wrote its fragment to `shard-K.md`; the on-disk
> `shard-K.md` holds shard K's correct content, so N's fragment was lost from disk and is restored
> here from the authoritative shard-N return.

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| .worktrees/typecheck-tooling | (branch not stated in return) | 0 | empty (0 files) | 0 | 0 | BL-493, BL-248, BL-325, SPEC-PKT-62 | yes | junk-stamp | HEAD `63755e17` ancestor of main (0 ahead, 921 behind); `main...HEAD` empty; 29-file stamp byte-identical across both and stale (net −75 vs main, e.g. `0.2.0` vs main's `0.2.1`) |
| .worktrees/typecheck-transport-sources | (branch not stated in return) | 0 | empty (0 files) | 0 | 0 | BL-248, BUG-SERVICE-PROXY-NOOP-ASSERTION-001 | yes | junk-stamp | HEAD `4ccd44fd` ancestor of main (0 ahead, 921 behind); same 29-file stamp; nothing to rescue |

## Stamp artifact

Both worktrees carry the same canonical 28–29-file `package.json` stamp (path-set sha1
`0c96070b78ff928cf7a06704dc4d910ae6e80686`), byte-identical across the two HEADs and **stale**:
net **−75** versus `main` — e.g. the worktree working copy reads `0.2.0` where `main` reads `0.2.1`.
`main...HEAD` is empty on both; there is no committed work to recover.

## Confirmation — the `typecheck` target layering is already complete in `main`

Every project these two branches touched — `tokenguard-core`, `sox-nx`, `baseline-capture`,
`service-proxy`, `host-registry`, `source-provider` — already has a `typecheck` target in `main`,
plus `tools/baseline-capture/tsconfig.typecheck.json`. `main`'s log additionally carries the later
`noop → typecheck-tests → typecheck-src` refactor (`86de3108`, `b1d71619`), which **supersedes both**.

## Worth rescuing

**Nothing.** Both tips are ancestors of `main`; the only residue is the stale, redundant stamp.
