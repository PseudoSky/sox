# GIT-POLICY.md — how sox-ecosystem uses git

> **Established 2026-09-29; not yet adopted.** This is the single git policy document for this
> repository, created under the `git-manager` contract
> ([`extensions/agents/git-manager/git-manager.md`](../extensions/agents/git-manager/git-manager.md))
> because no one committed document contained every required section — the rules lived split
> across [`AGENTS.md`](../AGENTS.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md).
>
> **`AGENTS.md` and `CONTRIBUTING.md` remain the operative sources until they are amended to
> point here.** Nothing in this file supersedes a rule in those documents; where a rule already
> lives there, this file cites it (`path §section`) rather than restating it. Adopting this
> document means adding a one-line pointer from each of those files, not moving text out of them.

Schema version: **1** (see [§6 Provenance](#6-provenance)).

The integration branch is **`main`**; the repository is trunk-based (one long-lived branch, short
feature branches merged into it). All line references below are to the revision of each source at
which this policy was written.

---

## 1. Branching & merge

- **Integration branch.** `main`. CI runs on every push and pull request targeting `main`
  ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml) `on: push/pull_request`).
- **Where a change forks from.** From the current tip of `main`, in a dedicated worktree (§4).
  Stacked work may fork from another feature branch; long-running branches merge `main` **into**
  themselves to stay current (`git log` shows `Merge branch 'main' into feat/…`) rather than
  integrating silently.
- **Branch naming.** Convention, **not a gate** — no hook or CI check enforces it:
  `<type>/<slug>` using the change type (`feat/`, `fix/`, `docs/`, `chore/`, `refactor/`, `test/`,
  `perf/`, `proof/`), or a ticket-scoped form `<ticket-id>/t<n>` (e.g. `bug017/t1`, `debt003/t2`).
  This is the pattern observed in refs; treat it as guidance, and do not assume a malformed branch
  name will be rejected — it will not be.
- **Merge strategy.** Integration is a **merge commit** preserving branch history — not squash,
  not fast-forward-only. Existing merges appear as either `chore: merge <branch> (…)` or
  `Merge branch '<branch>' into <target>`.
- **Rebase in flight.** Permitted **only** on a branch that is solely yours and **not yet
  pushed**. Rebasing a pushed or shared branch is refused (§5 hard refusals); bring `main` in by
  merge instead.

## 2. Push & review

- **`main` is shared and is pushed** to `origin` (`git@github.com:PseudoSky/sox.git`). It may only
  be advanced by a merge of an integrated branch, never by force.
- **Author ≠ merger.** The implementer of a change does not approve it. `git-manager` *performs*
  merges; the approval decision must come from outside it — a reviewer, CI, or the human. A request
  to approve and merge the same change is refused on the approval half. (Separation-of-duties rule,
  [`git-manager.md`](../extensions/agents/git-manager/git-manager.md) §"Separation of duties".)
- **Required checks before a merge is performed.** These are the repo's own pre-merge gates:
  - `npx nx run-many -t build,lint,test,typecheck` green for every affected project — build does
    **not** imply typecheck ([`AGENTS.md`](../AGENTS.md) §"BUILD VIA NX TARGETS").
  - `node scripts/smoke-test.mjs` → `summary.failed === 0` for any change touching extension
    manifests, the install engine, service-lifecycle code, host-runtime, CLI `cmdServe`/`cmdService`,
    or any `libs/data/` package consumed by bundles ([`AGENTS.md`](../AGENTS.md) §"RUN SMOKE TEST").
  - Any branch that adds or changes a `workspace:*` edge has run `pnpm install` and committed the
    `pnpm-lock.yaml` diff ([`AGENTS.md`](../AGENTS.md) §"RELOCK BEFORE MERGE", line 199).
  - CI (build, lint, typecheck, test, tier-1/tier-2 guards, strict manifest validation, registry
    checksum verification) passes for the same revision.
- **Force-push scope.** Force-push is **prohibited on `main`** and on any branch that is not solely
  yours. `--force-with-lease` (never a bare `--force`) is permitted only on a branch solely your
  own. There is no exception for "just this once".
- **Merge queue.** None. There is no repository merge queue; merges **serialize through the
  single-writer rule** — all git operations for this project route through `git-manager`, so two
  merges cannot interleave.

## 3. Commit convention

- **Format.** Conventional Commits, configured in [`commitlint.config.js`](../commitlint.config.js):
  it extends `@commitlint/config-conventional` and adds a project `scope-enum`. Scope is
  **advisory (severity `warn`)**, not blocking; the header comment in that file defines the three
  scope kinds (package name, cross-cutting concern, agent name).
- **Enforcement surface — and its gap.** The rule is enforced by
  [`.husky/commit-msg`](../.husky/commit-msg) (`npx --no -- commitlint --edit "$1"`). Hooks are
  **untracked by git**; install them once per clone/worktree with `node tools/install-git-hooks.mjs`
  ([`AGENTS.md`](../AGENTS.md) line 125, [`tools/install-git-hooks.mjs`](../tools/install-git-hooks.mjs)).
  **CI does not run commitlint** (verified 2026-09-29) — the local hook is the only gate, so an
  un-installed hook silently disables the check. This is a known gap, recorded here rather than
  papered over.
- **Commit by pathspec, never by staging.** `git add -A`, `git add .`, `git add --all`, and a bare
  `git commit` after `git add` are **forbidden** — the index is shared across concurrent agents and
  a bare commit sweeps in their staged work. Commit only explicit paths
  ([`AGENTS.md`](../AGENTS.md) §"COMMIT BY PATHSPEC", line 94; [`CONTRIBUTING.md`](../CONTRIBUTING.md)
  §1.6, line 138).
