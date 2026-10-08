# Changelog

## 0.1.1

Static-review corrections (2f81569f T11).

- Blind and blind-deep make NO tool calls and judge only the brief; static mode may read. Tests assert the rule text and that the blind templates name no path.
- blind-deep refuses unlabeled implementer rationale inside the specification or tests (narrative, commit-message rationale, test comments explaining the implementation); header lines (failure mode, tier) stay permitted.
- Static mode accepts `rigor: deep` and refuses implementer reasoning (roles.md SR independence).
- Static checklist now implements every declared obligation: SR.1 (G9, R3), SR.2 (§6.5 plus a recorded red run on a failed assertion), SR.3 (R4), SR.4 (G12 headers plus planning-record presence). A test asserts each declared SR id has a checklist line.
- `mode: blind-deep` is named explicitly in the mode table; `<line>` is defined as the new-file line.
- Eval: `eval/results.json` is written only by `node eval/run.mjs` (records command, ISO `recordedAt`, grader version, sha256 of `review.md` and `cases.mjs`); the AC3 test re-grades every stored row, re-derives the summary, and fails if the prompt, cases, or grader changed since the recording. Grader: REFUSED must be the whole output; the read-only decline must be the exact line `read-only: cannot edit or run`; the anchor accepts only the planted line 7. Briefs are rendered from `templates/`.
- `check-readonly.mjs` MUST_DENY adds task, skill, webfetch, websearch, question, todowrite (manifest denies todowrite) and rejects render overrides: `render.<host>.permission` that replaces the map or omits a deny, `render.agent-mcp.permissions` loosening, `render.agent-mcp.mcpServers` grants.
- The manifest `$schema` placeholder (`https://your-registry/schemas/extension/v2.json`) is unchanged: every sibling agent carries the same value and no real schema URL exists in the repo.

### Evidence (0.1.1)

- Tier run: **sonnet** (`claude -p --model sonnet`), 18 cases x 3 reps x 2 arms (14 tuning, 4 held out), tools disabled in the harness. Shipped tiers: sonnet on claude WAS covered; deepseek/deepseek-flash on opencode and agent-mcp was NOT run. haiku was not run for 0.1.1; the 0.1.0 haiku numbers below are superseded.
- Baseline one-liner prompt 0/54. `review.md`: 51/54 = 0.944 overall; static 20/21 = 0.952; blind and blind-deep 31/33 = 0.939; tuning cases 0.929; held-out cases (H1-H4) 12/12 = 1.0. Neither mode sits in the 0.5-0.8 halt band (agent-manager §7.5); no case is 0/3. Weak spots: B1 2/3 and S5 2/3 (the model misnumbers the planted line, citing 6 or 8 instead of 7), B2 2/3 (reviewed a rationale-bearing blind brief instead of refusing).
- Held-out caveat: the first sonnet pass (prompt before the mode-label and line-number clarifications) scored held-out 12/12 and variant 0.944; two small prompt edits followed, so the held-out set informed those edits only indirectly. Variant rates remain an upper bound on unseen briefs. Bug detection (loose regex on the planted line): baseline 0/6, variant 5/6.
- Tool-use rules are not exercised by the harness (`--tools ""`): that blind modes really make no tool calls, and that static mode really reads cited files, is prose-level and unmeasured.
- agent-mcp enforcement is NOT verified: `check-readonly.mjs` proves the manifest and render overrides declare no write capability, but no run of the installed agent-mcp agent confirmed its provider honors the permission/tool restrictions (agent-mcp.ts derives them from IR `permission`; claude gets `disallowedTools` only for edit/write, bash is excluded by the tool whitelist). The 0.1.0 install check covered claude and opencode headers; 0.1.1 was not re-installed (out of scope for this change).

## 0.1.0

- Initial release (2f81569f T11). Read-only `review` agent with static and blind modes
  (blind-deep at Deep rigor: diff, specification, tests; never the implementer's reasoning, D22).
- Tools: read, glob, grep only; `edit`/`write`/`bash` denied (renders `disallowedTools` on claude).
- Declares `capabilities: roles-covered:SR.1..SR.4` (D23), the Static reviewer obligations in workspace-standards `roles.md`.
- Blind templates in `templates/` carry only `{{diff}}` (plus `{{specification}}`/`{{tests}}` for blind-deep).

### Evidence (0.1.0)

- Golden-set A/B (haiku, 10 cases x 3 reps, code-based grader): baseline one-liner prompt 0/30; `review.md` 25/30 (static 14/15, blind 11/15). Format and refusal conformance, not bug detection: both arms located the planted defect 6/6. Weak spot: blind refusal of wrong-instruction and rationale briefs (B2 1/3, B3 1/3 at haiku). Recorded in `eval/results.json`; the prompt was tuned on this set, so variant rates are an upper bound.
- Install: `soxe install review --host=claude,opencode,agent-mcp --scope=project` placed all three; claude header carries `disallowedTools: Edit, Write, NotebookEdit`; opencode effective ruleset denies edit/write/bash. Uninstalled afterwards.
