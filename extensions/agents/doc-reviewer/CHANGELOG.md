# Changelog

## 0.1.3

- **Fix:** restore the `steps: 40` step/turn budget that 0.1.2's IR conversion silently dropped. The IR (`AgentIr`/`AgentOverride` in `libs/host-registry/src/internal.ts`) now carries a `steps` field, host-mapped at render time: opencode emits `steps:` verbatim, claude emits its own `maxTurns:` field (its harness-enforced turn cap), codex omits it (no known equivalent). `agent.steps: 40` is restored in `extension.json`.
- **Fix:** the `package.json` description was the literal string `">-"`, a YAML folded-scalar leader left over from a raw frontmatter copy instead of the resolved text.

## 0.1.2

- Convert to cross-platform agent IR format: move frontmatter to `extension.json` `agent` block, add per-host `render` overrides, strip frontmatter from `.md` prose.
- NOTE: `steps: 40` field in prior frontmatter has no IR slot and is not preserved — doc-reviewer does not reference this field at runtime. **Corrected in 0.1.3.**

## 0.1.1

- Pin the opencode model to the live provider id `deepseek/deepseek-flash` (the retired V4
  Flash id no longer resolves on the `deepseek` provider, so the pinned agent failed at dispatch
  time with "Model not found").

## 0.1.0

- Initial release.
- Migrated the `doc-reviewer` agent definition from `/Users/nix/.config/opencode/agents/doc-reviewer.md` into a born-conformant
  declarative agent extension.
