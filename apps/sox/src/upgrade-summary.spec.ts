/**
 * apps/sox/src/upgrade-summary.spec.ts
 *
 * BL-ad811031 — `soxe upgrade`'s per-consumer summary omitted `ahead`/
 * `no-registry` counts and could print "system fully current — zero
 * changes" while those pins sat unjudged. Regression coverage for
 * `formatUpgradeSummary` (apps/sox/src/upgrade-summary.ts).
 */
import { describe, expect, it } from 'vitest';

import { formatUpgradeSummary, type UpgradeConsumerOutcome } from './upgrade-summary.js';

describe('formatUpgradeSummary — BL-ad811031', () => {
  it('tallies current/upgraded/failed and does not claim fully-current when something changed', () => {
    const outcomes: UpgradeConsumerOutcome[] = [
      { state: 'current' },
      { state: 'current' },
      { state: 'upgraded' },
    ];
    const { tally, fullyCurrent } = formatUpgradeSummary(outcomes, 1, 0);
    expect(tally).toBe('2 current, 1 upgraded, 0 ahead, 0 no-registry, 0 failed.');
    expect(fullyCurrent).toBe(false);
  });

  it('reports fully-current when every consumer is current and nothing changed/failed', () => {
    const outcomes: UpgradeConsumerOutcome[] = [
      { state: 'current' },
      { state: 'current' },
    ];
    expect(formatUpgradeSummary(outcomes, 0, 0).fullyCurrent).toBe(true);
  });

  it('regression: includes ahead/no-registry counts in the tally instead of dropping them', () => {
    const outcomes: UpgradeConsumerOutcome[] = [
      { state: 'ahead' },
      { state: 'no-registry' },
      { state: 'no-registry' },
    ];
    const { tally } = formatUpgradeSummary(outcomes, 0, 0);
    expect(tally).toBe('0 current, 0 upgraded, 1 ahead, 2 no-registry, 0 failed.');
  });

  it('regression: never reports "fully current" while an ahead or no-registry pin is unjudged', () => {
    // Before the fix, changed === 0 && failed === 0 alone gated the
    // "system fully current" message, so a run consisting entirely of
    // ahead/no-registry outcomes (nothing actually verified current) still
    // claimed the system was fully current.
    expect(formatUpgradeSummary([{ state: 'ahead' }], 0, 0).fullyCurrent).toBe(false);
    expect(formatUpgradeSummary([{ state: 'no-registry' }], 0, 0).fullyCurrent).toBe(false);
    expect(formatUpgradeSummary([{ state: 'ahead' }, { state: 'no-registry' }], 0, 0).fullyCurrent).toBe(false);
  });

  it('reports fully-current for a genuinely empty run (no consumers at all)', () => {
    expect(formatUpgradeSummary([], 0, 0).fullyCurrent).toBe(true);
  });

  it('never reports fully-current when anything failed', () => {
    expect(formatUpgradeSummary([{ state: 'current' }], 0, 1).fullyCurrent).toBe(false);
  });
});
