# STATE — store-reclaim (resumable runtime)

**This file is the resumable state.** A fresh executor session starts here: read `current_state`, then
`contexts/<current_state>.md`, do the work, run the guard, commit by explicit pathspec, update this file,
stop at the boundary. `DESIGN.md` is the authoritative design; do not re-derive it.

```yaml
schema: plan-state-machine/v1-light
plan: store-reclaim
repo: sox-ecosystem
design: docs/plan/store-reclaim/DESIGN.md
current_state: null          # NOT STARTED — gated by Q2
entry_blocked_on: [Q2]       # resolve the Turso-version question before dispatching S1
last_updated: 2026-09-30
authored_by: architect (deepseek-flash)
```

## Objective

Reclaim leaked FTS orphan-segment pages automatically, safely, and unattended, on the **memory** and
**backlog** Turso 0.7.1 stores, **packaged with one properly-expiring backup mechanism**. Full design:
`DESIGN.md`. The mechanism already exists offline (`rebuildStoreOffline` → `VACUUM INTO`); this plan adds the
policy, the crash-safe lock, the two-phase trigger, the memory + backlog bindings, and the expiry half.

## Segment status

| State | Segment | Status | Guard | Deps |
|---|---|---|---|---|
| `s1-reclaim-engine` | Reclaim engine (store-adapter) | **pending** (blocked on Q2) | `npx nx test store-adapter` green in isolated worktree | — |
| `s2-memory-policy` | memory policy binding | pending | `npx nx typecheck memory-core` + unit spec green | s1 |
| `s3-live-builder` | two-phase trigger: live builder | pending | builder spec green; no watchdog kill | s1,s2 |
| `s4-gated-swapper` | gated swapper at controlled stop | pending | swap refuses on `source_changed`/peer/`-wal`; succeeds when quiesced | s3 |
| `s4_5-quiesce-barrier` | write-quiesce barrier (optional zero-downtime) | pending (gated by Q6) | barrier spec green; no write lost | s4 |
| `s5-cli-verb` | memory CLI report verb | pending | `memory fts-rebuild --dry-run` prints report | s2 |
| `s6-expiry-hook` | reclaimer post-swap expiry hook | pending (**serialize with s8**) | `StoreReclaimReport.retention` populated | s1,s8 |
| `s7-backlog-binding` | backlog binding (CROSS-REPO, B1) | pending (blocked on B1) | `adhd-backlog store-reclaim --dry-run` reports | s1 |
| `s8-backup-expiry` | backup expiry (age + companion-atomic + never-expire) | pending | `1dd4c870` orphan test green; never-expire survives | s1 |
| `s9-docs-adr` | docs + ADR-0026 **proposal** | pending | docs updated; ADR-0026 proposed (not written) | all |
| `s10-persistence` | this plan dir | **done** (this file) | plan files committed by pathspec | — |
| `audit-mid` | hold point after s1–s4_5 | pending | audit script green | s4_5 |
| `audit-final` | DoD-proving audit | pending | every `[dod.N]` PASS | all |

## Serialization / file-reservation constraints (enforce at dispatch)

- **s3_live-builder / s4_gated-swapper / s4_5-quiesce-barrier / s5-cli-verb** touch overlapping
  memory-server files → **SERIALIZE**, never dispatch in the same wave.
- **s6-expiry-hook ↔ s8-backup-expiry** share the `RetentionResult` type → **SERIALIZE**.
- All other segments are disjoint by file set and may run in parallel (respecting `Deps`).

## Acceptance criteria (per segment — the guard is red→green)

- **s1** — leaked fixture ⇒ `reclaimed` with `after.file_bytes < before.file_bytes`; below-threshold/throttled
  ⇒ `skipped`; lock held ⇒ `refused/lock_held`; dead-pid lock stolen. New test names the new engine id.
- **s2** — `countMemoryLiveNodes` equals `SELECT COUNT(*) FROM node WHERE t_invalid IS NULL`; policy maps
  `StoreGrowthConfig`; `memoryReclaimPolicy` returns the documented defaults.
- **s3** — a live build produces `<db>.rebuild-<ts>` + identity sidecar while the server serves; the build
  completes without a watchdog kill (`5b29f533`).
- **s4** — swap refuses `source_changed` when a write landed between build and swap and the write survives
  (`e92196e2`); refuses `not_quiescent` with pids; succeeds when quiesced; clears `reclaim_owed`.
