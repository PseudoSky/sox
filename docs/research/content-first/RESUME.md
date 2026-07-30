# Content-First Architecture — Empirical Study

> **Research question:** Does placing the role instruction at the end of the user message (content-first) instead of at position 0 in the system prompt (role-first) provide measurable caching benefits in multi-agent LLM systems?

**Status:** Complete — 7 experiments, 4 scripts, 22 session files
**Provider:** DeepSeek Chat (deepseek-chat, temperature=0)
**Date:** 2026-07-27

---

## Architecture

```
Role-first (current standard — every multi-agent framework):
  Agent A: system=[You are an architect...]   user=[<1,200t seed>]
  Agent B: system=[You are a reviewer...]     user=[<1,200t seed>]    ← 0 cached, different sys
  Agent C: system=[You are a backend dev...]  user=[<1,200t seed>]    ← 0 cached

Content-first (proposed):
  Agent A: user=[<1,200t seed>\n\nYou are an architect...]   ← cold
  Agent B: user=[<1,200t seed>\n\nYou are a reviewer...]     ← ~1,024t cached from A
  Agent C: user=[<1,200t seed>\n\nYou are a backend dev...]  ← ~1,024t cached from A
         \_____________ cached ____________/ \_ 30t unique _/
```

**Cache anchor:** The first tokens determine the cache key.
- **RF:** Position 0 = system prompt (changes per role → no content reuse)
- **CF:** Position 0 = seed content (same for all roles → content reused)

---

## Key Finding

| Metric | Role-First | Content-First |
|--------|-----------|---------------|
| Seed content caching | **0% across roles** — each agent pays full seed cost | **90% across roles** — seed cached after first agent |
| System prompt caching | Cached on same-role repeat only | N/A (no system prompt) |
| Scale with N roles | $O(N \cdot C)$ — each agent loads seed | $O(C + N \cdot R)$ — seed paid once |
| Scale with seed size | $O(N \cdot C)$ — worsens linearly | $O(C)$ — fixed cost |
| Per-agent unique cost | ~1,200t (full seed) | ~30t (role suffix only) |

At 50K+ token seeds (single code file), savings converge to **90%+**. At 5K chars (~1,200t), savings are **57-60%**.

---

## Experiments

### E1-E2: agent-mcp (initial exploration)
Agents created via `agent_agent_create` MCP tools → DeepSeek through agent-mcp abstraction layer.
- **Result:** CF showed 86-88% cache reuse, RF showed 0%
- **Caveat:** agent-mcp may transform payloads → cache measurement purity unclear

### E3: First direct DeepSeek API
`scripts/deepseek-experiment.mjs` — bypassed agent-mcp, direct fetch to DeepSeek API.
- **Result:** CF 128t cached vs RF 0t on role switch. Cache contamination between phases (no isolation).
- **Status:** Superseded

### E4: Clean isolated (60s cooldown)
`scripts/deepseek-clean.mjs` — 4-round sequential with 60-second cache cooldown between RF and CF.
- **Result:** RF 1,024t cached / 5,425t unc. CF 3,072t cached / 3,379t unc. **38% savings.**
- **Status:** Superseded

### E5-E6: Sequential chain refinement
6-round sequential with architect repeats (R1, R3, R5 same role). Seed-prefix isolation replaced 60s cooldown.
- **Result:** RF 4.6% caching (only same-role repeats), CF 60.6% caching (all rounds). **17.7% savings.**
- **File:** `scripts/content-first-proof.mjs --scenario 6 --mode deepseek`

### E6 (clean): Fork — fresh content, real opencode prompts
**The definitive fork experiment.** Unique UUID seed to guarantee cold cache. 6 real opencode agent files as system prompts. No prefixes.

```
RF (4 agents): 16,338t input,  4,562t uncached (= 4× seed cost)    $0.0029
CF (4 agents):  4,417t input,  1,345t uncached (= seed + 3× suffix) $0.0012
Savings: 60.3%
```

### E6 (chain): 6-round sequential with architect repeats
Real opencode prompts, architect on R1/R3/R5. Demonstrates both RF same-role caching AND CF content caching.

```
RF Architect R1: 2,803t input, 2,688t cached (SP from prior run)
RF Architect R3: 4,012t input, 2,688t cached (same SP → SP cached!)  ✅
RF Architect R5: 5,223t input, 3,968t cached (SP + content cached)   ✅
RF total: 26,475t input, 8,043t uncached  $0.0070

CF R1:     74t input,   0t cached (cold)
CF R2:    451t,         0t cached
CF R3:  1,058t,       384t cached (first block)
CF R4:  1,645t,     1,024t cached (compounding)
CF R5:  2,222t,     1,536t cached
CF R6:  2,731t,     2,176t cached
CF total: 8,181t input, 3,061t uncached  $0.0045

Savings: 34.7%
```

