# Process Trace — 2026-08-04 DeepSeek reasoning_content pass-back research

## Quantitative metrics
| Metric | Baseline | Result | Delta | Target |
|--------|----------|--------|-------|--------|
| Search terms executed | 0 | 9 | +9 | >=9 |
| Phases completed (1-6) | 0 | 6 | +6 | 6 |
| Tools approved/blocked | 0 | 4 findings (1 approved contract, 3 pattern/use-case) | +4 | >=3 |
| Confidence-labeled claims | 0 | 6 | +6 | >=1 |
| Sources verified per finding | 0 | 2-15 per finding (official docs + issues) | - | >=2 per approved tool |
| Rate limit / block events | 0 | 0 | 0 | <=2 |

Promotion gate: PASSED (9 useful search terms, 4 findings, 0 rate limits).

## What worked
- Official Thinking Mode guide is the single authoritative source; it directly documents the rule (tool-call turns must pass back reasoning_content; non-tool-call turns ignored).
- GitHub issue searches surfaced a large ecosystem of corroborating reports (spring-ai, opencode, warp, openclaw, continue, n8n, Roo-Code) — 8+ independent implementations hit the same 400.
- Independent live-test source (chat-deep.ai) provided the crucial negative control: server enforcement is NOT fully consistent, explaining the caller's intermittency.

## What failed / gaps
- No official source explicitly documents byte-identical requirement — flag as AMBIGUOUS (state so, don't guess).
- No authoritative confirmation of provider-side prefix-cache byte-match validation — hypothesis remains unconfirmed (MEDIUM confidence at best).
- Error Codes page does not enumerate the specific message.

## Corrections to initial assumptions
- Caller proposed `reasoning_effort: "none"` workaround — WRONG for OpenAI format (only low/high/max); the "none" disable is the Anthropic-format `reasoning.effort` param. Correct workaround: `thinking.type: "disabled"`.

## One actionable improvement for next run
- When a caller reports an intermittent provider error, prioritize searching for (a) independent live-test sources and (b) client-side cache/state mechanisms (streaming reconstruction, LRU cache miss) before assuming provider-side state — the evidence here pointed to client-side variance + inconsistent server enforcement, not a documented provider cache byte-match.

## Process failure classifications
- None found that inverted conclusions. Minor: initial priors leaned toward "OpenAI-style reasoning echo" pattern; verified against DeepSeek docs which differ in conditionality (tools-param-based, not always-echo) — generalization drift corrected during search, not after.
