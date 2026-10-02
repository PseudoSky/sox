# Worktree forensics — shard H

Repo: `/Users/nix/dev/ai/sox-ecosystem` · `main` @ `051d033c` · read-only inventory (no state mutated).

All five worktrees share one property: **their branch tip is an ancestor of `main`** — the feature
work is already merged. Each carries the same uncommitted **`soxe upgrade` metadata stamp** (29
`package.json` files, path-set sha1 `0c96070b78ff928cf7a06704dc4d910ae6e80686`, uniform
`+370/−29`, redundant with `main`). No untracked files anywhere.

| worktree | branch | ahead | main...HEAD diffstat | untracked | conflicts | backlog id | superseded? | verdict | one-line evidence |
|---|---|---|---|---|---|---|---|---|---|
| `.worktrees/pkt07-lancedb-adapter-boundary` | `feat/pkt07-lancedb-adapter-boundary` | 0 | empty | none | 0 | PKT-07, BL-389 | yes | superseded | HEAD `b720488a` (+ `6a0ad4df`,`53594644`,`d4209543`) reachable from `main`; `merge-tree main feat/…` = main's tree `2a8fb7e2…` |
| `.worktrees/pkt18-reheal-stale` | `feat/pkt18-reheal-stale` | 0 | empty | none | 0 | PKT-18, BL-215, BL-88 | yes | superseded | HEAD `1d2251b0` (+ `5c18b70e`,`55574ae7`,`76289093`) reachable from `main`; merge result = main's tree |
| `.worktrees/pkt22-vec-distance-metric` | `feat/pkt22-vec-distance-metric` | 0 | empty | none | 0 | PKT-22, BL-392 | yes | superseded | HEAD `a03b576b` (+ `a81145a3`,`f495a58f`,`ea75a2cb`,`fb7638a1`) reachable from `main`; merge result = main's tree |
| `.worktrees/pkt38-service-enable-env` | `feat/pkt38-service-enable-env` | 0 | empty | none | 0 | PKT-38, BL-375 (+BL-489 filed) | yes | superseded | HEAD `053049ef` (+ `abe5ae95`,`89d0cc86`,`1a618c63`) reachable from `main`; merge result = main's tree |
| `.worktrees/pkt39-list-never-lies` | `feat/pkt39-list-never-lies` | 0 | empty | none | 0 | PKT-39, BL-332 | yes | superseded | HEAD `bcfc5dde` (+ `fa4d2301`,`31434b33`) reachable from `main`; merge result = main's tree |

**Bullets for `useful` / `needs-owner`:** none — no worktree in this shard holds unmerged work.

## Notes

- **Residual dirt = the stamp only** in all five; `git diff --stat HEAD` = `29 files changed,
  370 insertions(+), 29 deletions(-)`, identical in each. The stamp adds `keywords` / `repository`
  / `homepage` to 29 workspace `package.json` files and is **redundant with `main`** (e.g.
  `main:libs/memory-core/package.json` already carries all three). It is an environment-wide
  `soxe upgrade` artifact, not per-branch work — it does not make any of these `junk-stamp`,
  because each also holds real merged commits. No worktree here is stamp-only in the
  no-attributable-work sense.
- **Conflicts:** `git -C <wt> merge-tree --write-tree --name-only main feat/<wt>` exits 0 and
  yields tree `2a8fb7e2077e6ef5650e5eee16b45aa0306c3a27`, which equals `main^{tree}` — the merge is
  trivially `main` with zero conflicted paths, since each branch tip is an ancestor.
- **Superseded evidence:** `git merge-base --is-ancestor HEAD main` = true and
  `git log --oneline main` contains each branch's commit subjects (subjects name the PKT/BL the
  branch was cut for). Branch tips are off `main`'s first-parent line, i.e. they arrived via merge.
- **Nothing to rescue.** Every branch's content is byte-contained in `main` (modulo the redundant
  stamp). Safe candidates for removal.
