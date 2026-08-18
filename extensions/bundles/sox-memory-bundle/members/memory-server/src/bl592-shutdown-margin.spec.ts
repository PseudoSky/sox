/**
 * bl592-shutdown-margin.spec.ts — BL-592 / docs/spec/service-lifecycle.md §8.1a
 * part B.
 *
 * Proves memory-server's shutdown safety-net timeout is COMPUTED from the
 * resolved stop-timeout env var, not the pre-existing hand-picked literal
 * (`SHUTDOWN_SAFETY_NET_MS = 4000` regardless of what the manifest declared).
 * RED against pre-fix code: `SHUTDOWN_SAFETY_NET_MS` was a fixed `export const`
 * with no way to observe it change; there was no `computeShutdownSafetyNetMs`
 * export at all.
 */
import { describe, expect, it } from 'vitest';

import {
  SOX_SHUTDOWN_SAFETY_MARGIN_MS,
  computeShutdownSafetyNetMs,
  resolveStopTimeoutMs,
} from './shutdown-margin.js';

describe('BL-592 §8.1a part B — memory-server computeShutdownSafetyNetMs is computed, not a literal', () => {
  it('changes when SOX_CONFIG_STOP_TIMEOUT_MS changes', () => {
    const at5000 = computeShutdownSafetyNetMs({ SOX_CONFIG_STOP_TIMEOUT_MS: '5000' });
    const at9000 = computeShutdownSafetyNetMs({ SOX_CONFIG_STOP_TIMEOUT_MS: '9000' });
    expect(at5000).not.toBe(at9000);
    expect(at5000).toBe(4000); // matches the OLD hardcoded literal at the assumed 5000ms grace
    expect(at9000).toBe(8000);
  });

  it('defaults to 4000 (5000 fallback grace - 1000 margin) with no env override, matching pre-existing behavior exactly', () => {
    expect(computeShutdownSafetyNetMs({})).toBe(4000);
  });

  it('resolveStopTimeoutMs reads the injected env var and falls back to 5000', () => {
    expect(resolveStopTimeoutMs({ SOX_CONFIG_STOP_TIMEOUT_MS: '12000' })).toBe(12000);
    expect(resolveStopTimeoutMs({})).toBe(5000);
    expect(resolveStopTimeoutMs({ SOX_CONFIG_STOP_TIMEOUT_MS: 'garbage' })).toBe(5000);
  });

  it('always leaves exactly SOX_SHUTDOWN_SAFETY_MARGIN_MS of headroom', () => {
    for (const stopTimeoutMs of [2000, 5000, 9000, 30000]) {
      const net = computeShutdownSafetyNetMs({ SOX_CONFIG_STOP_TIMEOUT_MS: String(stopTimeoutMs) });
      expect(stopTimeoutMs - net).toBe(SOX_SHUTDOWN_SAFETY_MARGIN_MS);
    }
  });
});
