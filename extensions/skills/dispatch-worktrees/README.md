# dispatch-worktrees

> The dispatcher's worktree disposition playbook.

## Overview

Stamps each worktree with its owner (run id + backlog uid) at creation, classifies any worktree
read-only through an ordered decision list (excluded / ambiguous / merged / landed / unmerged /
diverged × clean / dirty), maps each class to exactly one allowed action (git writes run through
`git-manager`), and sweeps at run start and close so worktrees neither accumulate nor lose work.

## When to use

At worktree creation, at run start (sweep), at Step 7 teardown, or when a worktree holds
unmerged or dirty work.

## Runtime

`declarative` — the host reads `SKILL.md` directly. No transform.

## Usage

```bash
soxe install dispatch-worktrees --host claude --scope user
soxe install dispatch-worktrees --host opencode --scope user
```

## License

MIT
