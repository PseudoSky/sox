# Plan — Page Reclamation for the memory + backlog stores, packaged with properly-expiring backups

**Status:** authored (execution-ready) · **Repo:** `sox-ecosystem` · **Plan slug:** `store-reclaim`
**Design body:** [`DESIGN.md`](./DESIGN.md) — the full spec (§0–§16). **Runtime:** [`STATE.md`](./STATE.md).
**Segments:** [`contexts/`](./contexts/) — one work order + audit per segment.

This is a resumable plan-state-machine plan. Any executor session reads `STATE.md` + the segment's
`contexts/<slug>.md`, does one segment, runs its guard, commits, and stops. No further design decisions are
required to execute — the design is settled in `DESIGN.md`.

## What this plan does (and does not)

**Does** — add an automatic, safe, unattended page-reclamation mechanism to the two Turso-backed stores
that leak pages (memory `~/.memory/memory.db`; backlog `~/.adhd/backlog/production/data/backlog-v2.db`),
**packaged with one properly-expiring backup mechanism**:

1. **Establishes a domain-free reclaim engine** (`store-reclaim.ts`) — policy, crash-safe single-flight
   lock, throttle — over the existing sanctioned offline rebuild (`rebuildStoreOffline`, `VACUUM INTO` via
   the adapter).
2. **Drives it two-phase** — a **live builder** (copy built with writers running, zero downtime; defeats
   `5b29f533`) plus a **short gated swap** (exclusivity fence; the `source_changed` identity guard defeats
   `e92196e2`).
3. **Replaces the count-only rotation** with a single expiry policy (`pruneBackupSets`) — count **and** age
   **and** byte ceiling, companion-atomic (checkpoint-then-rename-aside), never-expire set, observability.
4. **Binds the memory store** (memory-server composition root + CLI verb) **and the backlog store**
   (cross-repo — Blocker B1).

**Does not** — write the ADR (ADR-0026 is **proposed only**; needs owner approval); implement the ADR-0015
backlog daemon tier; edit `docs/ops/memory-server-playbook.md` or `docs/spec/*` (listed in DESIGN §15 as
separate doc updates, not part of this landing); resolve Q2 (Turso version) or Q6 (quiesce barrier).

## Definition of Done

The plan is complete only when every clause holds against the real built artifacts and the live services
(not test output). Each clause is proven by a final-audit check (`contexts/audit-final.md`).

- **[dod.1]** The reclaim engine (`store-reclaim.ts`, store-adapter) evaluates policy, takes/releases the
  crash-safe lock, and returns a typed `StoreReclaimReport`; unit tests green.
- **[dod.2]** A leaked memory-store fixture is reclaimed: `after.file_bytes < before.file_bytes` and
  `bytes_reclaimed > 0`; the existing growth alarm clears.
- **[dod.3]** The reclaim **never** drops a write: a write between build and swap yields `refused`
  `source_changed`, and the write survives (`e92196e2`).
- **[dod.4]** The long `VACUUM` runs outside any watchdog's observation; a >kill-budget build does **not**
  kill the service (`5b29f533`).
- **[dod.5]** Rotation + expiry leaves **no orphaned companion** for a backup set (`1dd4c870`).
- **[dod.6]** The never-expire set (newest verified + live rollback refs) survives expiry under
  `retentionCount=1`/`maxAgeMs=0`/`maxTotalBytes=0`.
- **[dod.7]** A non-quiescent store is **refused with pids**, never forced.
- **[dod.8]** The live memory service reports a reclaimed, alarm-clear store; the gauge exposes
  `backup_retention.{expired_count,oldest_backup_age_ms,total_backup_bytes}`.
- **[dod.9]** The live service's reported artifact hash matches the rebuilt `dist/index.js`
  (`[inv:deploy-verified]`).
- **[dod.10]** `git diff --exit-code registry/index.json` is clean; no `registry:sync-index` was run.

## Execution model

- **Parallel execution:** per segment; segments 3′/4′/(4.5)/5 are **serialized** (overlapping memory-server
  files); segment 6 **serializes with 8** (shared `RetentionResult`). Others are disjoint by file set.
- **Implementers:** one executor per segment at the tier the segment names in `contexts/<slug>.md`.
- **Review:** a `review` pass after each segment whose guard is green; `audit-*` hold points are mandatory.
- **Automatic dispatch:** **no** — the backlog half is cross-repo (B1) and two open questions (Q2, Q6) gate
  Segment 1. Hand off with the Dispatch line below.
- **Verification:** every segment runs in an isolated worktree under `.worktrees/`; `nx build/test/lint/
  typecheck` via nx targets only; `node tools/check-suite-tree-state.mjs --project <p>` quoted with results
  (BL-456); commit by **explicit pathspec**, hooks on.

## Layout

```
docs/plan/store-reclaim/
├── README.md                 ← this file (DoD, execution model, dispatch line)
├── DESIGN.md                 ← the full spec body (§0–§16)
├── STATE.md                  ← resumable runtime (current state, criteria, blockers, open questions)
└── contexts/
    ├── _shared.md            ← glossary [def:], invariants [inv:], reference patterns [ref:]
    ├── s1-reclaim-engine.md   … s10-persistence.md   ← one work order per segment
    ├── audit-mid.md          ← hold point after S1–S4.5
    └── audit-final.md        ← the DoD-proving audit
```

## How to run

The dispatcher/orchestrator reads `STATE.md` (current state), dispatches the segment's `contexts/<slug>.md`
to an executor at the declared tier, runs the segment's guard, advances `STATE.md` on green, and halts on
any non-clean gate. Start is gated by **Q2** (Turso version — resolves before Segment 1) and **B1** (backlog
cross-repo — gates Segment 7 only).

## Dispatch line

```
Resume the plan-state-machine plan at /Users/nix/dev/ai/sox-ecosystem/docs/plan/store-reclaim.
Read STATE.md for current_state, then do the work described in contexts/<current_state>.md within the
declared file reservations, honoring its Commit points. Run the segment guard, then update STATE.md
(status + timestamps + transition note) and commit by EXPLICIT PATHSPEC (never git add -A). Stop at the
segment boundary. Blockers: B1 (segment 7 cross-repo), Q2 (before segment 1), Q6 (segment 4.5).
```

> The `plan-state-machine` skill's CLI scripts (`plan-scaffold.js`, `state-transition.js`, `gap-check.js`)
> were **not run** to author this plan (this authoring session had no shell). The plan uses the skill's
> lighter documented shape (`README.md` + `STATE.md` + `contexts/`), which the skill explicitly permits
> ("Raw-file editing stays valid"). A future session may run `node "$SKILL/gap-check.js"
> docs/plan/store-reclaim` to validate mechanically and, if desired, migrate to the full `dag.json`/
> `state.json` form.
