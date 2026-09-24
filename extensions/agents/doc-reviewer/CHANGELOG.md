# Changelog

## 0.1.2

- Convert to cross-platform agent IR format: move frontmatter to `extension.json` `agent` block, add per-host `render` overrides, strip frontmatter from `.md` prose.

## 0.1.1

- Pin the opencode model to the live provider id `deepseek/deepseek-flash` (the retired V4
  Flash id no longer resolves on the `deepseek` provider, so the pinned agent failed at dispatch
  time with "Model not found").

## 0.1.0

- Initial release.
- Migrated the `doc-reviewer` agent definition from `/Users/nix/.config/opencode/agents/doc-reviewer.md` into a born-conformant
  declarative agent extension.
