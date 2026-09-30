# opencode-permission-audit

> Find why an opencode agent is prompted for permission, fix its `permission.bash` map, prove the fix.

## Overview

Mines the opencode log and session DB for every permission ask an agent raised — the exact command
segments, working directory, session, and inferred answer — plus wasted-time deltas, a deny catalog,
an auto-reject catalog, and every permission-family DB error shape. Section 7 reads the agent's
installed bash map, tells you whether its catch-all is a defect, and emits a drop-in corrected
`permission.bash` block. `SKILL.md` also carries the opencode inspection cheatsheet and the rules of
permission resolution.

## When to use

An agent prompts on every command; a dispatched subagent's command fails with a permission error;
you need to audit or repair an agent's `permission.bash`.

## Dependencies

None.

## Runtime

Declarative — ships `scripts/opencode-permission-scan.py` (Python 3, stdlib only; uses `sqlite3` and
`rg` at runtime).

## Source

Authored in sox-ecosystem from the opencode permission-mining investigation (opencode 1.18.32).

## Usage

```sh
soxe install opencode-permission-audit --host claude --scope user
soxe install opencode-permission-audit --host opencode --scope user
python3 ~/.config/opencode/skills/opencode-permission-audit/scripts/opencode-permission-scan.py \
  --agent git-manager --out /tmp/git-manager-perms.txt
```

## License

MIT
