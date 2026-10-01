# agent-safety-audit

> Audit agent safety: find why an opencode agent is prompted for permission and fix its `permission.bash` map, and scan Claude Code / opencode transcripts for destructive or escape-the-project patterns.

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

Declarative — ships two Python 3 scanners (stdlib only; use `sqlite3` and `rg` at runtime):
`scripts/opencode-permission-scan.py` (permission audit) and `scripts/agent-transcript-scan.py`
(destructive/escape scan over Claude Code `.jsonl` and opencode's SQLite store).

## Source

Authored in sox-ecosystem from the opencode permission-mining investigation (opencode 1.18.32).

## Usage

```sh
soxe install agent-safety-audit --host claude --scope user
soxe install agent-safety-audit --host opencode --scope user

# permission audit
python3 ~/.config/opencode/skills/agent-safety-audit/scripts/opencode-permission-scan.py \
  --agent git-manager --out /tmp/git-manager-perms.txt

# transcript scan (Claude Code .jsonl and/or opencode's SQLite store)
python3 ~/.config/opencode/skills/agent-safety-audit/scripts/agent-transcript-scan.py \
  --project "$PWD" --opencode-db --since 2026-10-01T06:00 --until 07:00
```

## License

MIT
