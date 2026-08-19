/**
 * bug018-shutdown-budget-headroom.spec.ts — BUG-018.
 *
 * ROOT CAUSE (diagnosed live, not guessed — see the citation trail in
 * BUG-018's own backlog notes for the full repro transcript):
 *
 * `coordinatedShutdown`'s three BEST-EFFORT, discardable step budgets —
 * step 0 (`SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS`), step 1
 * (`SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS`), and step 3
 * (`SHUTDOWN_BACKUP_TIMEOUT_MS`) — summed, BEFORE this fix, to a value that
 * left ZERO real headroom under `SHUTDOWN_SAFETY_NET_MS` for the ONE step in
 * the sequence that is both durability-critical AND deliberately unbounded:
 * step 2, `closeAllAdapters()` (the real `PASSIVE` checkpoint +
 * quiescence-gated `TRUNCATE` — the exact ceremony BUG-018 is about).
 *
 * `SPEC-BL-472.md` Decision D1 already measured this arithmetic and
 * KNOWINGLY accepted it: "750 + up-to-1000 (TERMINATE_GRACE_MS) +
 * up-to-2500 (backup) already sums to 4250, i.e. tighter than 4000 in the
 * worst theoretical case — which is fine, because the safety net exists
 * precisely to force-exit exactly that pathological case cleanly." That
 * reasoning conflates "not a crash" with "durability preserved" — an
 * `exit(0)` fired by the safety net WHILE `closeAllAdapters()`'s
 * `await this.executeAll('PRAGMA wal_checkpoint(TRUNCATE)')` is in flight is
 * NOT clean: it is the literal skipped-ceremony failure mode BUG-018 was
 * filed to describe. And it is not merely theoretical: reproduced live with
 * THREE real concurrent backend processes racing real fastembed/CoreML
 * contention (the exact BL-331-documented "25-50x embed latency" hazard) —
 * `closeAllAdapters()` alone cost up to ~925ms end-to-end
 * (`t+1677.7ms` -> `t+2598.5ms`, one measured trial), and total
 * `coordinatedShutdown` wall-clock ranged 2.4s-5.4s across five real trials
 * — one of which (5375ms) exceeded the reaper's own 5000ms grace outright,
 * the literal "survived SIGTERM -> SIGKILL" symptom.
 *
 * FIX: shrink the three best-effort budgets (all EXPLICITLY documented as
 * discardable/recoverable — drained work is recovered by
 * `healMissingVectors()`, the backup is "never required for durability" per
 * its own doc comment) so their sum leaves real, measured-informed headroom
 * (>= HEADROOM_FLOOR_MS below) for the checkpoint to complete without racing
 * the safety net in anything but a genuinely pathological stall — not the
 * routine multi-process contention this suite proves is real and
 * reproducible.
 *
 * RED->GREEN (BL-225): this suite was run against pre-fix values
 * (drain=750, terminate=750, backup=2500 — i.e. `git show HEAD:.../backend.ts`
 * before this commit) and failed both assertions below (headroom was 0ms,
 * and the SPEC-BL-472.md worst-case sum was 4250 > 4000, i.e. OVER budget
 * rather than under it with margin). Restoring the reduced constants turns
 * both green — verbatim `npx nx test memory-server -- --run
 * bug018-shutdown-budget-headroom.spec` output for both runs is quoted in
 * the BUG-018 backlog resolution citation.
 *
 * Gate: npx nx test memory-server -- --run bug018-shutdown-budget-headroom.spec
 */
import { describe, it, expect } from 'vitest';
import {
  SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS,
  SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS,
  SHUTDOWN_BACKUP_TIMEOUT_MS,
  SHUTDOWN_SAFETY_NET_MS,
} from './backend.js';

/**
 * Minimum wall-clock headroom (ms) the durability-critical, deliberately
 * UNBOUNDED steps (2 `closeAllAdapters`, 2b `WriteQueue.closeAllForShutdown`,
 * 4 `handle.close`) must be guaranteed under `SHUTDOWN_SAFETY_NET_MS`,
 * assuming every best-effort step ahead of/around them consumes its FULL
 * budget (the routine case under real contention, not a rare edge — every
 * one of five live BUG-018 repro trials hit step 0's full 750ms bound).
 * Chosen from measurement: live 3-way real-contention trials put
 * `closeAllAdapters` + `closeAllForShutdown` + `handle.close` combined at up
 * to ~925ms end-to-end (BUG-018 repro, `t+1677.7ms` -> `t+2598.5ms`). This
 * floor gives that measured worst case more than 2x margin.
 */
const HEADROOM_FLOOR_MS = 2000;

describe('BUG-018 — coordinatedShutdown step-timeout budget must leave real headroom for the unbounded, durability-critical checkpoint', () => {
  it('sum of the three best-effort/discardable step budgets (drain + terminate + backup) leaves >= HEADROOM_FLOOR_MS under SHUTDOWN_SAFETY_NET_MS for the checkpoint (closeAllAdapters/closeAllForShutdown/handle.close)', () => {
    const guaranteedEatenByBestEffortSteps =
      SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS + SHUTDOWN_EMBED_TERMINATE_TIMEOUT_MS + SHUTDOWN_BACKUP_TIMEOUT_MS;
    const headroomMs = SHUTDOWN_SAFETY_NET_MS - guaranteedEatenByBestEffortSteps;

    // Pre-fix: 750 + 750 + 2500 = 4000 == SHUTDOWN_SAFETY_NET_MS exactly ->
    // headroomMs === 0. RED here.
    expect(headroomMs).toBeGreaterThanOrEqual(HEADROOM_FLOOR_MS);
  });

  it('the SPEC-BL-472.md D1 worst-case sum (drain + the underlying fastembed-process TERMINATE_GRACE_MS + backup) stays UNDER SHUTDOWN_SAFETY_NET_MS with real margin, not merely within a tolerated overshoot', () => {
    // TERMINATE_GRACE_MS mirrors sharedFastembedProcess.ts's own documented
    // internal grace (libs/data/embed/embedding-provider — out of this
    // package's file set, so referenced as a literal exactly as
    // bl472-shutdown-drain.spec.ts already does). This is the REAL
    // background cost of a still-running (not cancelled) terminateEmbedWorkers()
    // loser promise after coordinatedShutdown's own 750ms race gives up on it —
    // it keeps consuming CPU/IO concurrently with whatever step runs next.
    const TERMINATE_GRACE_MS = 1000;
    const worstCaseSum =
      SHUTDOWN_EMBED_DRAIN_TIMEOUT_MS + TERMINATE_GRACE_MS + SHUTDOWN_BACKUP_TIMEOUT_MS;

    // Pre-fix: 750 + 1000 + 2500 = 4250 > 4000 (SPEC-BL-472.md D1's own
    // acknowledged "tighter than 4000" overshoot, tolerated only by a
    // "+500ms documented margin" carve-out). RED here: 4250 is NOT less than
    // SHUTDOWN_SAFETY_NET_MS.
    expect(worstCaseSum).toBeLessThan(SHUTDOWN_SAFETY_NET_MS);
  });
});
