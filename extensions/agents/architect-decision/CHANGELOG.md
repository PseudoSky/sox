# Changelog

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
