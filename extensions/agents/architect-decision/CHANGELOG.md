# Changelog

## 0.1.1

- **All three install surfaces declared — claude, opencode, agent-mcp.** `install.hosts` gains `agent-mcp` and `render.agent-mcp` federates the uniform server set (agent, search, memory-server, gitnexus, backlog) into the catalog row, so a task dispatched through agent-mcp has the same tool surface as a native opencode run. `render.opencode` pins its model and `mode: all`.

## 0.1.0

- Initial release.
- Migrated the `architect-decision` agent definition into a born-conformant declarative agent
  extension; the prose body (source lines 28-161) is preserved verbatim.
- Fixed the model: `render.opencode.model` pins `deepseek/deepseek-flash`. The hand-placed
  pre-migration file pinned the pro tier (~3x the flash output rate) and named that model in its
  description; both are gone.
- Restricted `install.hosts` to `opencode`: the agent's read-only bash allowlist and
  `task`/`question`/`todowrite` denies are expressible only in opencode's permission map, so no
  faithful claude render exists.
