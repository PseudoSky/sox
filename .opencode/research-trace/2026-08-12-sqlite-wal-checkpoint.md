# Research trace — SQLite WAL checkpoint semantics / close-flush / libsql multiprocess_wal

Date: 2026-08-12 · Agent: researcher-agent · Topic: tool-catalog

## Quantitative metrics

| Metric | Baseline | Result | Delta | Target |
|--------|----------|--------|-------|--------|
| Search terms executed | 0 | 17 | +17 | >=9 |
| Phases completed (1-6) | 0 | 6 | +6 | 6 |
| Tools approved/blocked | 0 | 3 (2 approved, 1 blocked) | +3 | >=3 |
| Confidence-labeled claims | 0 | 6 (5 HIGH, 1 MEDIUM + 1 MEDIUM caveat) | +6 | >=1 |
| Sources verified per approved tool | 0 | 2-4 per tool | +2..4 | >=2 per approved tool |
| Rate limit / block events | 0 | 0 | 0 | <=2 |

**Promotion gate: PASSED** (>=3 useful searches: 9/17 returned useful results; >=2 tools: 3; 0 rate-limit events). Not INCOMPLETE.

## What worked
- Breadth-first duckduckgo/google scan (11 parallel queries) surfaced the exact authoritative sources on the first pass (wal_checkpoint_v2, wal.html, c_dbconfig_defensive, Litestream, rqlite, sqlite forum, Hynek TIL).
- Memory recall was load-bearing: prior episodes 01KZSDSDM8TCFW0B6ZQCV4B03W (libsql 3.43.0 / WAL-reset), 01KZQ90T0MKG86ND0EAG3EK22R (.tshm lock-protocol mixing corrupts), 01KZSDSD2CJ94AQMA4WZ0NMCFW (@libsql/client API surface) directly answered RQ3 without re-research.
- Official sqlite.org docs fetched live for every semantic claim (wal_checkpoint modes, PRAGMA return row, checkpoint-on-close, WAL-reset bug).

## What failed / was slow
- arxiv search: empty (expected — topic has no meaningful scholarly coverage).
- github type:code search on tursodatabase/libsql: empty twice (even for wal_checkpoint) — substituted duckduckgo/google with site-specific queries instead; libsql internals were covered via README + libsql-js api.md + vfs-shm.txt raw fetches.
- Turso docs URL guess (docs.turso.tech/features/multi-process-access) 404'd; correct URL (docs.turso.tech/sql-reference/multiprocess-access) found via a follow-up google search.

## Corrections to initial assumptions
- **Phase 0 prior WRONG**: "SQLite does not checkpoint automatically on last-connection close" — false since SQLite 3.44.0 (2023-11-01). sqlite.org/wal.html §3.1/§6 + SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE confirm the default is checkpoint-then-delete-WAL on last-connection close. The prior was historically true pre-3.44 and remains true for libsql (3.43.0 base) — which is exactly why the libsql caveat is the central finding.
- Confirmed prior: TRUNCATE truncates -wal to zero bytes only on successful completion; PASSIVE skips with active readers/writers.

## Process failure classifications
1. **Tool-contract misread** (search envelope): assumed agent_search returned `{results:[...]}` at top level; actual envelope is `{result:{...}}`. First 11-query batch silently returned empty. Recovered same-session by probing one call. Not a search-formulation failure. Actionable improvement: probe one response and inspect keys before batch-parsing a new tool's output.
2. **Tool-contract misread** (memory_entity_episodes): passed `query` instead of `entity_name`; errored, recovered by checking the signature via $codemode.search. Same root cause as #1.

## One actionable improvement for next run
Verify the raw response envelope (keys/type) of any newly used MCP tool with a single probe call before running a batch — both failures this run were envelope misreads.

## Stopping criterion
Process failures identified (2 tool-contract misreads, both recovered, none affect finding validity). All findings are MEDIUM or HIGH confidence; no unresolved LOW-confidence findings. One MEDIUM-confidence item flagged in-episode: @libsql/client execute("PRAGMA wal_checkpoint(TRUNCATE)") exposing the busy row (inferred, not explicitly documented). Proceeding to Phase 7.
