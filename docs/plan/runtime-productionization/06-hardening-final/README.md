# Context 06 — hardening, release gates, closeout

**Execute:** read `../_shared/RULES.md` → `../_shared/CONTRACTS.md` →
`../_shared/PROTOCOL.md`, then this file, then ADR 0007 (whole) and BACKLOG BL-132/133/
134. Worktree branch: `runtime-prod/06-hardening-final`. Log to `./progress.json`;
finish with `./REPORT.md`.

**Mission:** turn the fixes into permanent guarantees — chaos/soak/SLO gates in CI — and
close out the initiative so the failure classes cannot silently return.

**Depends on:** ALL other contexts' gates `passed` and merged. Verify each
`../0X-*/progress.json` before starting; if any is not passed, stop and report.

**Scope fence (may touch):** `libs/memory-core/**`, `libs/data/search/hybrid-search/**`
(score legibility), CI/workspace test configuration, the runtime-productionization plan
dir (progress/REPORT files), `BACKLOG.md` (status sweep), `docs/decisions/0007-…md`
(status flip ONLY — content changes are owner-only).

## Items

| id | BL | Work | Acceptance | NC |
|---|---|---|---|---|
| HF-1 | 134 | Full chaos suite in CI, default-running: `kill -9` the writer mid-write-burst → WAL recovery + `PRAGMA integrity_check` clean + lease re-acquired; disk-full (quota'd tmpfs or sqlite max_page_count) → structured `E_IO`, no corruption; queue overflow → `E_BUSY` backpressure | suite green ×3 in CI; each scenario's assertion demonstrably reachable | yes — per scenario (e.g. disable WAL → recovery test red) |
| HF-2 | 134 | Soak + SLO gates: extended concurrency soak (01's harness, longer profile) exporting metrics (lock-wait, txn-duration histogram, queue depth, checkpoint age, write p50/p99) with thresholded pass/fail against `_shared/baselines/write-perf.json`-derived budgets | soak green; a deliberately-degraded run (env flag adding artificial txn delay) FAILS the threshold — proving the gate has teeth | yes (the degraded run IS the control) |
| HF-3 | 132 | Recall score legibility: per-query normalization or per-channel contribution breakdown in `memory_recall` results (design note in REPORT; keep response additive — existing `score` stays) | scores comparable across two very different queries in test; channel breakdown sums consistently | no |
| HF-4 | 133 | Remaining lifecycle ops: scheduled compaction/ANALYZE tick, per-store size quotas (warning at soft, `E_IO`-class structured refusal at hard), `memory_backup` via `VACUUM INTO` | backup produces an openable, integrity-clean copy under load; quota tests | yes |
| HF-5 | — | Final invariant audit on the owner's machine: process/socket/lsof forensics (the 2026-07-03 methodology) proving exactly one writer per store under the final posture config; ping identity cross-check | forensic transcript in REPORT.md | n/a |
| HF-6 | — | Closeout: flip ADR 0007 Status → ACCEPTED (one-line edit); sweep BACKLOG BL-118..149 statuses to match reality (fix any stale ones with evidence pointers); verify every context's REPORT.md exists | sweep diff reviewed by integrator | n/a |

## Gate

The full CI gate set (HF-1 + HF-2) green ×3 consecutively on the merged main; HF-5
forensics clean; BACKLOG and ADR consistent. This gate closing IS the initiative
closing.

## Subdispatch notes

Good candidates: individual chaos-scenario implementations from your specs; the metrics
exporter; the BACKLOG sweep (mechanical, with your exact status list). Keep HF-2's
threshold selection, HF-5, and HF-6's final judgment yourself. HF-5 runs on the owner's
live machine — read-only forensics only (ps/lsof/ping), never kills.
