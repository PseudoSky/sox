# Changelog

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
