# Context 06 — dispatch shards

Decomposition of `README.md` HF-1…HF-6 into self-contained shards sized for a small
executor (flash). Each shard lists exactly what to touch, the acceptance bar, the gate
command to prove it, and its dependency. **Read `README.md` + `../_shared/{RULES,CONTRACTS,
PROTOCOL}.md` + ADR 0007 first.** Log every shard to `./progress.json` (set the matching
`items[].status`/`evidence`).

## Preconditions (met as of 2026-07-04)

- Contexts 01–05 gates `passed` + merged to main.
- memory-core `232 pass / 1 skip`, memory-server `82 pass`, embedding-provider/memory-flush/
  host-runtime green, smoke `16/0`. Committed: `a4023c3` (embed finalize + stabilization),
  `e87369e` (BL-155 bundle fix).
- Known live gap for HF-5: **BL-156** — the launchd unit runs direct-stdio (unreachable);
  HF-5 forensics must account for both the per-session `soxe serve` process and the
  launchd daemon when counting writers.

## Dispatch table

| Shard | Items | Owner | Files (disjoint) | Depends on |
|---|---|---|---|---|
| S1 | HF-1 chaos suite | flash | `libs/memory-core/src/chaos/**` (NEW), CI config | preconditions |
| S2 | HF-2 soak harness + metrics exporter | flash | `libs/memory-core/src/soak/**` (NEW), `_shared/baselines/` (read) | preconditions |
| S3 | HF-3 recall score legibility | flash | `libs/data/search/hybrid-search/src/**`, `libs/memory-core/src/recall.ts` | preconditions |
| S4 | HF-4 lifecycle ops (compaction/quota/backup) | flash | `libs/memory-core/src/{compaction,quota,backup}.ts` (NEW) + `index.ts` exports | S1 merged (both new-code in memory-core; avoids spec-file races) |
| S5 | HF-5 forensics | **integrator** | `REPORT.md` only (read-only on system) | S1–S4 merged |
| S6 | HF-6 closeout | **integrator** | `docs/decisions/0007-…md` (status line), `BACKLOG.md`, `*/progress.json`, `REPORT.md` | S5 done |

**Integrator-retained (do NOT sub-dispatch):** HF-2 threshold *selection* (S2 builds the
harness + exporter and a degraded-run control; the integrator picks the pass/fail budgets
from `_shared/baselines/write-perf.json`), HF-5 (owner machine), HF-6 (final judgment).

**Parallelism:** S1 ∥ S2 ∥ S3 (disjoint file sets). S4 waits on S1 (both add new memory-core
modules; sequencing avoids `index.ts` export-merge races). Pre-commit: run
`npx nx affected -t lint` across changed projects before each merge.

---

## S1 — HF-1 chaos suite (flash)

**Goal:** a default-running chaos suite proving the write path survives adversarial faults.

**Implement** (new `libs/memory-core/src/chaos/*.chaos.spec.ts`, driven by the WriteQueue +
lease + pragmas from context 01/03):
1. **kill -9 mid-write-burst → recovery.** Spawn a child that opens the store and issues a
   write burst; `SIGKILL` it mid-burst; reopen → `PRAGMA integrity_check` returns `ok`, WAL
   replays, the writer lease is re-acquired by the next opener (SA-8 `closeDbWithLease` /
   stale-lease recovery).
2. **disk-full → structured `E_IO`.** Constrain the DB (`PRAGMA max_page_count` to just above
   current size) → the next write fails with a CONTRACTS §B `E_IO`-class error, store stays
   integrity-clean (no half-written node/vec/fts).
3. **queue overflow → `E_BUSY` backpressure.** Flood `WriteQueue` past `_maxSize` → enqueue
   rejects with the `E_BUSY` shape (`retryable:true`, `retry_after_ms`), no lost/duplicated
   committed writes.

**Negative controls (NC required):** each scenario must go RED when its guard is removed —
e.g. disable WAL → recovery assertion fails; remove the max_page_count guard → E_IO assertion
fails. Encode the NC as a documented, skipped `it` or a commented toggle in the spec header.

**Acceptance:** suite green 3× consecutively (`--skip-nx-cache`); every assertion demonstrably
reachable. **Gate:** `npx nx test memory-core --skip-nx-cache` (×3).

**Do not touch:** recall.ts, hybrid-search, os-unit, extension manifests.

