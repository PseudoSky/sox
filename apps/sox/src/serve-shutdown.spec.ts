/**
 * serve-shutdown.spec.ts — BL-619 listen-outcome exit-code mapping.
 *
 * `exitCodeForListenOutcome` (factored into `serve-shutdown.ts` alongside
 * `waitForServePortSignal` for the same testability reason — `main.ts` runs
 * `void main()` at import time, so it cannot be imported directly by a unit
 * test) maps a guarded-listen outcome to a process exit code: a port collision
 * (EADDRINUSE → 'already-running') is NOT a fault (another instance is already
 * serving) so it exits 0; any other bind error is a genuine fault so it exits 1.
 */
import { describe, expect, it } from 'vitest';

import { exitCodeForListenOutcome } from './serve-shutdown.js';

describe('exitCodeForListenOutcome — BL-619', () => {
  it('already-running → 0 (another instance is already serving)', () => {
    const outcome = {
      ok: false as const,
      disposition: 'already-running' as const,
      failure: {
        code: 'EADDRINUSE',
        message: 'listen EADDRINUSE: address already in use 127.0.0.1:3099',
        host: '127.0.0.1',
        port: 3099,
        disposition: 'already-running' as const,
        pid: 1,
        ts: 'x',
      },
    };
    expect(exitCodeForListenOutcome(outcome)).toBe(0);
  });

  it('other → 1 (a genuine bind fault)', () => {
    const outcome = {
      ok: false as const,
      disposition: 'other' as const,
      failure: {
        code: 'EACCES',
        message: 'listen EACCES: permission denied',
        disposition: 'other' as const,
        pid: 1,
        ts: 'x',
      },
    };
    expect(exitCodeForListenOutcome(outcome)).toBe(1);
  });

  it('ok → 0 (a successful bind is not a fault)', () => {
    expect(exitCodeForListenOutcome({ ok: true })).toBe(0);
  });
});
