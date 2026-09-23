# Changelog

## 0.1.1

- Pin the opencode model to the live provider id `deepseek/deepseek-flash` (the retired V4
  Flash id no longer resolves on the `deepseek` provider, so the pinned agent failed at dispatch
  time with "Model not found").

## 0.1.0

- Initial release.
- Migrated the opencode-host `dispatcher` agent definition from
  `~/.config/opencode/agents/dispatcher.md` (adapted from
  `~/dev/ai/claude-agents/categories/workflow/agents/plan-orchestrator.md` v1.4.0) into a
  born-conformant declarative agent extension.
- Multi-host: `install.hosts` = `claude`, `opencode`.