---

## S2 — HF-2 soak + metrics exporter (flash; thresholds are the integrator's)

**Goal:** an extended concurrency soak that exports the metrics needed for SLO gating, plus a
degraded-run control that proves the gate can fail.

**Implement** (new `libs/memory-core/src/soak/**`, reusing context-01's concurrency harness at
a longer profile):
- Export per-run metrics: lock-wait, txn-duration histogram, queue depth, checkpoint age,
  write p50/p99. Emit as JSON to a run artifact.
- Add a **degraded-run env flag** (e.g. `SOX_SOAK_INJECT_TXN_DELAY_MS`) that injects artificial
  per-txn delay — the control the integrator uses to prove the threshold has teeth.
- Provide a comparison helper that reads `_shared/baselines/write-perf.json` and computes
  pass/fail against a budget **passed in** (leave the budget numbers as a parameter/TODO for
  the integrator; do NOT hardcode final thresholds).

**Acceptance:** soak run completes green and writes the metrics JSON; the degraded run
(flag set) produces metrics that a sample budget would reject (demonstrated in a test).
**Gate:** `npx nx test memory-core --skip-nx-cache`.

**Do not touch:** chaos specs (S1), recall.ts, lifecycle modules (S4).

---

## S3 — HF-3 recall score legibility (flash)

**Goal:** make `memory_recall` scores interpretable across dissimilar queries **without**
breaking the existing `score` field.

**Implement** (`libs/data/search/hybrid-search/src/**` for the fusion breakdown,
`libs/memory-core/src/recall.ts` to thread it into results):
- Add an **additive** `score_breakdown` per result: per-channel contribution (vec / BM25 /
  temporal-recency-importance) that sums consistently to the fused score, plus a per-query
  normalization so two very different queries are comparable. Keep `score` byte-compatible.
- Design note in `REPORT.md` (formula, normalization choice).

**Acceptance:** in test, channel breakdown sums to the reported fused value within tolerance;
normalized scores for two very different queries are on a comparable scale. **Gate:**
`npx nx test hybrid-search memory-core --skip-nx-cache`.

**Do not touch:** chaos/soak/lifecycle modules; the MCP tool schema shape (additive only).

---

## S4 — HF-4 lifecycle ops (flash; after S1)

**Goal:** the remaining store-lifecycle operations.

**Implement** (new `libs/memory-core/src/{compaction,quota,backup}.ts`, wired through
`index.ts` + the relevant `memory_*` handler):
- **Scheduled compaction/ANALYZE tick** — periodic `PRAGMA optimize`/`ANALYZE` +
  `wal_checkpoint(TRUNCATE)` on an idle cadence (coordinate with the WriteQueue idle
  checkpoint so they don't fight).
- **Per-store size quotas** — soft threshold → structured warning; hard threshold →
  `E_IO`-class structured refusal on write (never a raw throw, never corruption).
- **`memory_backup`** — `VACUUM INTO` a target path (inside the `~/.memory/**` allowlist);
  the copy must open and pass `integrity_check` even when taken under write load.

**Acceptance:** backup-under-load produces an openable, integrity-clean copy; soft/hard quota
tests pass; NC required (remove the hard-quota guard → over-quota write test goes red).
**Gate:** `npx nx test memory-core --skip-nx-cache`. If a new `memory_*` tool/param is added,
also `npx nx build memory-server && npx nx run registry:sync-index` and commit the regenerated
`registry/index.json`.

**Do not touch:** chaos (S1), soak (S2), recall/hybrid-search (S3).

---

## S5 — HF-5 forensics (integrator, owner machine, READ-ONLY)

`ps`/`lsof`/`memory_ping` forensics proving exactly one writer per store under the final
posture. **Account for BL-156:** both the per-session `soxe serve` stdio process and the
launchd daemon may match the entrypoint token — distinguish them by owner (session vs
os-unit) and confirm only one holds the writer lease. Never kill. Transcript → `REPORT.md`.

## S6 — HF-6 closeout (integrator)

Flip ADR 0007 Status → ACCEPTED (one line). Sweep BACKLOG BL-118…156 statuses to match
reality with evidence pointers (note BL-151…155 resolved this cycle; BL-156 open). Confirm
every context's `REPORT.md` exists. Delete merged `runtime-prod/*` branches.
