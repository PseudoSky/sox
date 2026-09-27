# Changelog

## 0.2.0

- Adds `scripts/runtime-attribution.mjs`, a companion to `runtime-metrics.mjs` that answers
  *where* the runtime went rather than *whether* it regressed: it decomposes each session's
  wall-clock into tool-busy (union of tool intervals, so parallel calls aren't double-counted)
  vs model-wait, breaks it down per tool, and reports seconds-per-extra-call plus the ordered
  call sequence (`--calls`).
- SKILL.md §Runtime Metrics gains a short pointer to it with a standing rule: never narrate a
  runtime mechanism without measuring the split. Origin: 2026-09-25, a variant at 1.29x
  wall-clock was explained as "more steps"; attribution showed tool-busy flat (±0.5s) and
  94–98% of the delta in model-wait (inference round-trips, not tool execution).
- No change to `runtime-metrics.mjs` — the method and thresholds are unchanged.

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
