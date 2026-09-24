# Changelog

## 0.1.3

- **Fix:** `render.claude.model` was `opus`, contradicting both the IR's `agent.model: "haiku"` and the agent's original opencode frontmatter (`model: deepseek/deepseek-flash`, never edited to intend a Claude-specific tier — `git log -p` on this agent shows no commit that ever set or discussed a Claude model). `performance` is a haiku-tier deepseek-flash agent, matching the `agent-manager` / `backlog-operator` / `doc-cartographer` / `doc-consumer` / `doc-reviewer` pairing (`agent.model: "haiku"` ↔ `render.claude.model: "haiku"` ↔ `render.opencode.model: "deepseek/deepseek-flash"`). Set `render.claude.model` to `haiku` to match.

## 0.1.2

- refactor: cross-platform IR — move agent config to extension.json agent/render blocks, strip frontmatter from .md

## 0.1.1

- Pin the opencode model to the live provider id `deepseek/deepseek-flash` (the retired V4
  Flash id no longer resolves on the `deepseek` provider, so the pinned agent failed at dispatch
  time with "Model not found").

## 0.1.0

- Initial release.
- Migrated the `performance` agent definition from `/Users/nix/.config/opencode/agents/performance.md` into a born-conformant
  declarative agent extension.
