# Changelog

## 0.1.5

- **Fix: `git add .*` denied the `git add <path>` form that `AGENTS.md` mandates.** As a glob the
  pattern matches any dot-prefixed path, so `git add .changeset/…`, `git add .gitignore`,
  `git add .mcp.json` and `git add .githooks/…` were denied — **9 such denials** measured in the
  opencode transcript store (`~/.local/share/opencode/log/opencode.log`), every one of them the
  sanctioned pathspec form. Replaced with the exact-match `git add .`, which blocks only the
  stage-everything form; any pathspec — including a dot-prefixed one — now passes.

## 0.1.4

- **Fixed a mis-mapped capability: `gitnexus` resolved to the `agent-mcp` server.** The IR
  declared `{"logical":"gitnexus","server":"agent-mcp"}`, so the rendered header granted
  `mcp__agent-mcp__*` (orchestration tools) under a gitnexus label, and the appendix printed
  `gitnexus → tools["agent-mcp"].*`. Now `gitnexus → gitnexus`, matching `typescript` and
  `product`, which had it right. Also realigned `render.claude.version` (was `v0.1.2`
  against `version: 0.1.3`).
- **Not installed — deliberately.** The live copy is a revision behind, and re-installing
  would also apply the pending bash-permission block, the description reword and the
  ADR-catalog paragraph. Deployment is left to the owner's decision rather than folded in
  with this fix.

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
