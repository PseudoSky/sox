# Research trace — WAL/`-shm`/`-tshm` sidecar ownership + deterministic multiprocess race testing

- Date: 2026-09-30
- Agent: researcher (OpenCode host)
- Generalized problem: multi-process embedded DB engine with WAL + shared-memory coordination sidecars; a read-oriented open that must take a native-writable handle MINTS/initialises the coordination sidecar even though the open is read-only; a later cleanup may delete the sidecar.
- Run status: **INCOMPLETE — blocked at the memory-write step** (see "Blocker"). Research itself completed; filing did not.

## Phase 0 baseline → Phase 6 result

| Metric | Baseline | Result | Delta | Target | Verdict |
|---|---|---|---|---|---|
| Search terms executed | 0 | ~22 | +22 | >=9 | PASS |
| Phases completed (0–7) | 0 | 8 | +8 | 8 | PASS |
| Tools approved/blocked | 0 | 8 catalogued; **1 filed** | +1 filed | >=3 | PARTIAL (catalogue complete, filing blocked) |
| Confidence-labeled claims | 0 | 6+ | +6 | >=1 | PASS |
| Sources verified per approved tool | 0 | >=2 (Whopper README + repo + Elle integration) | — | >=2 | PASS |
| Rate limit / block events | 0 | 0 search; **1 memory-write block** | +1 | <=2 | PASS |

## Promotion gate

- >=3 search terms returned useful results: **YES**
- >=2 tools found: **YES**
- <=3 rate-limit/block events: **YES**
- **Run flagged `INCOMPLETE`** — not because of search, but because the memory-write path failed mid-catalog (below). Per agent rules a run whose backing store call failed is never presented as complete.

## Blocker (exact error)

`memory_write` succeeded once (Whopper episode `01M3TQ3BBN91JQBRY8GED8QC03`), then failed deterministically on the next two identical calls:

```text
{"code":"E_IO","message":"[BUG-MEMORYCORE-MULTIPROCESS-WAL-NOT-OPTED-IN-001] multiprocess WAL was mandated for \"/Users/nix/.memory/memory.db\" (ADR-0012) but the \"-tshm\" coordinator sidecar did not appear after open — the driver did not enable the mandated cross-process WAL coordination. Refusing to proceed unverified.","retryable":false}
```

- `memory_ping` at session start: `ok:true, status:ok, store_ok:true`, `wal_mode: multiprocess-wal`, but **enrichment 'stalled'** and `in_flight:0`.
- Diagnosis: the store's write path degraded between the 1st and 2nd write; the mandated `-tshm` coordinator sidecar was not present at reopen, so the engine refuses further writes. `retryable:false` → not a retry case.
- Action taken: exactly one confirmation retry (both failed identically) → **STOP**. No fallback store was used (none exists; reaching the store by any other route is prohibited). All un-filed finding content is delivered inline in the session report so no work is lost.

## Process-failure classifications

1. **Tooling/block (not a research failure)** — the memory MCP write path failed mid-run; outcome is `BLOCKED`, reported plainly.
2. **Source selection / search formulation** — the brief's named tools `PFX` and `REPLAY` did **not** resolve to any real concurrency-testing framework (`PFX` → stevana deterministic-scheduler + Postfix mailing-list false positives; `REPLAY` → no named tool). Corrected by substituting the verifiable equivalents: deterministic record-and-replay (rr / PinPlay / DeLorean / CARE) + Elle model checking. Treat caller-supplied tool names as hypotheses, not ground truth.
3. **Unverifiable claim** — the caller's exact strings `coordination map magic mismatch` and `coordination file smaller than header: got 0, minimum 4096` could not be located in any public source (GitHub code search returned `empty`; DDG exact-phrase returned `empty`). Reported as LOW-confidence / unverified, not asserted.

## What worked

- Primary-source-first: reading the SQLite WAL-format doc and the Turso multiprocess-access doc in full yielded the precise invariants (last-closer semantics, recovery-by-first-connection, advisory read-only fallback).
- Searching the engine's own issue tracker surfaced the exact hazards: #8536 (empty WAL + leftover `-tshm` bricks open), #6454 (cross-engine TRUNCATE corrupts the frame cache), #7833 (cross-process TRUNCATE invalidates a live reader snapshot).
- Finding Turso's own Whopper concurrent simulator gave a ready-made, seed-replayable harness pattern for RQ3.

## What failed

- Exact-string location for the caller's error text (unauthenticated GitHub code search cannot do reliable exact-phrase matching).
- `PFX`/`REPLAY` as named tools.

## One actionable improvement for next run

Add a **pre-flight store-health gate**: before Phase 5, issue one throwaway `memory_write` + `memory_recall` probe; if the write path refuses (`E_IO`), skip straight to inline delivery instead of discovering the block after the catalogue is built. Also: re-ping specifically when `enrichment: stalled` is reported at Phase 3, since that state preceded the write-path refusal here.

## Corrections to initial assumptions

- Assumed `mode=ro` alone is side-effect-free on a WAL DB — false; only `immutable=1` avoids creating/reading sidecars. `mode=ro` still needs a writable directory and a `-shm` (SQLite docs + forum).
- Assumed the docs' "a reader in one process cannot be invalidated by a writer in another" (Turso) is an invariant — false; #7833 is an open bug that reproduces its violation.
