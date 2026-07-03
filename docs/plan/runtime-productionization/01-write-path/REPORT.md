# Report: WP-3 & WP-4 — Write Path Productionization

**Date:** 2026-07-03T17:00:00Z  
**Context:** 01-write-path (worktree `.worktrees/01-write-path`)  
**Items:** WP-3 (`memory_write_batch`), WP-4 (`client_request_id` idempotency + `request_ledger`)

---

## WP-3 — `memory_write_batch` (BL-125)

**What was implemented:**

- `memoryWriteBatch` in `libs/memory-core/src/write.ts` — iterates items serially, calls `memoryWrite` per-item wrapped in try/catch for per-item error isolation.
- Memory-server handler wraps the batch call in `wq.enqueue('memory_write_batch', ...)` — one queue entry, not N.
- `WriteQueue._enqueueCount` instrumentation added for test assertions (reset via `WriteQueue.resetAllEnqueueCounts()`).
- TypeScript fix: changed `details` from `details: ... undefined` to conditional spread to satisfy TS 6.0.3.

**Test results — 5 new tests (all green):**

| Test | Status |
|------|--------|
| Batch of 10 items with 1 byte-duplicate → 9 ok + 1 E_DEDUP with existing_uid | ✅ |
| Batch routes as a single queue entry (_enqueueCount=1) | ✅ |
| Negative control: empty items array → zero results | ✅ |
| Negative control: empty content in a batch item → E_SCOPE_RO per-item | ✅ |
| Negative control: all identical items → one success, rest E_DEDUP | ✅ |

**Evidence:** `npx nx build memory-core` (pass), `npx nx build memory-server` (pass, 20 tools registered), `npx nx test memory-core` (197/198 pass, 1 skipped — same as baseline). Full suite: 197 passed.

---

## WP-4 — `client_request_id` Idempotency + `request_ledger` (BL-129)

**What was implemented:**

- `request_ledger` table: `request_id TEXT PRIMARY KEY, episode_uid TEXT NOT NULL, created_at TEXT NOT NULL`.
- `client_request_id` validation: must be string ≤128 chars, else `E_SCOPE_RO`.
- Idempotency lookup in `memoryWrite`: if `client_request_id` matches an existing ledger entry, returns `{ replayed: true, episode_uid }` — no new node created.
- Ledger inserted in the same transaction as node+vec (atomic with episode creation).
- `requestLedgerPrune(db, retentionDays)` — deletes entries older than cutoff, returns deleted count.

**Test results — 5 new tests (all green):**

| Test | Status |
|------|--------|
| Replay of same client_request_id → replayed:true, existing uid, no new node | ✅ |
| requestLedgerPrune deletes entries older than retention days | ✅ |
| Negative control: client_request_id >128 chars → E_SCOPE_RO | ✅ |
| Negative control: non-string client_request_id → E_SCOPE_RO | ✅ |
| Negative control: different content with same client_request_id → original result (replayed) | ✅ |

**Evidence:** `npx nx build memory-core` (pass), `npx nx test memory-core` (197/198 pass, 1 skipped — same as baseline). Full suite: 197 passed.

---

## Overall Test Summary

```
memory-core: 197 passed, 1 skipped, 0 failed (baseline 187/188 → +10 new tests)
memory-server: 78 passed, 0 failed
```

No regressions. The 1 skipped is a pre-existing timeout-sensitive test (same as baseline).

## Files Changed

| File | Change |
|------|--------|
| `libs/memory-core/src/write.ts` | Added `memoryWriteBatch`, `requestLedgerPrune`, `client_request_id` validation + idempotency |
| `libs/memory-core/src/write-queue.ts` | Added `_enqueueCount` instrumentation |
| `libs/memory-core/src/write.spec.ts` | 10 new tests (5 WP-3 + 5 WP-4) |
| `docs/plan/runtime-productionization/01-write-path/progress.json` | Updated `updated_at`, filled WP-3/WP-4 evidence |
| `BACKLOG.md` | Added BL-125 (FIXED), BL-129 (FIXED) |

## Backlog Items Closed

- **BL-125** (`memory_write_batch`): memoryWriteBatch implemented with per-item error capture; 5 tests, 197/198 pass.
- **BL-129** (`client_request_id` idempotency): request_ledger + validation + prune; 5 tests, 197/198 pass.
