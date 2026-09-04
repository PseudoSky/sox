# Research trace — guarded-listen / port-ownership (2026-08-26)

Topic: repo-wide invariant — every HTTP/SSE/WS `listen()` must attach an `'error'` handler BEFORE `listen()`; EADDRINUSE must produce a structured record (code/errno/port/pid) and exit 0 (already running elsewhere) / 1 (other listen errors); never a raw stack crash.

## Phase 6 Step 0 — Quantitative measurement

| Metric | Baseline | Result | Delta | Target |
|---|---|---|---|---|
| Search terms executed | 0 | 35 | +35 | >=9 ✅ |
| Phases completed (0–7) | 0 | 8 | +8 | 8 ✅ |
| Tools approved/blocked | 0 | 7 (3 approved, 4 blocked) | +7 | >=3 ✅ |
| Confidence-labeled claims | 0 | ~12 inline | +12 | >=1 ✅ |
| Sources verified per approved tool | 0 | 3–4 per approved tool (npm view + downloads API + README/source fetch) | | >=2 ✅ |
| Rate limit / block events | 0 | 2 (google `hitl` ×2) | +2 | <=2 ✅ (at boundary) |

**Promotion gate: PASS.** >9 useful searches, 7 tools found, 2 block events (at limit but not exceeded).

## What worked

- Source-verification via raw GitHub markdown + `rg` (Node doc/api/net.md, errors.md; vite http.ts; webpack-dev-server Server.js) was token-cheap and produced verbatim, HIGH-confidence evidence — the strongest findings (reusePort macOS-unsupported, listen-callback-is-listening-only, vite error-before-listen, wds zero-error-listener) all came from this path.
- `memory_write_batch` filed 15 episodes in 2 calls; `memory_topics` confirmed topic counts (guarded-listen: 7, port-ownership: 8).

## What failed

- **google provider: 2 `hitl` (captcha) events** (queries 5 and 9 of the breadth scan). Per HITL policy: stopped using google for the session, did not retry, substituted duckduckgo + primary-source fetches. **Substitution stated in final output.** Both queries were recoverable (reusePort → Node docs; MCP structured diag → SDK docs + prior-art patterns).
- **arxiv: empty** (expected — engineering-practice topic, no academic coverage).
- **github code search: empty ×2** (vite/wds phrase search) → reformulated to raw-source curl, which succeeded.
- **`memory_recall` degraded mid-run**: returned 0 for ALL queries (including pre-existing episodes and empty-query importance listing) at ~22:06, after working at 21:57. `memory_ping` reports `status: ok, store_ok: true, embed.state: real`; `memory_topics` (direct DB read) confirms episodes. Correlates with server enrichment stall (`last_isolated_error: signal:SIGTERM`, stall escalated 21:53, 9 consecutive stalled ticks). **Post-write recall validation could not run** — substituted inline content audit (all 15 episodes pass data_quality/metrics_source/integer-downloads/single-approval-tag/summary-length checks). Flagged in final output; re-run validation when recall recovers.

## Corrections to initial assumptions

- Prior: "Node's reusePort works on macOS" → **WRONG**: Node docs list Linux 3.9+/FreeBSD/DragonFlyBSD/Solaris/AIX; macOS raises an error on unsupported platforms. Corrected in P2.
- Prior: "listen callback handles errors" → **WRONG**: callback is a 'listening' listener only (net.md). Corrected in P1/P4.
- Prior: "no third-party rule exists for the invariant class" → **PARTIAL**: `require-stream-error-handler` (eslint-plugin-node-security) exists for `.pipe()` (CWE-248) but NOT for `.listen()` — custom rule still required for listen.

## Process failure classifications

1. **Data-entry error** (not process): typescript-eslint episode initially wrote `weekly_downloads: 0` for an uncollected metric — fixed to `—` via `memory_update` after self-audit. Lesson: verify every metric line against an actual call result before write.
2. **Provider availability** (not formulation): 2 google hitl events; substitution noted.
3. **Self-feedback (recurring)**: I batch-verified at the END of the run and hit the recall degradation after writes. Next run: run post-write validation immediately after the FIRST write batch while the service is known-good. Also: call `tripwire_status` before starting search batches to pre-flag provider issues.

## One actionable improvement for next run

Post-write recall validation must run immediately after the first `memory_write_batch` (not deferred to end-of-run), so a mid-run service degradation cannot mask a real write/index failure.

## Stopping criterion

Zero process failures in findings themselves (one data-entry slip caught and fixed). One operational failure (recall degradation) reported, not silent. LOW-confidence/unresolved items: none — all flagged claims are MEDIUM (exit-0-already-running convention; postgres/docker/electron behavior) and are explicitly labeled in the episodes. Logged as complete-with-caveats.
