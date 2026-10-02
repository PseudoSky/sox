# Research trace — retrieval-augmented reassessment for Generic Adaptive Decision System

## Metrics

| Metric | Baseline | Result | Delta | Target |
|--------|----------|--------|-------|--------|
| Search terms executed | 0 | 14 (WebSearch queries; no dedicated SEARCH MCP available) | +14 | >=9 |
| Phases completed (0-7) | 0 | 8 | +8 | 8 |
| Tools approved/blocked | 0 | 5 (DSPy approved-narrow, GEPA blocked, TextGrad/OPRO/APE blocked-grouped) | +5 | >=3 |
| Confidence-labeled claims | 0 | 6+ (LOW/MEDIUM/HIGH labels across EvoRoute, ExpeL/Reflexion, DPT findings) | +6 | >=1 |
| Sources verified per approved tool | 0 | DSPy: 2 (pypi JSON + pypistats); GEPA (blocked but verified): 2 | 2 | >=2/approved tool |
| Rate limit / block events | 0 | 1 (pypistats 429 on gepa, resolved on 1 retry) | 1 | <=2 |

**Promotion gate: PASSED.** >=3 search terms returned useful results, >=2 tools found, <=3 rate limits.

## Tool availability defect (process note, not a content failure)

The persona/system prompt describes a dedicated `mcp__search__agent_browser_search_mcp_source_search` MCP with 12 providers (npm/pypi/github/arxiv/etc.), but that tool was **not present** in the actual granted tool list for this session — all six parallel invocation attempts returned `No such tool available`. Diagnosed once via a direct call (not retried in a loop, per protocol), then switched to the sanctioned `WebSearch` fallback for discovery and `Bash`+`curl`+`WebFetch` for registry verification (pypi JSON, pypistats). This was stated explicitly in the final report per the "Failure recovery" protocol requirement to disclose provider substitution. No degraded-workaround was used silently.

## What worked well

- Reading the primary source (the spec itself) before any web search anchored every subsequent claim to a specific section number (§7, §11.3, §17-19, §23, Invariant 3), avoiding generic-NLP-RAG search noise.
- Calling `advisor` before committing to methodology surfaced two load-bearing corrections before any writing happened: (1) verify GEPA-vs-DSPy relationship first (avoided a structurally wrong comparison), (2) the pointwise-vs-listwise scorer distinction as the actual test of Invariant 3, not "does the framework support dynamic options" in the abstract. Both were verified and held up under search.
- Using real paper/system names (ExpeL, Reflexion, EvoRoute, Decision-Pretrained Transformer, BaNk-UCB) rather than generic descriptive queries ("retrieval augmented bandits") avoided static-NLP-RAG noise, exactly as the advisor predicted.

## What failed / had to be reformulated

- Initial WebFetch of `dspy.ai/api/optimizers/KNNFewShot/` returned only a redirect stub with no content — the WebSearch aggregate answer (drawing from codesignal.com, hexdocs mirror, DSPy docs) supplied the needed detail instead. Not re-attempted a second time per the "one retry" ceiling for this kind of dead-end.
- pypistats.org rate-limited the `gepa` package query once (429); one retry after a short pause succeeded. Logged as the session's single rate-limit event.

## Corrections to initial assumptions

- Prior (uninformed) assumption going in would have been "GEPA is a rival framework to DSPy, evaluate them as two separate systems" — corrected immediately: GEPA is an optimizer inside the DSPy ecosystem (also shippable standalone via the `gepa` pypi package), confirmed via the paper (arXiv:2507.19457) and dspy.ai's own GEPA tutorial page.
- The reviewer's proposal, taken at face value, reads as if it fully solves the fabricated-target problem. Verified against the spec's own §11.3 worked example (storing a full revised distribution) that this is not true as literally stated — the defect relocates from loss function to prompt context unless the exemplar store is restricted to observed facts/pairwise preferences.

## Process failure classification

None rise to a genuine process failure this session (the promotion gate passed cleanly). The one procedural anomaly — the described SEARCH MCP being entirely absent from the granted tool list — is a **tool-provisioning** issue external to the research methodology itself, not a search-formulation, source-selection, generalization-drift, or inference-leakage failure. It was handled per the "fail fast, don't work around silently" policy: diagnosed once, disclosed explicitly, and the sanctioned WebSearch fallback used for the remainder.

## One actionable improvement for next run

If the dedicated SEARCH MCP is expected to be present, verify its actual presence in the granted tool list at the START of Phase 2 (a one-line check) before drafting the full Phase-2 query plan around its provider-specific syntax (qualifiers, `type:code`, etc.) — that syntax was drafted and then discarded unused this session, a small amount of wasted planning that a one-line presence check would have avoided.

## Stopping criterion

All 9 written findings are `data_quality: verified` (DSPy, GEPA, TextGrad/OPRO/APE metrics) or `data_quality: estimated` (patterns/use-cases, correctly labeled since they synthesize across multiple non-registry sources rather than a single verifiable metric). Confidence labels (LOW/MEDIUM/HIGH) are attached inline to every interpretive claim that could not be independently re-verified (EvoRoute's specific performance numbers, DPT-to-generic-LLM transfer, ExpeL/Reflexion's fit to this spec's harder requirements). No LOW-confidence claim was left unflagged. Proceeding to Phase 7 (self-consistency check, performed in the final report) with zero unresolved process failures.
