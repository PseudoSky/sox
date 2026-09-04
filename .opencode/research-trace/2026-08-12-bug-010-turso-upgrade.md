# Research trace — BUG-010: upgrade @tursodatabase/database past 0.7.2?

Date: 2026-08-12 (run 3 of the day; prior runs at 00:07/01:36 wrote memory episodes)

## Metrics (Step 0)

| Metric | Baseline | Result | Delta | Target |
|--------|----------|--------|-------|--------|
| Search terms executed | 0 | ~20 (npm view x4, npm pack x1, GitHub API x9, raw source x4, local clone greps, adapter source reads) | +20 | >=9 |
| Phases completed (1-6) | 0 | 6 | +6 | 6 |
| Tools approved/blocked | 0 | 2 evaluated (0.7.2, 0.8.0-pre.4) — verdict: WAIT, not approve | +2 | >=3 (N/A for verdict run) |
| Confidence-labeled claims | 0 | >=5 (all HIGH, source-verified) | +5 | >=1 |
| Sources verified per conclusion | 0 | >=4 per conclusion | +4 | >=2 |
| Rate limit / block events | 0 | 0 (GitHub API unauthenticated OK; no captcha/ban) | 0 | <=2 |

Promotion gate: PASS (useful searches ~20, conclusions >=2, rate-limit events 0).

## What worked
- GitHub REST API (releases/tags/commits/search/raw) for exact SHA provenance — web search cannot give commit SHAs.
- npm pack + d.ts diff for API-compat verdict — authoritative shipped-surface comparison.
- Local clones for source content at fixed tags (shallow clones OK for content, NOT for history).

## What failed / corrections
- Both local clones are SHALLOW (rev-count=1): git log -S history search impossible locally; switched to GitHub search-commits API. Noted for future runs: request full clones if history mining is expected.
- debug-triage's "pager.rs:4213-4221" defensive check is at 4270-4274 on current main/0.8.0-pre.4 (line drift) AND guards the commit PrepareFrames path, NOT process_overflow_read — the panic path is unfixed despite the check.
- Memory prior-work (episodes 01KZTH9QY2X5..., 01KZTH9PPGZ6..., 01KZTN33...) was accurate; this run added: exact page1-fix commit (7f2a669fe8) verified IN v0.7.1 tag, pager.rs check context, wrapper API d.ts diff, BL-360 gate interplay, consumer list.

## Confidence assessment
- ALL findings HIGH: every claim traced to a live tool response (npm metadata, GitHub API/raw, shipped wrapper d.ts, adapter source). No LOW-confidence findings unresolved.

## Actionable improvement for next run
- For provenance tasks, go straight to GitHub API search/raw (shallow clones can't answer history questions); reserve web search for discovery of unknown unknowns.

## Process failure classifications
- None significant. Minor: search_search MCP provider unused this run (GitHub API substituted — justified, exact-SHA needs).
