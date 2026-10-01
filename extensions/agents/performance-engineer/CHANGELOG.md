# Changelog

## 0.1.2

- **Guardrails restated after the `"*": "allow"` catch-all — probe-proven shadowing.** The agent map merges AFTER the global `opencode.json` rules and wins on last-match-wins, so any global guardrail the map does not restate is overridden. A probe agent whose bash map was a bare `{"*": "allow"}` ran `rm -rf /tmp/...` to completion, while the same command under the config alone was auto-rejected. The tail now restates, appended AFTER the catch-all so each still wins: `git stash*` / `git add -A*` / `git add .` / `git add --all*` / `git reset --hard*` / `git clean *-f*` deny, `git push *--no-verify*` / `git checkout -- *` / `rm -rf *` ask, `*dot/secrets*` deny.

## 0.1.1

- refactor: cross-platform IR — move agent config to extension.json agent/render blocks, strip frontmatter from .md
- Add opencode render pin to `deepseek/deepseek-flash`

## 0.1.0

- Initial release.
- Migrated the `performance-engineer` agent definition from `/Users/nix/.claude/agents/performance-engineer.md` into a born-conformant
  declarative agent extension.
