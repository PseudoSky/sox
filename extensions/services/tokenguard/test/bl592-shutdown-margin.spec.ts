/**
 * bl592-shutdown-margin.spec.ts — BL-592 / docs/spec/service-lifecycle.md §8.1a
 * part B.
 *
 * Proves tokenguard's shutdown safety-net timeout is COMPUTED from the resolved
 * stop-timeout env var, not the pre-existing bare `setTimeout(..., 5000)` — a
 * literal IDENTICAL to tokenguard's own declared `lifecycle.stop_timeout_ms`
 * (`extension.json`, also 5000): a race against the reaper's own SIGKILL
 * escalation, not a margin (BUG-018).
 */
import { describe, expect, it } from 'vitest';

import { SOX_SHUTDOWN_SAFETY_MARGIN_MS, computeShutdownSafetyNetMs, resolveStopTimeoutMs } from '../src/shutdown-margin';

describe('BL-592 §8.1a part B — tokenguard computeShutdownSafetyNetMs is computed, not a literal', () => {
  it('RED (pre-fix: a bare setTimeout(..., 5000) — identical to the declared stop_timeout_ms, a race not a margin) — changes when SOX_CONFIG_STOP_TIMEOUT_MS changes', () => {
    const at5000 = computeShutdownSafetyNetMs({ SOX_CONFIG_STOP_TIMEOUT_MS: '5000' });
    const at9000 = computeShutdownSafetyNetMs({ SOX_CONFIG_STOP_TIMEOUT_MS: '9000' });
    expect(at5000).not.toBe(at9000);
    expect(at5000).toBe(4000);
    expect(at9000).toBe(8000);
  });

  it('at the extension.json-declared default (5000, no override), sits strictly INSIDE the grace with a real margin — the exact race BUG-018 identified is now closed', () => {
    const net = computeShutdownSafetyNetMs({});
    const declaredStopTimeoutMs = 5000; // extension.json lifecycle.stop_timeout_ms
    expect(net).toBeLessThan(declaredStopTimeoutMs);
    expect(declaredStopTimeoutMs - net).toBe(SOX_SHUTDOWN_SAFETY_MARGIN_MS);
  });

  it('resolveStopTimeoutMs reads the injected env var and falls back to 5000', () => {
    expect(resolveStopTimeoutMs({ SOX_CONFIG_STOP_TIMEOUT_MS: '15000' })).toBe(15000);
    expect(resolveStopTimeoutMs({})).toBe(5000);
    expect(resolveStopTimeoutMs({ SOX_CONFIG_STOP_TIMEOUT_MS: 'nope' })).toBe(5000);
  });
});
