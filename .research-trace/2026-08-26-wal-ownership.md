# Research trace — 2026-08-26 · WAL ownership / turso multiprocess_wal incident

## Metrics

| Metric | Baseline | Result | Delta | Target |
|---|---|---|---|---|
| Search terms executed | 0 | 26 | +26 | >=9 ✅ |
| Phases completed (0–7) | 0 | 8 | +8 | 8 ✅ |
| Tools/mechanisms approved/blocked | 0 | 6 (4 approved, 2 blocked) | +6 | >=3 ✅ |
| Confidence-labeled claims | 0 | 10+ | +10 | >=1 ✅ |
| Sources verified per approved tool | 0 | 4–5 | — | >=2 ✅ |
| Rate limit / block events | 0 | 3 HITL | +3 | <=2 ⚠️ deviation |

Promotion gate: PASSED (26 useful terms; 6 mechanisms; 3 blocks is not >3). Metric 6 deviates — all HITL (google×2, stackoverflow×1 captcha), handled per protocol (waited, no retry), zero data loss. The two google HITL intents were covered via duckduckgo/fetch/curl for the same ground; noted as provider substitution in output.

## What worked

- GitHub API (curl+jq) for issue state/comments — primary-source verification, zero rate-limit issues.
- sqlite.org canonical pages via curl+python text extraction — precise quotes for crash/checkpoint/close contracts.
- Fetch provider for Turso docs — full rendered markdown of multiprocess-access page (canonical contract).
- Memory prior work was decisive: episodes 01KZTH9QY2X5KAJNTVMDY0VE03 (upstream status 08-12), 01KZVA1ZF89R71QTYZ8TBNK1DP (BUG-014 cross-engine root cause), 01M08GRQHBE19A6BJ9QHQ0HYG8 (topology recommendation) anchored RQ1/RQ3 and let web research focus on updates + gaps.

## What failed / corrections

- Round-1 searches (9 calls) parsed the wrong response envelope — the MCP returns `{result: {...}}`; I read top-level fields. Wasted 9 calls. Class: interface misuse.
- memory_write returned E_MISSING_PROJECT_PATH 7× — project_path is required and not inferred. Class: interface misuse.
- Post-write validation filter used tags:["tool-catalog"] but tool-catalog is the topic — zero hits on first try. Class: interface misuse.
- Correction to initial assumptions: SQLite does NOT re-check WAL inode identity; it validates WAL content via wal-index salt/checksum. Classic SQLite's default close behavior (last-connection checkpoint + WAL/-shm delete) is the root of the cross-engine hazard, not an edge case.
- Docs-vs-behavior gap: turso multiprocess docs state readers cannot be invalidated by writers; #7833 reproduces exactly that violation. Docs = intent, not current behavior.

## Next-run improvements

1. Discover exact MCP signatures (one $codemode.search per namespace) BEFORE batching calls; stringify the first error before any retry.
2. Keep a "response envelope" cheat-sheet per MCP (search → `{result}`, memory_recall → parse string).
3. Prefer `topic` over `tags` when validating tool-catalog writes.

## Process failure classifications

- Search formulation: none
- Source selection: none
- Generalization drift: none
- Inference leakage: none
- Interface misuse (schema assumption): 3 occurrences — recurring pattern, addressed above.

## Stopping criterion

All findings MEDIUM/HIGH confidence; no LOW-confidence findings remain. Process failures are interface-misuse class only (not reasoning). Logged complete.
