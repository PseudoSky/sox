# Live Agent Dispatch Experiment — 2026-07-29

## Objective

Compare token cost between role-first (RF) and content-first (CF) prompt structure during a real multi-agent dispatch loop: Typescript → Reviewer → Typescript → Reviewer → Tester, each working in its own opencode conversation on the same bug-fix task.

## Setup

**Two arms, single proxy with model-based routing:**
- `deepseek-rf` — passthrough (system prompt at position 0, no rewrite)
- `cf-v4-flash` — rewrite (system prompt split into shared boilerplate + agent role; shared stays at position 0, agent role appended to user message)

**One proxy instance** logged both arms to separate files (`proxy-deepseek-rf.jsonl`, `proxy-cf-v4-flash.jsonl`).

**Proxy improvements made during session:**
- Model-based routing: `cf-*` model triggers rewrite, anything else passthrough
- Agent-aware system prompt split: loads agent .md files from `~/.config/opencode/agents/`, splits composing prompt into shared boilerplate + agent body
- No more brute-force system→suffix move

**Bug used:** `libs/memory-core/src/cluster.ts:199` — `filter(Boolean)` on vector lookup that appeared to mask an inconsistency.

## Results

| Metric | RF | CF | Delta |
|---|---|---|---|
| Calls | 46 | 50 | +4 |
| Total input tokens | 3,463,733 | 5,501,690 | +58.8% |
| Uncached tokens | 166,965 | 121,338 | **-27.3%** |
| Cache rate | 95.2% | 97.8% | +2.6% |
| Total cost | $0.298 | $0.434 | +45.6% |

## Findings

1. **CF saved 27% on uncached tokens** — the primary metric for real compute. CF paid less for actual LLM compute.

2. **CF had higher absolute cost** ($0.43 vs $0.30) because it ran more conversation rounds (50 vs 46) and DeepSeek charges $0.07/M for cached tokens too — so caching more volume added cost.

3. **Agent behavior differed between arms:**
   - RF agent produced a targeted fix (1 file, +22/-5)
   - CF agent produced a broader fix that also discovered a missing `fts5` type in a related file — likely because it had more accumulated context and explored more widely

4. **The bug was not real.** The `filter(Boolean)` on line 199 was unreachable defensive code — all members are guaranteed to have vectors by the caller. Both agents were dispatched on a wild goose chase.

5. **Proxy split worked** — the agent body was correctly separated from shared boilerplate and placed at the end of the user message. Shared boilerplate (~37K chars) stayed at position 0 across agent switches.

## Issues

- The experiment was confounded: different agent behavior (CF explored more), different number of calls, and a non-buggy target
- The bug itself being invalid undermines any conclusion about fix quality
- Cost comparison is noisy due to different conversation lengths and the cached-token pricing model

## What's next

The proxy infrastructure (model-based routing, agent-aware split, per-model logging) is functional and could be used for a cleaner experiment if a real, well-scoped bug is chosen.
