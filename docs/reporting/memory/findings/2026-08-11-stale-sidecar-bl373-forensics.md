# BL-373 family — permanent solve implementation + Aug-11 forensic attribution

> Written 2026-08-11 because the live memory server is DOWN (stale WAL-index sidecar, BL-373) and
> the memory MCP write failed with exactly the pre-fix decline text: "the WAL … holds 206032 bytes,
> so the sidecar may legitimately describe it" — the incident, verbatim, from the deployed bundle.
> This file is the durable resume point for the fix (branch `fix/bl373-sidecar-staleness`).

## What shipped (fix/bl373-sidecar-staleness, store-adapter)

1. **`recoverStaleWalIndex` mtime heuristic** (integrity.ts): after `walBytes > 0`, stat both files;
   `ageDiff = walMtimeMs − tshmMtimeMs`; **stale** ⇔ `ageDiff > THRESHOLD_MS`
   (`SOX_WAL_SIDECAR_STALE_THRESHOLD_MS`, default 60 000, fixed not proportional) → move ONLY `-tshm`
   aside (never `-shm`), `attempted: true`. **Ambiguous** (0 ≤ diff ≤ threshold, or negative) → no
   move; run the frame probe; decline with evidence (sidecar mtime, WAL mtime, diff, threshold,
   probe result). Empty-WAL path unchanged (moves both `-tshm` and `-shm`).
2. **`probeWalFrames(walPath)`** — read-only: magic 0x377f0682/83 (either endianness), page size u32@8
   power-of-two 512..65536 (invalid ⇒ `readable:false`), `leftover = (size−32) mod (24+pageSize)`;
   **truncated ⇔ leftover ≠ 0**. `leftover === 0` (Shape A) is never corruption evidence.
3. **`recoverTruncatedWal(dbPath)`** — WAL → `-wal.corrupt-<stamp>` (rename, preserved) only when
   probe-truncated AND orphan-stale (`dbMtime − walMtime > threshold`) AND `SOX_ALLOW_AUTO_WAL_ASIDE=1`;
   otherwise a typed decline naming the exact operator action.
4. **`warnIfStaleSidecar` + `'sidecar_stale'` event** — called from `connect()` before the open and
   after a successful open (the masked case); two statSync calls, never throws.
5. turso-adapter open-time catch: sidecar-first → reopen against the existing WAL → only a still-
   failing reopen on a probe-truncated WAL may move the WAL (with the opt-in); otherwise
   `describeStaleWalIndexFailure` carries the probe and names both actions (`-tshm` and `-wal.corrupt`).

## Round 2 (owner requirements A + B, same branch) — 2026-08-11

### A. PING HONESTY — memory_ping never reports healthy when the write path is dead

The incident's health-check false positive: `memory_ping → { ok:true, status:'ok', store:null }`
while every write failed — `status` was derived ONLY from embed health
(`embedHealth.state === 'real' ? 'ok' : 'degraded'`, old bundle index.ts:1136) and ignored the
store block. Fixed:

- **`computePingHealthVerdict`** (NEW, `libs/memory-core/src/ping-health.ts`, pure): takes
  `{storeOpened, storeError, embedState, embedError}` → `{status, status_reason, store_ok,
  store_error}`. `status` is `'ok'` ONLY when store open AND embed real; a store that failed to
  open is **`'unhealthy'`** (stronger than the old embed-only `'degraded'`) with the open-failure
  reason; store-healthy + embed-degraded stays `'degraded'` (the two dimensions never collapse).
- **Bundle wiring** (memory-server index.ts): the store block captures `storeOpenError` (catch
  detail — the stale-sidecar open failure lands here verbatim) and `storeOpened` (set only after
  the probe queries succeed; a poisoned connection throws out of `executeGet` through the
  reconnect path and lands in the catch → `storeOpened` stays false); the response now carries
  `status`, `status_reason`, `store_ok`, `store_error`. `ok:true` keeps its RPC-success meaning
  for all 20 tools (unchanged contract); the docstring no longer claims `{ok:true}` is a health
  guarantee. Poisoned-mid-session (the 19:31:11 case) surfaces automatically: the ping's own
  queries flow through `_ensureHealthy` → the D6-fixed `_reconnect()` either heals (verdict ok)
  or throws (verdict unhealthy) — no extra probe needed, ping stays cheap.
