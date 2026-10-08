# dispatch-worktrees — stamp, classify, dispose, retain

The dispatcher's playbook for worktrees: every worktree is stamped with an owner when created, and every worktree found (this run's or older) is classified read-only into exactly one class and given exactly one disposition. Rule 22 covers the target branch's tree; this covers every other tree. Load at run start (sweep), at each worktree creation (stamp), and at Step 7 teardown. Backlog traffic goes through `backlog-operator`.

**Who runs git.** The dispatcher classifies (read-only), creates and removes its own lifecycle worktrees — the plan and bucket trees of rule 23 — and asks. `git-manager`, dispatched with the run line, performs every other write: the stamp, rescue (`switch -c`, stage, commit), `git branch -d`, and removing any NON-lifecycle tree.

## 1. Stamp at creation

One branch per worktree, never detached. Create, then `git-manager` writes the stamp, then `backlog-operator: enrich` the item with the path, branch and base sha:

```text
git worktree add <repo>/.worktrees/<slug> -b <branch> <base>
git config branch.<branch>.description "run=<run id> ticket=<backlog uid> created=<ISO8601>"
```

Read it: `b=$(git -C <wt> symbolic-ref -q --short HEAD)`, then `git -C <wt> config branch.$b.description`. Detached (`b` empty) or no value = unstamped legacy tree (classify on evidence only). The stamp is repo config keyed by branch: never a file, never dirties a tree, survives `git branch -m`, removed by `git branch -d`.

## 2. Classify (read-only)

`W` = worktree path, `T` = target branch (`main`), `S=$(git -C W rev-parse HEAD)` (a sha, for named and detached trees alike). Run every row as `git -C W …` or on `S`, with `GIT_OPTIONAL_LOCKS=0`. **Every command must exit 0** (exceptions: e1 may exit 1; e4 has its own contract below). Any other non-zero, or empty output from a command that failed, is AMBIGUOUS — a failed read is never "clean" or "no evidence".

| # | Evidence | Command | Reads as |
|---|---|---|---|
| e0 | state | `git worktree list --porcelain`; `test -e "$(git -C W rev-parse --git-path X)"` for X = MERGE_HEAD, REBASE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, rebase-merge, rebase-apply | `prunable`, `locked`, or any X present = AMBIGUOUS |
| e1 | merged into T | `git -C W merge-base --is-ancestor S T` | exit 0 = every commit is in T |
| e2 | unmerged commits | `git -C W rev-list --count T..S`; same with `--merges` (m) | n > 0 = commits T lacks; m = merge commits among them |
| e3 | patch-equivalent | `git -C W cherry T S` | `-` = landed by rebase/cherry-pick; `+` = unlanded; empty = nothing comparable (merge commits only; cherry skips merges, evil merges included) |
| e4 | content landed | the three lines below the table | no path S changed is still different between T and S (covers squash). Run only when e1 = 1 and e3 is non-empty |
| e5 | dirty / ignored | `git -C W status --porcelain=v1 -z --untracked-files=all --ignored` | records `XY path\0` (a rename adds an `orig\0` record). `!!` = ignored; `DD AU UD UA DU AA UU` = unmerged = AMBIGUOUS; other records = dirty |
| e6 | what is dirty | `d=$(git -C W diff HEAD \| git patch-id --stable)`; `u=$({ git -C W ls-files -z --others --exclude-standard \| tr '\0' '\n'; git -C W ls-files -z --others --exclude-standard \| xargs -0 -r git -C W hash-object --; })`; if `[ -z "$d$u" ]` there is **no fingerprint** (the hash of empty input is a valid sha, so test the inputs); else `printf '%s\n%s\n' "$d" "$u" \| LC_ALL=C sort \| git hash-object --stdin` | equal fingerprints = one shared residue; no fingerprint = never grouped |
| e7 | last commit | `git -C W log -1 --format=%cs S` | last commit date |
| e8 | owner + ticket | stamp (§1), then `backlog-operator` reads `status` and last-update time of the stamped uid | live (non-terminal) vs terminal; no stamp = unowned |
| e9 | tree age | `mt "$(git -C W rev-parse --absolute-git-dir)/gitdir"` vs `date +%s` | seconds since `worktree add` (git writes that file once, at creation) |
| e10 | live process | `live W` | exit 0 = a process has its cwd in or under W; 2 = lsof failed = AMBIGUOUS |