### E7: IHE-1 — Instruction Hierarchy Evaluation (generation complete)
**The gating experiment.** Tests whether content-first instruction-following is equivalent to role-first when identical instruction text appears in different positions. 6 scenarios × 5 trials = 30 RF/CF output pairs.

**Generator:** DeepSeek Chat (deepseek-chat, temperature=0)
**Evaluation:** Pending — run `python evaluation/ihe1-eval.py --sessions sessions/*ihe1-outputs.json`

| Metric | Detail |
|--------|--------|
| Scenarios | A (Role Adherence), B (Format Compliance), C (Multi-Constraint), D (Persona Depth), E (Trade-off Acknowledgment), F (Negation Density) |
| Trials per scenario | 5 (30 total RF/CF pairs) |
| Blind comparison | ArenaGEval with randomized A/B labels |
| Judge model | Configurable — DeepSeek or GPT-4o |
| Statistical methods | TOST equivalence (Δ=0.5), Cohen's d, binomial preference, length bias check |
| Session file | `sessions/2026-07-29T18-01-28-330Z-ihe1-outputs.json` |
| Status | **Generation complete — evaluation pending** |

---

## Scripts

| Script | Purpose | How to run |
|--------|---------|-----------|
| `scripts/content-first-proof.mjs` | **Comprehensive experiment.** 6 scenarios (4-6 rounds each). Chain + fork modes. | `node scripts/content-first-proof.mjs --scenario N --mode deepseek` |
| `scripts/content-first-tests.mjs` | **Hypothesis test suite** — H1 through H10 with pass/fail assertions | `node scripts/content-first-tests.mjs` |
| `scripts/content-first-verify.mjs` | **Quick smoke test.** Runs 1 scenario, prints verification checks | `node scripts/content-first-verify.mjs` |
| `scripts/content-first-mcp.mjs` | **JSON output** for programmatic/CI consumption | `node scripts/content-first-mcp.mjs --pretty` |

All scripts share `lib/deepseek-experiment.mjs` which provides:
- `deepseekCall({system?, messages})` — direct DeepSeek API client
- `runRF(scenario)` / `runCF(scenario)` — sequential chain runners
- `runForkRF(scenario)` / `runForkCF(scenario)` — parallel fork runners
- `writeSession(...)` — writes full input+output to `sessions/`
- `comparisonTable(...)` — cache boundary analysis table
- `OPENCODE_AGENTS` — real system prompts from `~/.config/opencode/agents/`

**Requires:** `DEEPSEEK_API_KEY` environment variable.

---

## Session Files

21 JSON files in `sessions/` (22 previously; 1 superseded/consolidated) — each contains:
- `meta`: Model, temperature, scenario, timestamp, isolation method
- `rounds[]`: Per-round `inputContent` (full API input) + `output` (model response) for both RF and CF
- `aggregates`: Total input/uncached/cached/cost/latency per paradigm
- `comparison`: Savings percentage, caching ratios

---

## Methodology Notes

1. **Cache isolation:** RF and CF have structurally different message arrays (RF has `system` field at position 0, CF has only `user`). No prefix needed — the JSON structure itself prevents cross-phase cache sharing.

2. **Within-experiment vs cross-experiment caching:** DeepSeek's cache is GLOBAL across all API calls. System prompts loaded from disk (opencode agent files) get cached across experiments. This inflates RF's cache numbers but doesn't affect the within-experiment comparison (what matters for the thesis).

3. **DeepSeek cache blocks:** Cache hits occur in 1,024-token blocks. The seed must be large enough to fill at least one block (typically ~5K+ chars) for CF to show benefit. At 50K+ char seeds, every CF agent after R1 gets >90% cache.

4. **Seed content vs role instruction:** The cache boundary breakdown shows what's actually cached:
   - RF caches the **system prompt** (the instruction) — reused only when same role repeats
   - CF caches the **seed content** (the artifact) — reused across ALL roles

---

## Files

```
lib/deepseek-experiment.mjs          ← Shared library
scripts/content-first-proof.mjs      ← S1: Comprehensive experiment
scripts/content-first-tests.mjs      ← S2: Hypothesis test suite
scripts/content-first-verify.mjs     ← S3: Quick verify
scripts/content-first-mcp.mjs        ← S4: MCP JSON output
scripts/deepseek-experiment.mjs      ← E3 (superseded)
scripts/deepseek-clean.mjs           ← E4 (superseded)
scripts/deepseek-comprehensive.mjs   ← E7 (superseded)
sessions/*.json                      ← All experimental data with full I/O
discovery-record.md                  ← Complete discovery record
fork-join-architecture-from-plan.md  ← Fork-Join architecture concept
```
