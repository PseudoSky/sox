# Changelog

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
