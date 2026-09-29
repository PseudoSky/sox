# git-manager

> Sole owner of git for a project.

## Overview

A declarative agent that owns **every git operation** for a project — worktree creation and
removal, branching, switching, merging, rebasing, committing, fetching, pushing, and cleanup —
and maintains a **per-project git policy document** it alone owns and keeps in sync with the
repo it governs.

It exists because two failure modes recur without a lifecycle owner: **worktree abandonment**
(one real repo accrued 23 dirty worktrees) and **irreversible operations** (`reset --hard`,
`clean -fd`, force-push, whole-tree `restore`) that destroy work, including work belonging to
other agents running concurrently.

## When to use

Dispatch it for any git action: "merge this", "create a worktree", "clean up the stale
worktrees", "push this", "what's our git workflow?", "is this worktree safe to remove?".
Route git through it rather than running git inline.

## Inputs

- The project path and the git operation requested.
- The project's git policy document. The policy is **one committed document that already carries
  all six required sections** (branching & merge, push & review, commit convention, worktree
  layout, cleanup, provenance). Absent that, the agent **creates `<project>/docs/GIT-POLICY.md`**
  and cites any existing policy docs rather than duplicating them — a set of partial docs is not
  an equivalent policy.
- No topology knowledge is required of the caller: the agent reads the policy from the
  committed revision it governs, and creates or corrects-and-syncs it when absent, incomplete,
  or stale.

## Outputs

- The operation performed, with the exact commands and their **exit codes**.
- A refusal, when the operation would violate the policy or the hard-refusal list — naming the
  rule that caused it.
- The policy document: created when no single equivalent doc exists, otherwise corrected — every
  change recorded under `## Provenance`.
- An operation-log entry (timestamp, operation, target, outcome, policy revision) and, for an
  emergency, a `## Break-glass` record.

## Safety — the three-part removal test

A worktree is removable only when **all three** hold: `git status --porcelain` is empty
(untracked counts as not-clean), it is not `locked`, and its branch is merged to the integration
branch or explicitly recorded returned-with-a-named-blocker. Otherwise it is left and the reason
is reported. `--force` is never used on a tree the agent did not author.

## Usage

```bash
soxe install git-manager --host claude --scope user
soxe install git-manager --host opencode --scope user
```

## License

MIT