- The `configured:false` (BL-412 bare-process) and absent-store-file cases now carry explicit
  `store_error` reasons and read `unhealthy` (a process that can resolve no store serves no writes).

### B. ROOT CAUSE — the mechanism, confirmed by scratch repro, and PROACTIVE reconciliation

**Confirmed mechanism (scratch repro, 2026-08-11, temp store under multiprocess WAL):**

1. Crash-kill of a Turso process (no close): the `-tshm` mtime FROZES at death, but the WAL stays
   consistent with it → the next Turso open SUCCEEDS. Crash alone does not break the store.
2. **A better-sqlite3 (stock-SQLite) writer** on the same store: opens in WAL mode, writes,
   closes → the clean close **checkpoints and DELETES the `-wal` and `-shm`** while the `-tshm`
   survives **untouched** (mtime frozen — the stock engine never maintains it). The db moves
   past the sidecar's epoch.
3. The next Turso open: frozen `-tshm` over a moved/deleted WAL →
   `I/O error: short read on WAL frame at offset 774592: expected 4096 bytes, got 0` — the
   incident error, reproduced from a scratch store.

So: **the `-tshm` is maintained only while a Turso driver connection holds the store; any
non-Turso writer moves the WAL without the sidecar, and the next Turso open dies.** The forensic
smoking gun: live `memory.db-shm` is FRESH at 19:31:29 while the `-tshm` froze Aug 4 — Turso under
multiprocess WAL never creates `-shm`; only a stock-SQLite opener does. The Aug-11 19:31:29 shm+wal
touch was a better-sqlite3/stock-SQLite writer on the live Turso store, exactly matching this
mechanism. The pre-`recoverStaleWalIndex` era had no defence; D6's catch heals AFTER a failed
open; the owner's point stands — detection is not prevention.

**Proactive reconciliation** (`proactivelyReconcileStaleSidecar`, integrity.ts; wired in
turso-adapter.ts connect BEFORE `openOnce()`): the mtime-proven stale `-tshm` is moved aside
before the driver even tries, so the failed-open path is never taken. Staleness reference: the
WAL's mtime, or the **db file's** mtime when the WAL is gone (the mixed-engine deleted-WAL
variant). The `-shm` is NEVER touched pre-open (self-reconciling; moving it under a concurrent
multiprocess-WAL reader is corruption — the empty-WAL branch that moves it stays in the catch).
The catch remains as the backstop for races and non-mtime shapes. multiprocess WAL stays ON
(ADR-0012, owner directive).

**Future unhandled scenarios** (whole-class reasoning):
- (i) crash-kill: sidecar freezes but stays consistent → next open succeeds (probe); if the WAL
  later moves, proactive reconcile clears the frozen sidecar pre-open.
- (ii) epoch change without close (checkpoint/restart): same — mtime-stale → proactive move.
- (iii) concurrent opens (multiprocess WAL): proactive never touches `-shm`; a live connection's
  WAL exists (fresh mtime) → ageDiff ≈ 0 → no pre-open move while a writer holds the store; the
  empty-WAL `-shm` move stays in the catch, which only runs when the open actually failed.
- (iv) a new driver version changing sidecar semantics: the mtime heuristic is engine-agnostic
  (fs facts); a version that no longer fails on stale sidecars simply makes the proactive move a
  harmless no-op-visible (sidecar preserved aside); a version that fails differently still hits
  the catch → typed operator-action error (D6) → never silently healthy.
- (v) stale sidecar AND genuinely truncated WAL (Shape B): proactive moves the sidecar; if the
  reopen still fails, `recoverTruncatedWal` (probe-truncated AND orphan-stale AND
  `SOX_ALLOW_AUTO_WAL_ASIDE=1`) moves the WAL with a data-loss disclosure; without the opt-in the
  operator gets the typed action — and memory_ping reports `unhealthy` (Requirement A closes the
  loop: an unhandled store is never reported healthy).

