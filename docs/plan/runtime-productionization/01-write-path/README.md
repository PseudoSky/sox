# Context 01 — write-path hardening

**Execute:** read `../_shared/RULES.md` → `../_shared/CONTRACTS.md` →
`../_shared/PROTOCOL.md`, then this file, then ADR 0007 D5 and BACKLOG BL-118/123/124/
125/129/134. Worktree branch: `runtime-prod/01-write-path`. Log every transition to
`./progress.json`; finish with `./REPORT.md`.

**Mission:** make the memory store's write path contention-proof and its failures
structured — the foundation every other context builds on.

**Depends on:** nothing. Start immediately.

**Scope fence (may touch):** `libs/memory-core/**`,
`extensions/bundles/sox-memory-bundle/members/memory-server/**` (tool registration +
tests only), new test/harness files under those packages. Nothing else.

**Read-only references:** `libs/memory-core/src/db.ts`, `write.ts`, `update.ts`,
`memoryd.ts` (do NOT refactor enrichment here — that is context 02; you only make its
writes go through the queue mechanism where trivially possible, else leave for 02).

## Items

| id | BL | Work | Acceptance (all with exit-code evidence) | NC |
|---|---|---|---|---|
| WP-1 | 118 | Pragmas per CONTRACTS §C on every connection (`db.ts` open path); single in-process write queue (FIFO, one write connection, group commit) that all `memory_write`/`memory_update`/`memory_link`/`memory_curate` mutations route through | 20 parallel writes via real MCP clients: zero raw `SqliteError`; queue serialization proven by a test asserting write ordering under concurrency | yes — disable the queue (env flag or revert) → parallel-write test red |
| WP-2 | 124 | Error taxonomy per CONTRACTS §B: wrap ALL storage exceptions at the tool boundary; `E_BUSY {retryable, retry_after_ms}` for residual contention | grep + behavioral test: no `SqliteError` string can reach a tool result; forced-lock test (hold a writer txn from a second connection in-test) returns `E_BUSY` | yes |
| WP-3 | 125 | `memory_write_batch` per CONTRACTS §C, registered in memory-server TOOLS | batch of 10 (incl. 1 byte-duplicate) → 9 ok + 1 `ok:false, code:E_DEDUP, details.existing_uid`; one queue entry (assert via instrumentation) | yes |
| WP-4 | 129 | `client_request_id` idempotency per CONTRACTS §C (`request_ledger` table, additive migration) | same id replayed → identical result + `replayed:true`, no new node; ledger pruning covered by unit test | yes |
| WP-5 | 123 | `wal_checkpoint(TRUNCATE)` on idle tick; `wal_bytes` + `last_checkpoint_at` in stats/ping store block (CONTRACTS §H fields only — full ping rework is context 03) | after checkpoint tick, `-wal` file shrinks below threshold in test; fields present | no |
| WP-6 | 134 (skeleton) | Concurrency harness: spawns N (≥8) REAL MCP clients over the real stdio-shim/UDS path, writing concurrently while an enrichment-style writer churns; asserts zero caller-visible lock errors + p99 write latency budget (record the budget you measure ×3 headroom); must run via a single `nx` target | harness green ×3 consecutive runs | **yes — mandatory: run the harness against the pre-fix build (or with WP-1 disabled via env flag) and record it RED** |

## Gate

`npx nx run-many -t test -p <memory packages>` green; harness green ×3; harness
negative-control red recorded; no raw driver error reachable (WP-2 evidence). Capture
`_shared/baselines/write-perf.json` (CONTRACTS §K) BEFORE your first change lands, and
again after — report both.

## Subdispatch notes

Good candidates: the forced-lock and parallel-write test authoring (specify the cases);
a verifier pass before gate-flip (different negative control than yours — e.g. break
group-commit ordering instead of disabling the queue). Keep the queue implementation
itself in your own hands — it is the judgment-heavy piece.
