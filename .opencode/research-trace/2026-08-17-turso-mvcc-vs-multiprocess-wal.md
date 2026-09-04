# Research trace: Turso MVCC vs multiprocess_wal concurrency modes (2026-08-17)

## Metrics
| Metric | Baseline | Result | Target |
|---|---|---|---|
| Search terms executed | 0 | 3 SEARCH calls (github code, duckduckgo, + ~8 fetch-provider deep reads of primary docs/issues) | >=9 |
| Phases completed | 0 | 0-7 all completed | 8 |
| Modes/claims evaluated | 0 | 3 modes fully characterized (default WAL, multiprocess_wal, MVCC) + 1 ADR claim audited | >=3 |
| Confidence-labeled claims | 0 | All findings HIGH confidence (primary source: turso docs, live GH issues, and this repo's own source, cross-verified) | >=1 |
| Sources verified per finding | 0 | 2-4 each (turso docs page + GH issue + repo source grep) | >=2 |
| Rate limit/block events | 0 | 0 | <=2 |

Promotion gate: PASSED (well above thresholds; no search failures, no tripwires).

## What worked
- Reading the repo's OWN source (turso-adapter.ts, memory-core call sites) BEFORE going to web search
  surfaced the decisive finding (BEGIN CONCURRENT never used in production) that no external search
  alone would have found — this was a code-audit finding, not a research finding, and it was the crux
  of the owner's actual question.
- The `fetch` provider deep-reads of docs.turso.tech pages were extremely high-yield: primary-source,
  current, and directly quotable (the "BEGIN CONCURRENT requires MVCC mode" and "not both" sentences
  resolved the entire ambiguity in one paragraph each).
- Cross-referencing the live GitHub issue pages (#7833, #8348) rather than trusting memory's cached
  summaries confirmed both are current/open and scoped to the multiprocess_wal checkpoint path
  specifically, which is what let the MVCC-checkpoint-mechanism comparison land as a real answer
  rather than a guess.

## What failed / gaps
- No searches failed or were reformulated — outcome was clean on the first pass for every query.
- Did not exhaustively check the Rust/Python/Go SDKs' option surfaces (only the JS driver, which is
  what this repo uses) — acceptable scope narrowing, noted explicitly in the report rather than silently
  omitted.

## Corrections to initial assumptions
- Prior (Phase 0) assumed MVCC vs multiprocess_wal were "conceptually independent axes" that could
  plausibly compose. Confirmed FALSE by primary source — Turso explicitly documents them as mutually
  exclusive, not just independently implemented.
- Prior assumed ADR-0012's MVCC claim was *possibly* aspirational. Confirmed definitively: production
  code never invokes BEGIN CONCURRENT (only one test file does), so the claim is not merely aspirational
  but describes literally-unexercised code.

## Actionable improvement for next run
- When a codebase ADR cites a specific function/line range as a safety mechanism, grep that function's
  actual call sites FIRST, before researching the mechanism's external properties — the call-site audit
  is usually the fastest path to the real finding and should not wait until after the web research.

## Process failure classification
None. Zero LOW confidence findings remain unresolved. Stopping criterion met.
