# dispatch-worktrees — stamp, classify, dispose, retain

The dispatcher's playbook for worktrees: every worktree is stamped with an owner when created, and every worktree found (this run's or older) is classified read-only and given exactly one disposition. Rule 22 covers the target branch's tree; this covers every other tree. Load at run start (sweep), at each worktree creation (stamp), and at Step 7 teardown. Uses the lifecycle's git (rule 23); backlog traffic goes through `backlog-operator`.

## 1. Stamp at creation

One branch per worktree, never detached. Run, then have `backlog-operator: enrich` the item with the path, branch and base sha:

```text
git worktree add <repo>/.worktrees/<slug> -b <branch> <base>
git config branch.<branch>.description "run=<run id> ticket=<backlog uid> created=<ISO8601>"
```

Read it from inside the worktree: `git -C <wt> config branch.$(git -C <wt> branch --show-current).description`. The stamp is repo config keyed by branch: it is not a file, so it never dirties a tree, survives `git branch -m`, and `git branch -d` removes it. No stamp = unowned legacy tree: classify on evidence only (§3 ownership gate).

## 2. Classify (read-only)

Set `B` = branch (or `HEAD` when detached), `W` = worktree path, `T` = target branch (`main`). Prefix every command that reads a worktree with `GIT_OPTIONAL_LOCKS=0` so `status` cannot rewrite the index.

| # | Evidence | Command | Reads as |
|---|---|---|---|
| e1 | merged into T | `git merge-base --is-ancestor B T; echo $?` | 0 = every commit is in T |
| e2 | unmerged commits | `git rev-list --count T..B` | n > 0 = commits T lacks |
| e3 | patch-equivalent | `git cherry T B` | only `-` lines = landed by rebase/cherry-pick; any `+` = unlanded work; empty with e2 > 0 = merge commits only (ambiguous) |
| e4 | content landed | `git diff --quiet T B -- $(git diff --name-only $(git merge-base T B) B)` | exit 0 = B's files equal T's (covers squash). Run only when e1 ≠ 0 (an ancestor has no files to compare). Non-zero is inconclusive: T may have moved on |
| e5 | dirty / untracked | `git -C W status --porcelain --untracked-files=all` | any line = dirty. Untracked counts; ignored files do not |
| e6 | what is dirty | `git -C W diff HEAD --stat`, `git -C W diff HEAD \| git patch-id --stable` | size, plus a fingerprint: equal fingerprints across trees = one shared residue |
| e7 | age | `git log -1 --format=%cs B` | last commit date |
| e8 | owner + ticket | stamp (§1), then `backlog-operator` reads `status` of the stamped uid | live (non-terminal) vs terminal; no stamp = unowned |

The classification is the first row that matches (merge state), then the tree state:

| merge state | rule |
|---|---|
| MERGED | e1 = 0 |
| LANDED | e1 ≠ 0 and (e3 has no `+` lines with e2 > 0, or e4 = 0) |
| UNMERGED | e3 has any `+` line |
| DIVERGED | e2 > 0 and e3 empty (merge commits only), or anything not above |

Tree state: CLEAN when e5 is empty, otherwise DIRTY. Age (e7) never changes the class; it only schedules the sweep (§5).

## 3. Disposition — exactly one action per class

Ownership gate first: a tree stamped by another run whose ticket (e8) is non-terminal is `LIVE` — leave it, report it. Unstamped or terminal-ticket trees proceed to the table.

| class | action |
|---|---|
| MERGED + CLEAN | `git worktree remove <W>`, then `git branch -d <B>` |
| LANDED + CLEAN | `git worktree remove <W>`; keep `<B>` (git cannot prove it merged) and list it in the ticket for the retention sweep |
| any + DIRTY | **rescue**: in `<W>`, `git switch -c rescue/<slug>`, stage the explicit paths from e5 (`git add -- <path>…`), `git commit -m "chore: rescue <slug>" -- <path>…`; then re-classify `<W>` — it is now CLEAN. More than 10 trees sharing one e6 fingerprint: §4 instead |
| UNMERGED + CLEAN | keep `<B>`; `backlog-operator` files or enriches a ticket citing branch, head sha and the `+` lines of e3; route it through `dispatch-direct` (rebase on the plan branch, ff-only merge); `git worktree remove <W>` only once the ticket records the sha |
| DIVERGED + CLEAN | ask the user (§4) |

A rescue never touches `B`'s own history and never uses `stash`; a rescued tree re-enters the table as MERGED/LANDED/UNMERGED + CLEAN. If a hook rejects the rescue commit, the tree is ambiguous.

## 4. Ambiguity — ask, with the evidence

Ask the user (one batched question, not one per tree) when: class is DIVERGED; the rescue commit is rejected; the worktree is locked, a submodule, or unreadable; a stamp names a run you cannot tell is finished; or more than 10 DIRTY trees share one e6 fingerprint (ask once about the group). The question carries, per tree: path, branch, class, e1–e8 values, and your proposed disposition. Until answered the tree is left exactly as found.

## 5. Retention — nothing accumulates, nothing valuable is lost

- **Sweep at every run start and every Step 7**: classify all worktrees in the target repo (read-only), dispose every non-ambiguous one per §3, queue the rest into one §4 question. A tree whose ticket is terminal, or whose last commit is older than 14 days with no live ticket, is due at the next sweep.
- **Directories are disposable, commits are not**: a worktree directory is removed only when its content is on a named ref (merged into `T`, landed, or a branch recorded in a ticket). Branches holding commits `T` lacks are never deleted by the dispatcher.
- **Kept branches expire only by the user**: `<B>` and `rescue/*` branches stay listed in their ticket; once the ticket is resolved and the branch is MERGED or LANDED, the next sweep puts the deletion (`git branch -d`, or the user's `-D` for LANDED) in its §4 batch.
- **Report the sweep**: counts per class and the ask-queue, in the run's close-out.

## Hard rules

- Never `git stash`, `git reset --hard`, `git clean`, `git checkout -- <path>`, or `git worktree remove --force` — a refusal from `git worktree remove` means the tree is not CLEAN: go to the table, never around it.
- Classification is read-only; mutate only after a class is recorded in the run's notes.
- Never judge value by age, size, or branch name; the evidence rows decide.
- Stage explicit paths only (`git add -A` and `git commit -a` are banned).
