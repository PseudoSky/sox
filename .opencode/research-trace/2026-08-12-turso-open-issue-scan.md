# Research trace — Turso open-issue scan (2026-08-12)

## Metrics (Phase 6 Step 0)
| Metric | Baseline | Result | Delta | Target |
|--------|----------|--------|-------|--------|
| Search terms executed | 0 | 32 gh issue-list searches + 22 issue views + 4 source fetches | 32 | >=9 |
| Phases completed | 0 | 8 (0-7) | 8 | 7 |
| Watch-list findings written to memory | 0 | 8 episodes (7 topics) | 8 | >=3 |
| Confidence-labeled interpretive claims | 0 | 4 (all MEDIUM, none LOW) | 4 | >=1 |
| Sources verified per finding | 0 | issue states re-verified via gh issue view; bodies read for ~20 | — | >=2 |
| Rate limit / block events | 0 | 0 | 0 | <=2 |

Promotion gate: PASSED (>=3 useful searches, >=3 findings, 0 rate limits).

## Process failures (Step 2/3)
1. **Search formulation** — `gh issue list --search '"A" OR "B"'` leaked cross-repo results (GitHub OR clauses escape the auto-added `repo:` qualifier). Detected on axis-1 'reader slot OR reader snapshot' (LMDB/nvim/RTSP junk). Fixed by splitting into single-term queries. No finding rests on leaked rows; candidate #30 from the leak was verified CLOSED+unrelated before dismissal.

## What worked
- Memory-first: prior episodes (01KZTH9QY..., 01KZV2Y919..., FTS fiasco) gave a verified 2026-08-12 fix-status baseline — the gh sweep confirmed it, saving deep reads on known items.
- Known-state loop (10 issue views) as a first call — cheap and high value.
- Local grep for prepare()/synchronous/timeout decided three axis-4/6/7 items (false alarms) without upstream guessing.
- Wrapper timeout mapping traced to source (lib.rs -> connection.rs) to settle #3521.

## What failed / corrections
- OR scoping (above). Corrected mid-run.
- Initial curl of bindings/javascript/src/index.ts was wrong path (wrapper is Rust: browser.rs/lib.rs) — corrected via GitHub contents API.
- store-adapter src path guess (libs/data/store/src) wrong — corrected to libs/data/store/store-adapter/src via glob.

## Corrections to initial assumptions
- #3521 (busy_timeout) looked like our axis; verified false alarm for the JS path.
- MVCC-cluster issues (#8076/#7960/#8081 etc.) are out of our config (no MVCC flag; co-enable rejected) — classified LOW rather than HIGH despite 'data loss' titles.
- #8216 is OUR OWN prior filing (PseudoSky, 2026-08-05), not third-party.

## Actionable improvement for next run
For repo-scoped gh searches, never combine terms with OR — run one query per term (or parenthesize the qualifier per branch). Add a wrapper-version regression checklist item (fts DDL probe, 2-process macOS open, second-in-process open flags) for every driver bump.

## Confidence inventory (interpretive claims)
- #7340 core lock primitive applies to JS wrapper too — MEDIUM (same core, cross-binding inference).
- #8195 PASSIVE-fallback could abort a lagging reader in multiprocess — MEDIUM (mechanism-based, not empirically reproduced here).
- #8170 O(n^2)/bloat hits our trigger-based single-row write path — MEDIUM (consistent with our write pattern + observed WAL/DB growth).
- #7611 explains part of BL-509's dir-index mismatch — MEDIUM (issue describes valid-insert mismatch; our store's mismatch had a migration trigger too).
- No LOW-confidence findings remain.