Probes (portable; `W` is passed through the environment, so no regex escaping):

```text
mt(){ stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }   # GNU first: BSD stat -c fails, GNU stat -f means something else
live(){ o=$(lsof -a -d cwd -Fn); [ $? -le 1 ] || return 2; printf '%s\n' "$o" | W="$1" awk 'substr($0,1,1)=="n"{p=substr($0,2); if(p==ENVIRON["W"]||index(p,ENVIRON["W"] "/")==1)f=1} END{exit !f}'; }
```

e4: write the paths S changed since the merge base to temp file `L` and the paths where T and S differ to temp file `D` (no `-z`: git quotes odd names, one per line), then compare:

```text
git -C W diff --name-only --no-renames "$(git -C W merge-base T S)" S > L;  git -C W diff --name-only --no-renames T S > D
test -s L          # false = S changed nothing of its own: e4 not run
LC_ALL=C sort L -o L; LC_ALL=C sort D -o D; test -z "$(LC_ALL=C comm -12 L D)"   # exit 0 = landed; 1 = inconclusive (T may have moved on)
```

Both `git diff` lines must exit 0; any other failure is AMBIGUOUS.

**Decision list — the first match wins, so each tree has exactly one class:**

| # | class | when |
|---|---|---|
| 0 | EXCLUDED | the primary worktree; a tree whose branch is `T` or the plan branch; a tree with a non-terminal stamp (e8) whose ticket was updated or whose e7 is within 14 days, including this run's own until Step 7 teardown (report it as LIVE) |
| 1 | AMBIGUOUS | any §4 condition, including a non-terminal stamp silent for 14 days and an unstamped tree that is younger than 24 hours (e9) or has a live process (e10); go to §4 |
| 2 | MERGED | e1 = 0 |
| 3 | LANDED | e3 non-empty and ((no `+` and m = 0) or e4 = 0) |
| 4 | UNMERGED | e3 has any `+` |
| 5 | DIVERGED | anything left (e3 empty with e2 > 0: merge commits only, or no comparable patch) |

Tree state: DIRTY when e5 has any record that is not `!!`, otherwise CLEAN. Last-commit age (e7) never changes the class; it only schedules the sweep (§5). The 24-hour grace (e9) exists for the window before a stamp lands and for other agents' unstamped trees: a brand-new tree has no commits of its own, so e1 = 0 reads MERGED and only age and liveness protect it.

## 3. Disposition — exactly one action per class

| class | action |
|---|---|
| MERGED + CLEAN | `git worktree remove <W>`; then, if `<B>` is named, from `T`'s checkout `git branch -d <B>` (git checks `-d` against the cwd checkout's HEAD, not `T`; a refusal is AMBIGUOUS, never `-D`) |
| LANDED + CLEAN | `git worktree remove <W>`; keep `<B>` (git cannot prove it merged) and list it in the ticket for the retention sweep |
| UNMERGED + CLEAN | keep `<B>`; `backlog-operator` files or enriches a ticket citing branch, head sha and the `+` lines of e3; route it through `dispatch-direct` (rebase on the plan branch, or on `T` when that is gone; ff-only merge); `git worktree remove <W>` only once the ticket records the sha |
| DIVERGED + CLEAN | ask (§4) |
| any + DIRTY | **rescue** (below), then re-classify |

