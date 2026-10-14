/**
 * e85abe84 / BL-465121ca — idle-tick gate. Pure decision logic: a tick skips
 * forking an enrich child only when there is no open trigger, the store
 * fingerprint is unchanged since an idle pass, and the forced-pass cap has not
 * been reached. The cap guarantees a real pass at least every N+1 ticks.
 */
import { describe, it, expect } from 'vitest';
import {
  IDLE_ENRICH_MAX_CONSECUTIVE_SKIPS,
  advanceIdleEnrichGate,
  createIdleEnrichGate,
  idleSkipResult,
  isIdleBatchResult,
  shouldSkipIdleEnrichFork,
} from './enrich-isolation.js';

const FP = '42|0';

describe('e85abe84: idle-tick gate decision', () => {
  it('never skips before an idle pass has been recorded', () => {
    const g = createIdleEnrichGate();
    expect(shouldSkipIdleEnrichFork(g, { hasOpenTriggers: false, fingerprint: FP })).toBe(false);
  });

  it('skips after an idle pass when the fingerprint is unchanged and nothing is queued', () => {
    const g = createIdleEnrichGate();
    advanceIdleEnrichGate(g, { kind: 'idle-pass', fingerprint: FP });
    expect(shouldSkipIdleEnrichFork(g, { hasOpenTriggers: false, fingerprint: FP })).toBe(true);
  });

  it('never skips while an enrich trigger is open', () => {
    const g = createIdleEnrichGate();
    advanceIdleEnrichGate(g, { kind: 'idle-pass', fingerprint: FP });
    expect(shouldSkipIdleEnrichFork(g, { hasOpenTriggers: true, fingerprint: FP })).toBe(false);
  });

  it('never skips when the store fingerprint changed (new episode, new vector)', () => {
    const g = createIdleEnrichGate();
    advanceIdleEnrichGate(g, { kind: 'idle-pass', fingerprint: FP });
    expect(shouldSkipIdleEnrichFork(g, { hasOpenTriggers: false, fingerprint: '43|0' })).toBe(false);
  });

  it('forces a real pass once the consecutive-skip cap is reached', () => {
    const g = createIdleEnrichGate();
    advanceIdleEnrichGate(g, { kind: 'idle-pass', fingerprint: FP });
    for (let i = 0; i < IDLE_ENRICH_MAX_CONSECUTIVE_SKIPS; i++) {
      expect(shouldSkipIdleEnrichFork(g, { hasOpenTriggers: false, fingerprint: FP })).toBe(true);
      advanceIdleEnrichGate(g, { kind: 'skipped' });
    }
    expect(shouldSkipIdleEnrichFork(g, { hasOpenTriggers: false, fingerprint: FP })).toBe(false);
  });

  it('a busy pass clears the idle state so the next tick forks', () => {
    const g = createIdleEnrichGate();
    advanceIdleEnrichGate(g, { kind: 'idle-pass', fingerprint: FP });
    advanceIdleEnrichGate(g, { kind: 'busy-pass' });
    expect(shouldSkipIdleEnrichFork(g, { hasOpenTriggers: false, fingerprint: FP })).toBe(false);
  });
});

describe('e85abe84: what counts as an idle pass', () => {
  it('the zero-work result is idle', () => {
    expect(isIdleBatchResult(idleSkipResult())).toBe(true);
  });

  it('any observable work makes the pass busy', () => {
    for (const field of ['communities_upserted', 'member_of_edges', 'incremental_joined', 'importance_updated', 'relates_to_edges'] as const) {
      const r = { ...idleSkipResult(), [field]: 1 };
      expect(isIdleBatchResult(r as ReturnType<typeof idleSkipResult>)).toBe(false);
    }
  });

  it('a skipped cluster step is not treated as idle', () => {
    expect(isIdleBatchResult({ ...idleSkipResult(), cluster_pass_skipped: true })).toBe(false);
  });
});