- **Contended hot files.** When two agents edit different sections of one file, `git commit <path>`
  cannot separate them — use `node tools/commit-mine.mjs` (dry-run first)
  ([`AGENTS.md`](../AGENTS.md) line 102).
- **No `git stash`.** Never `git stash` / `pop` / `drop` / `clear` — commit to a branch instead
  ([`AGENTS.md`](../AGENTS.md) line 154).
- **No pathspec-less `--amend`.** `git commit --amend` commits the **shared index**; name the files
  (`git commit --amend path …`) or use `node tools/commit-mine.mjs --amend-message`
  ([`AGENTS.md`](../AGENTS.md) §"--amend is not a message-only operation", BL-457).
- **Never committed.** `.nx/`, `.DS_Store`, `dist/`, `*.js`/`*.d.ts` inside `src/`, and any secret,
  token, or API key ([`CONTRIBUTING.md`](../CONTRIBUTING.md) §1.6, line 158).
- **Orphaned index entries.** A stopped agent leaves staged entries that outlive it; clear only
  byte-identical ones with `node tools/unstage-orphans.mjs` ([`AGENTS.md`](../AGENTS.md) line 146).
- **Registry.** `registry/index.json` is a release artifact; a source-only change must leave it
  unchanged (`git diff --exit-code registry/index.json`) ([`AGENTS.md`](../AGENTS.md) §"registry is
  release-only").

## 4. Worktree layout

- **Root.** `<project>/.worktrees/` — the house rule is that a branch gets its own worktree under
  that directory, and it is gitignored (`.gitignore` lines 67–68). Host-managed agent worktrees
  under `.claude/worktrees/` also exist; they are created by the agent host and are **not** covered
  by this layout.
- **One worktree per branch.** Never check out a different branch in the repository root — create a
  worktree instead:

  ```
  git worktree add <project>/.worktrees/<name> -b <branch>
  ```

- **Provisioning after creation.**
  - `node tools/install-git-hooks.mjs` — hooks live in the **common** gitdir and are shared by
    every worktree, so this is once per clone; re-run it after editing any `.husky/*` file.
  - `pnpm install` when the branch adds or changes a `workspace:*` edge or the lockfile
    ([`AGENTS.md`](../AGENTS.md) line 199).
- **Reap TTL — 7 days.** A worktree is *eligible for reaping* when its branch is merged into `main`,
  its tree is clean, **and** its branch tip commit is older than 7 days. Checkable as the branch tip's
  committer time (`git log -1 --format=%ct <branch>`) versus `date +%s`. **The TTL only makes a
  worktree a candidate for review** — it never authorises removal; §5 gates every removal. Reap one
  at a time, never in a batch.

## 5. Cleanup

### Safe to remove — all three, never any one

```
1. `git status --porcelain` in the worktree is EMPTY
   (untracked files count as NOT clean)
2. the worktree is NOT `locked` in `git worktree list --porcelain`
3. its branch is merged to the integration branch
   (`git merge-base --is-ancestor <head> main` exits 0)
   OR the worktree is explicitly recorded as returned-with-a-named-blocker
```

If all three hold → `git worktree remove`, and **never `--force` on a tree you did not author**.
If any fails → **leave it and report why**. Prefer reap-and-report over silent auto-reap. Before
abandoning any worktree, require its work to be **committed and pushed** — recovery must not depend
on a local, expiring reflog.

### Recovery runbook — and its limit

| Situation | Command |
|-----------|---------|
| Worktree moved | `git worktree repair <path>` |
| Worktree dir deleted, branch intact | `git worktree prune` |
| Lost commits | `git reflog`, then `git fsck --unreachable` |

**The limit.** The reflog is **local and time-bounded** — GC expires it. Git history is durable;
the reflog is best-effort. Never promise a recovery the reflog cannot back, and never substitute a
degraded recovery for one you could not perform without saying so.

### Hard refusals

Refuse, name the rule, and stop:

- `git reset --hard`, `git clean -fd`, or a whole-tree `git restore` — ever.
- `--force` on a worktree containing work you did not author.
- Removing a worktree or deleting a branch whose head is neither merged nor recorded returned.
- Force-pushing `main` or any branch not solely yours (see §2).
- `git stash` in any form (§3).
- Acting on a policy that cannot be read — fail closed, then correct-and-sync.

## 6. Provenance

Schema version **1**. Each edit appends one dated entry; entries are never rewritten.

- **2026-09-29 — created** (`git-manager`, run `dispatch-2026-09-29-8f99`, on explicit owner
  authority granted 2026-09-29). *Reason:* no single committed document contained all six required
  sections — the single-file content-equivalence test failed, with git rules split across
  [`AGENTS.md`](../AGENTS.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md). Those two documents are
  cited, not duplicated, and remain operative until amended to point here. In the same run
  [`commitlint.config.js`](../commitlint.config.js) `scope-enum` was corrected: `git-manager`,
  `architect`, `dispatcher`, and `doc-steward` added (evidence: agent-name scopes actually used in
  `git log` subjects that were warning under the enum).
- **Operation log.** This repository has **no dedicated operation-log file**; the tool contract
  requires one entry per git operation (timestamp, operation, target, outcome, policy revision).
  Until a location is chosen by the owner, the record for a `git-manager` operation lives in this
  section and in the operation's own report. (`extensions/agents/git-manager/README.md` specifies
  the entry's *contents* but not a path.)
