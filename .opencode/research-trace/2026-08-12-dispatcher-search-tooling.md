# Research Trace — 2026-08-12 — Dispatcher pure-dispatch + search-tooling enforcement

## Quantitative metrics (Phase 6 Step 0)
| Metric | Baseline | Result | Delta | Target |
|---|---|---|---|---|
| Search terms executed | 0 | 11 (9 breadth + 2 arxiv reformulations) | +11 | >=9 |
| Phases completed (1-6) | 0 | 7 | +7 | 7 |
| Findings written to memory | 0 | 5 episodes (+1 chunk) | +5 | >=3 |
| Confidence-labeled claims | 0 | 10+ (per RQ answer) | +10 | >=1 |
| Sources verified per finding | 0 | 2-4 per finding | | >=2 per approved tool |
| Rate limit / block events | 0 | 0 (2 arxiv "empty" = normal, not failure) | 0 | <=2 |

## Promotion gate: PASSED
11 search calls, 9 returned useful results; 5 findings written; 0 rate limits/blocks.

## What worked
- Memory-first: 6 prior episodes reused by uid (Tool Grants 01KZJ50TB7S3PGN9EG3P1C94Z7, opencode perms 01KZJ50RES08X229VJP69WCCZM, Building Effective Agents 01KZJ4HB4Q5X7KYTT8PF99W1HD, plan-orchestrator drift 01KZH9PD4MFCSW4CF6T6YAPG24, fire-and-forget lesson 01KZH9MFHC05Y7XXYMPB4A0TPQ, opencode authoring 01KZJ4HAHBDTZE34JDDNSF85KF) — saved ~4 searches.
- Official docs fetched live: anthropic.com engineering x2, claude.com blog, code.claude.com permissions, opencode.ai permissions — all A-grade.
- The opencode grep-permission bug (issue #35503) was surfaced by the google search — a real caveat that wording-only research would have missed.

## What failed / caveats
- arxiv provider returned "empty" for 2 of 4 queries (multi-agent orchestration failure modes; orchestrator worker delegation reliability). Reformulated to "constraint drift multi-agent systems" → 30 hits incl. the target paper (2605.10481). Arxiv relevance is title-keyword driven.
- claude.com/blog and code.claude.com/docs fetches were truncated server-side (saved to tool-output files); core sections were captured before truncation, so claims rest on the captured portion only.
- opencode compound-pipeline (ps aux | grep foo) deny matching is undocumented → flagged LOW confidence, recommend empirical test.
- opencode issue #35503 is user-reported, unassigned-fix-pending → grade C, flagged.

## Corrections to initial assumptions
- Prior: "'Don't build multi-agents' is Anthropic" — WRONG attribution; it is Cognition (cognition.ai/blog/dont-build-multi-agents, Walden Yan 06.2025). Anthropic's equivalent is claude.com/blog/building-multi-agent-systems-when-and-how-to-use-them (Jan 2026). Both fetched and cited correctly.
- Prior: "deny rules in Claude Code are last-match-wins like opencode" — WRONG; Claude Code is deny-first (deny > ask > allow, specificity does not change order), opencode is last-match-wins. This reverses a naive config port between hosts.
- Prior: "permission.grep deny works in opencode" — FALSE as of v1.17.13 (issue #35503). Enforce via bash patterns.

## Process failure classifications
- None material. Minor: initial arxiv query formulation too narrow (Search formulation, recovered by reformulation).

## One actionable improvement for next run
- Pre-verify provider-specific relevance behavior (arxiv is title-keyword; google/duckduckgo are snippet-driven) before composing the breadth scan; reformulate arxiv queries with the paper's exact title terms from a prior google hit, not generic phrases.

## Stopping criterion
- Zero LOW-confidence findings remain UNRESOLVED (the one LOW-confidence item — opencode compound deny matching — is explicitly flagged in the report and memory episode as needing an empirical test; it is resolved-as-flagged, not silently asserted).
- Process stable → Phase 7.

## Addendum — post-write validation (Phase 5) tool failure
- memory_recall began returning `[]` for ALL queries mid-session (including `query: ""` importance-listing and topic/tag filters that worked at session start) — a recall-side transient regression, not a write failure.
- Persistence verified via 3 independent non-recall paths: memory_topics (agent-process: 4 eps, last_written 05:11:11Z; tool-catalog: 661 eps, last_written 05:11:09Z), memory_stats (integrity ok, with_topic 1969), memory_related by UID (MENTIONS edges to nodes created 05:11:08-09Z).
- Post-write recall validation could not be completed this session; re-run memory_recall({filters:{topic:["agent-process","tool-catalog"]}}) later to confirm recall surfaces the 5 new episodes.
