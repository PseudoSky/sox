# Changelog

## 0.1.0

- Initial release (2f81569f T11). Read-only `review` agent with static and blind modes
  (blind-deep at Deep rigor: diff, specification, tests; never the implementer's reasoning, D22).
- Tools: read, glob, grep only; `edit`/`write`/`bash` denied (renders `disallowedTools` on claude).
- Declares `capabilities: roles-covered:SR.1..SR.4` (D23), the Static reviewer obligations in workspace-standards `roles.md`.
- Blind templates in `templates/` carry only `{{diff}}` (plus `{{specification}}`/`{{tests}}` for blind-deep).

### Evidence (0.1.0)

- Golden-set A/B (haiku, 10 cases x 3 reps, code-based grader): baseline one-liner prompt 0/30; `review.md` 25/30 (static 14/15, blind 11/15). Format and refusal conformance, not bug detection: both arms located the planted defect 6/6. Weak spot: blind refusal of wrong-instruction and rationale briefs (B2 1/3, B3 1/3 at haiku). Recorded in `eval/results.json`; the prompt was tuned on this set, so variant rates are an upper bound.
- Install: `soxe install review --host=claude,opencode,agent-mcp --scope=project` placed all three; claude header carries `disallowedTools: Edit, Write, NotebookEdit`; opencode effective ruleset denies edit/write/bash. Uninstalled afterwards.
