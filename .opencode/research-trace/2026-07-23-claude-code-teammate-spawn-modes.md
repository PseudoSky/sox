# Research Trace: Claude Code Teammate Spawn Modes
**Date:** 2026-07-23
**Agent:** Researcher Agent

## Quantitative Metrics

| Metric | Baseline | Result | Delta | Target | Status |
|--------|----------|--------|-------|--------|--------|
| Search terms executed | 0 | 12 | +12 | >=9 | ✅ |
| Phases completed (1-6) | 0 | 6 | +6 | 6 | ✅ |
| Tools/patterns cataloged | 0 | 3 | +3 | >=3 | ✅ |
| Confidence-labeled claims | 0 | 8 | +8 | >=1 | ✅ |
| Sources verified per tool | 0 | 3-4 | +3-4 | >=2 | ✅ |
| Rate limit / block events | 0 | 0 | 0 | <=2 | ✅ |

## Sources consulted
1. Anthropic official docs — Claude Code hooks (https://docs.anthropic.com/en/docs/claude-code/hooks)
2. Anthropic official docs — Claude Code agent teams (https://docs.anthropic.com/en/docs/claude-code/agent-teams)
3. Anthropic official docs — Claude Code settings (https://docs.anthropic.com/en/docs/claude-code/settings)
4. Anthropic official docs — Claude Code sub-agents (https://docs.anthropic.com/en/docs/claude-code/sub-agents)
5. GitHub Issue #24175 — Consistent hook execution across in-process and pane-based teammate spawn modes
6. GitHub Issue #45329 — Include teammate_name in all hook events
7. Local settings: ~/.claude/settings.json (teammateMode: "auto")
8. Local agent cache: ~/.claude/plugins/cache/sox-subagents/*/agents/ (agent definitions)
9. Claude Agent definitions: ~/.claude/agents/ (agent collection)
10. ADHD repo structure check
11. sox-ecosystem docs scan for spawn mode references
12. claude-agents repo scan for spawn mode references

## Search strategy — what worked well
- Fetching both GitHub issues simultaneously provided the most detailed and specific information about spawn mode differences
- The official Anthropic documentation provided the authoritative reference for teammateMode values and hook lifecycle
- Cross-referencing multiple independent sources (docs + GitHub issues + local config) gave HIGH confidence

## Searches that failed and why
- https://docs.claude-code.com/docs/hooks — transport error (wrong domain)
- https://docs.claude-code.com/docs/agents — transport error (wrong domain)
- The correct domain is docs.anthropic.com/en/docs/claude-code/

## Corrections to initial assumptions
- `in_process_teammate` is NOT an official documented mode or setting value. It's an internal code path name from the cli.js source. The official setting values are: `"in-process"`, `"auto"`, `"tmux"`, and `"iterm2"`.
- The default changed from `"auto"` to `"in-process"` in v2.1.179 (noted in docs)
- Agent teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to be enabled (the user's settings don't have this set)
- The sox-ecosystem's `apigen-serve-core-planbuilder` agent uses the `Agent` tool with `teamName` for subagent spawning, not the agent teams teammate system per se

## Process failure classification
- **Generalization drift (minor)**: Initial framing assumed `in_process_teammate` was a documented setting value. Corrected after reading both Anthropic docs and GitHub issue source code paths.
- **Search formulation (minor)**: Initial attempt at docs.claude-code.com failed. Correct URL found via search.

## Actionable improvement for next run
Include a URL verification step earlier in the process — if a documented URL returns transport error, immediately search for the correct URL rather than assuming the domain is correct.

## Promotion gate
✅ PASSED — 12 search terms, 3 episodes written, 0 rate limit events