- **s4_5** — typed `quiesceForSwap()`; the swap runs with the process alive; no write lost. **Gated by Q6.**
- **s5** — `memory fts-rebuild --dry-run` prints a `StoreReclaimReport`.
- **s6** — `StoreReclaimReport.retention` populated on a successful swap; `protectedRefs` honored.
- **s7** — `adhd-backlog store-reclaim --dry-run` reports against the real store; refuses when a `serve`
  process holds it. **Blocked by B1.**
- **s8** — rotation+expiry leaves **no orphaned companion** (`1dd4c870`); never-expire set survives
  `retentionCount=1`/`maxAgeMs=0`/`maxTotalBytes=0`; crash ordering leaves no stranded companion; gauge
  exposes `expired_count`/`oldest_backup_age_ms`/`total_backup_bytes`.
- **s9** — `DESIGN.md §15` doc table landed except the two excluded docs; ADR-0026 **proposed** to the owner,
  **not written**.
- **s10** — plan files exist + committed by pathspec.

## Blockers

- **B1 — BLOCKER (Segment 7 only): the backlog half is cross-repo.** The backlog tool is at
  `/Users/nix/dev/node/adhd/entrypoint/backlog/` (package `@adhd/backlog` v1.0.6, `package.json:2-6`), **not**
  in `sox-ecosystem`. Segment 7 cannot run here; the adhd repo must consume the new
  `@adhd/sox-store-adapter` engine (published bytes vs workspace resolution to confirm).

## Open questions (unresolved — do not proceed past their gates)

- **Q2 — PROMINENT, may invalidate the whole design (external; needs `researcher`).** (a) Does any Turso
  version past 0.7.2 fix the FTS orphan-segment leak? (b) Is `VACUUM INTO` from a live reader safe
  *specifically for the vec0/FTS store*? The design assumes **no** to (a) and pins
  `FTS_OPTIMIZE_LEAK_MEASURED_ON='0.7.1'` (`store-rebuild.ts:128`; upgrade-gated by
  `fts-optimize-leak-gate.bl-c5249cdd.spec.ts`). **Resolve before dispatching Segment 1** — if (a) is yes,
  the reclaim collapses to a version bump.
- **Q6 — gates Segment 4.5.** The write-quiesce barrier introduces a memory-server pause; it must not violate
  `[contract:signal]` (SIGTERM drains within `stop_timeout_ms`) or the `SHUTDOWN_SAFETY_NET_MS=4000` budget
  (`backend.ts:156`). Needs the service-lifecycle owner's sign-off; if refused, fall back to §5.5.2
  (identity-guarded retry + idle-gated restart) — the design degrades cleanly.
- **Q3 —** memory self-restart UX: idle-gated auto-restart vs explicit `soxe service reclaim`. Less critical
  if Q6 lands (no restart needed).
- **Q5 —** `1dd4c870` ↔ `b1ac8ebd`: read both bodies before relating/moving the 342 MB observation
  (`DESIGN.md §15` recommends `1dd4c870` as home).

## ADR proposal

`docs/decisions/0026-<slug>.md` is **PROPOSED — do not write without owner approval** (next sequential
number = max existing `0025` + 1). It must cite the **P7 topology correction** (the backlog *store* is **not**
reached through the service-proxy funnel today — ADR-0015 is PROPOSED/unbuilt; embeddings funnel is live but
compute-only) so a future reader does not design against an assumed store funnel. Owner approval is required
before the file is written; the ADR revision loop governs any later edit.

## Anchor gaps (unverified — confirm before the owning segment executes)

- **`memory-cli/src/index.ts` fts-rebuild verb exact line** — the verb exists (spec
  `fts-rebuild-cli.bl-c5249cdd.spec.ts` is present in the package); the exact defining line was **not read**
  this session. Confirm before Segment 5 edits that file.
- **`embedding-provider` build/test note** — the package `AGENTS.md` refers to a package-local `BACKLOG.md`
  (deprecated per ADR-0011); ignore that reference — it is stale prose, not an anchor this plan relies on.
- Every other `file:line` in `DESIGN.md` was read this authoring session. If any is found wrong at execution,
  file it (via `backlog-operator`) and correct the context — do not silently deviate.

## Transition log

```jsonc
[
  { "ts": "2026-09-30", "state": "s10-persistence", "event": "authored",
    "note": "Plan dir authored from the consolidated design (DESIGN.md §0–§16). No code, no other files touched.",
    "by": "architect (deepseek-flash)" }
]
```
