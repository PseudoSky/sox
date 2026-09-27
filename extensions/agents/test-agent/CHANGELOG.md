# Changelog

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
