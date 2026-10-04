# Changelog

## 0.1.3

- **All three install surfaces declared — claude, opencode, agent-mcp.** `install.hosts` gains `agent-mcp` and `render.agent-mcp` federates the uniform server set (agent, search, memory-server, gitnexus, backlog) into the catalog row, so a task dispatched through agent-mcp has the same tool surface as a native opencode run. `render.opencode` pins its model and `mode: all`.

## 0.1.2

- **Guardrails restated after the `"*": "allow"` catch-all — probe-proven shadowing.** The agent map merges AFTER the global `opencode.json` rules and wins on last-match-wins, so any global guardrail the map does not restate is overridden. A probe agent whose bash map was a bare `{"*": "allow"}` ran `rm -rf /tmp/...` to completion, while the same command under the config alone was auto-rejected. The tail now restates, appended AFTER the catch-all so each still wins: `git stash*` / `git add -A*` / `git add .` / `git add --all*` / `git reset --hard*` / `git clean *-f*` deny, `git push *--no-verify*` / `git checkout -- *` / `rm -rf *` ask, `*dot/secrets*` deny.

## 0.1.1

- refactor: cross-platform IR — move agent config to extension.json agent/render blocks, strip
  the legacy `tools:` frontmatter from the .md
- Replace the unfilled scaffold: real operating contract (run the project's own test entry
  point, quote the tree state beside every result, never edit source or tests), ADR-catalog-first
  rule, and least-privilege grants (`edit: deny`, `write: deny`)
- Fix the deployed artifact in `.opencode/agents/` that carried the legacy `tools:` field and
  made opencode reject the whole project config

## 0.1.0

- Initial release
