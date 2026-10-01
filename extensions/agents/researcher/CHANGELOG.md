# Changelog

## 0.1.5

- **Guardrails restated after the `"*": "allow"` catch-all — probe-proven shadowing.** The agent map merges AFTER the global `opencode.json` rules and wins on last-match-wins, so any global guardrail the map does not restate is overridden. A probe agent whose bash map was a bare `{"*": "allow"}` ran `rm -rf /tmp/...` to completion, while the same command under the config alone was auto-rejected. The tail now restates, appended AFTER the catch-all so each still wins: `git stash*` / `git add -A*` / `git add .` / `git add --all*` / `git reset --hard*` / `git clean *-f*` deny, `git push *--no-verify*` / `git checkout -- *` / `rm -rf *` ask, `*dot/secrets*` deny.

## 0.1.4

- **Fix: `git add .*` denied the `git add <path>` form that `AGENTS.md` mandates.** As a glob the
  pattern matches any dot-prefixed path, so `git add .changeset/…`, `git add .gitignore`,
  `git add .mcp.json` and `git add .githooks/…` were denied — **9 such denials** measured in the
  opencode transcript store (`~/.local/share/opencode/log/opencode.log`), every one of them the
  sanctioned pathspec form. Replaced with the exact-match `git add .`, which blocks only the
  stage-everything form; any pathspec — including a dot-prefixed one — now passes.

## 0.1.3

- **Memory MCP is a gate, not a capability to substitute.** `BLOCKED` when the tools are
  absent or `memory_ping()` errors — no disk fallback, no hand-rolled client or protocol
  shim, no spawned server, no `curl`/DB/`memory` CLI, no HTTP call to its endpoint. The
  `docs/research/fallback/` path is deleted: it produced findings no recall could reach
  while the report implied they were filed.
- Deleted the blanket "absent MCP → use the non-MCP equivalent" rule that induced an agent
  to rebuild the memory server's plumbing. Search keeps its sanctioned non-MCP paths.
- Search is **the `scratch-agent-search` CLI first**, with the search MCP as the fallback —
  verified live that the CLI returns the same `outcome`/`attempts`/`results[]` JSON the
  protocol keys on, so this is a surface change, not a protocol change. `WebSearch` is gone
  entirely: removed from the declared tools and the Claude render, `permission.websearch`
  is `deny`, and the three clauses that prescribed it now name the CLI. Also removed the
  stale `scratch-agent-search-mcp-cli` bin reference (not on PATH).
- Fixed `render.claude.version` drift (`v1.0.1` against `version: 0.1.2`).
- `agent.md` 913 → 913 lines (net 0). Tested by two fresh-subagent runs: the gate holds
  (blocks without improvising); the first pass surfaced the status-token conflict, the
  non-exhaustive route ban, and the trace-vs-findings clash, all fixed here.

## 0.1.2

- Pin the opencode model to the live provider id `deepseek/deepseek-flash` (the retired V4
  Flash id no longer resolves on the `deepseek` provider, so the pinned agent failed at dispatch
  time with "Model not found").

## 0.1.1

- Fixed entrypoint to `researcher.md` (BL-566 shape): the extension previously declared
  `agent.md`, which would install as `researcher.md` on opencode (ext-id filename) — a
  name mismatch with the declared entrypoint. The definition is unchanged.
- The live opencode `researcher.md` was a divergent legacy hand-placed file (Jul-16, 54KB);
  this release installs the current 56KB definition from the extension.

## 0.1.0

- Initial release
- Ported the `researcher` agent definition from `~/dev/ai/claude-agents/categories/10-research-analysis/researcher.md` (v1.0.1) into a born-conformant declarative agent extension.
- Multi-host: `install.hosts` = `claude`, `codex`, `opencode`.
- Tool naming made generic: MCP callables (search/memory/backlog) are resolved from the live tool list at runtime, not hardcoded to any host-specific prefix.