- **Detached with e2 > 0** (any class): directory removal would orphan the commits. Before anything else, `git -C W switch -c rescue/<slug>`; the tree is then a named-branch tree and re-enters the list at row 2.
- **Rescue** (`git-manager`), `<slug>` = the directory name, `rescue/<slug>` + a short sha if that branch exists: record `orig=$(git -C W symbolic-ref -q --short HEAD || git -C W rev-parse HEAD)`; `switch -c rescue/<slug>`; `add -- <paths>` and `commit -m "chore: rescue <slug>" -- <paths>` (paths from e5, both names of a rename). The commit runs hooks; the pre-commit guard can run `nx build host-registry` and rewrite a live `dist` — never `--no-verify`. On rejection restore the tree as found: `switch <orig>` (`switch --detach <orig>` when it is a sha; changes carry), `restore --staged -- <paths>`, `branch -d rescue/<slug>` (the empty branch), then ask. Never on `B`'s history; never `stash`.
- **Unstamped DIRTY trees: probe for a live owner first.** Active = e10 exit 0 or a dirty path with `mt` within 30 minutes. Active → ask, no rescue. (Clean unstamped trees are guarded by row 1 the same way.)
- **Ignored files die with the directory** (`git worktree remove` succeeds on a tree holding only ignored files). Regenerable = under `node_modules`, `dist*`, `.nx`, `.turbo`, `coverage`, `.cache`, `.next`, `.gitnexus`, or `*.tsbuildinfo`; any other `!!` path (`.env*`, notes, local config) is AMBIGUOUS.

## 4. Ambiguity — ask, with the evidence

Ask the user (one batched question, not one per tree) when: class is DIVERGED; the rescue commit is rejected; the worktree is prunable, locked, a submodule, or unreadable; its branch is missing (`rev-parse HEAD` fails; `status` alone exits 0 and lies); any evidence command exits non-zero (e1 other than 0/1); a merge, rebase, cherry-pick or revert is in progress, or an unmerged entry exists; non-regenerable ignored files exist; `git worktree remove` or `branch -d` refuses a CLEAN/MERGED tree; a stamp names a run you cannot tell is finished; a non-terminal stamp whose ticket (last update, e8) and last commit (e7) are both older than 14 days — a crashed run; an unstamped tree younger than 24 hours or with a live process (clean or dirty), or a DIRTY one with a path modified in the last 30 minutes; or more than 10 DIRTY trees share one non-empty e6 fingerprint (ask once about the group). The question carries, per tree: path, branch, class, e0–e8 values, and your proposed disposition. Until answered the tree is left exactly as found.

## 5. Retention — nothing accumulates, nothing valuable is lost

- **Sweep at every run start and every Step 7**: classify all worktrees in the target repo (read-only), dispose every non-ambiguous one per §3, queue the rest into one §4 question. A tree whose ticket is terminal, or that has no stamp and a last commit older than 14 days, is due at the next sweep; a silent non-terminal stamp is never disposed, only asked (§4).
- **Directories are disposable, commits are not**: a worktree directory is removed only when its content is on a named ref (merged into `T`, landed, or a branch recorded in a ticket). Branches holding commits `T` lacks are never deleted by the dispatcher.
- **Kept branches expire only by the user**: `<B>` and `rescue/*` branches stay listed in their ticket; once the ticket is resolved and the branch is MERGED or LANDED, the next sweep puts the deletion (`git branch -d`, or the user's `-D` for LANDED — offered only after a fresh e3/e4 re-check) in its §4 batch.
- **Report the sweep**: counts per class and the ask-queue, in the run's close-out.

## Hard rules

- Never `git stash`, `git reset --hard`, `git clean`, `git checkout -- <path>`, or `git worktree remove --force` — a refusal from `git worktree remove` means the tree is not removable: go to §4, never around it.
- Classification is read-only; mutate only after a class is recorded in the run's notes.
- Never judge value by age, size, or branch name; the evidence rows decide.
- Stage explicit paths only (`git add -A` and `git commit -a` are banned).