**Ping verdict shape (final):** `{ ok, status: 'ok'|'degraded'|'unhealthy', status_reason,
store_ok, store_error, instance, store, embed, …legacy keys }`.

**Red→green (BL-225, round 2):** proactive tests RED on 44398c5c (the D6 commit — first open
fails, "blocked the open" event fires) and GREEN on the fix (first open succeeds, no failed-open
path, event stream proves the catch never ran). Ping-verdict: the old formula yields `status:'ok'`
on the incident inputs (the false positive, verbatim from 04414dca index.ts:1136); the new helper
yields `unhealthy`/`store_ok:false`. Suite: store-adapter 417/417, memory-core 672/8, bundle
typecheck+lint clean. Smoke test deferred post-merge (deploy guard).

## Empirical driver facts (probed 2026-08-11, @tursodatabase/database 0.7.x)

- **No `-shm` under multiprocess_wal** — only `-tshm`. Tests fabricate an empty `-shm` to assert
  the mtime path never touches it.
- Plain `close()` leaves a **non-empty WAL**; `wal_checkpoint(TRUNCATE)` empties it.
- A sidecar whose frame-index describes MORE frames than the WAL holds → open fails with
  "short read on WAL frame at offset N". A content-consistent sidecar with a backdated mtime
  **opens fine** — the masked case.
- A truncated WAL with **no** sidecar opens fine (driver scans to the truncation); the reopen
  after sidecar-move therefore never fails on this driver → the auto-WAL-aside is defensive,
  tested at the `recoverTruncatedWal` unit level.
- The pre-fix decline was confirmed live: the running memory MCP server (bundled pre-fix code)
  refused to open its own store with "the WAL … holds 206032 bytes, so the sidecar may
  legitimately describe it".

## Forensic attribution (READ-ONLY, 2026-08-11)

| Artifact | Size | mtime | Notes |
|---|---|---|---|
| `memory.db` | 117 555 200 | 2026-08-11T19:27:42Z | last db write (checkpoint) |
| `memory.db-wal` | 206 032 | 2026-08-11T19:31:29Z | **50 frames, ckptSeq 1500, salts 4051376569/261393945, leftover 0 — Shape A** |
| `memory.db-tshm` | 86 016 | **2026-08-04T19:16:51Z** | frozen 7 days; header `TSHMWAL` v1 identical to both preserved stale sidecars |
| `memory.db-shm` | 32 768 | 2026-08-11T19:31:29Z | fresh — shm self-reconciles |
| `-tshm.stale-2026-08-01-2347` | 86 016 | 2026-08-01 | recurrence 1 |
| `-tshm.stale-2026-08-03-2104` | 86 016 | 2026-08-03 | recurrence 2 |
| `-shm.stale-2026-08-01-2347` | 32 768 | 2026-08-01 | old code moved shm on the empty-WAL path |
| openmark | — | ABSENT | no successful open since Aug 4 |

**Verdict:** the WAL was **never truncated** — frame-aligned 50 frames (Shape A). The defect is
entirely the **frozen sidecar**: it stopped being maintained at Aug-4 19:16:51Z while the WAL
crossed ≥1 epoch change. The 19:31:29Z shm+wal mtime pair (4 ms apart, tshm untouched) is
consistent with a failed fresh open (driver touches shm+wal, short-reads against the stale
sidecar, never reaches sidecar maintenance) — exactly the incident mechanism. `VACUUM INTO`
(backupTo) writes only to the destination and is not implicated. What froze the sidecar —
service restart on/after Aug 4 vs. a multiprocess-WAL coordination gap where a second opener
rotated the WAL without sidecar convergence — is **(unverified)**: needs process/launchd logs
from the Aug-4..Aug-11 window.

## Red→green (BL-225)

`bl373-red-demo.test.ts` (harness, not shipped): the same two regression assertions — a 7d-stale
`-tshm` over a non-empty WAL must be reconciled (`attempted:true`, sidecar moved) and a mid-frame
truncated WAL beside a stale sidecar must be recovered — are **RED on 04414dca** (both decline)
and **GREEN on the fix**. Shipped suite: `wal-sidecar-staleness.bl373.test.ts` (10 tests, BL-373
family naming), store-adapter total 415/415.
