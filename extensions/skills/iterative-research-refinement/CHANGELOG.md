# Changelog

## 0.1.0

- Initial release. Ports the `iterative-research-refinement` skill (v9) into a
  born-conformant `skill`-type extension: declarative runtime, `SKILL.md` entrypoint,
  reference docs (`research-execution-checklist.md`, `research-question-generalization.md`,
  `library-selection-v3.md`, `injecting-a-research-process.md`), and the mandatory
  runtime-telemetry companion script `scripts/runtime-metrics.mjs`.
- SKILL.md body preserved byte-for-byte from upstream v9. Frontmatter additions only:
  `source` / `source-version` fields, and the description's stale-copy warning replaced
  with a canonical-source pointer — the registry extension is now the single source of
  truth; installed copies on claude + opencode are synced from it.
- Installs to claude (`~/.claude/skills/`) and opencode (`~/.config/opencode/skills/`).
