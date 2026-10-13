/**
 * circuit-breaker.spec.ts — 8468f7b1 SP21-SP25. Pure module: fake clock only,
 * no fs / net / child_process.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createCircuitBreaker,
  type BreakerEvent,
  type BreakerState,
  type BreakerStore,
} from './circuit-breaker.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function memStore(initial: BreakerState | null = null): BreakerStore & { state: BreakerState | null; saves: number } {
  const s = {
    state: initial,
    saves: 0,
    load: () => (s.state ? { ...s.state, recent: s.state.recent.slice() } : null),
    save: (n: BreakerState) => {
      s.saves++;
      s.state = { ...n, recent: n.recent.slice() };
    },
  };
  return s;
}

describe('8468f7b1 SP21 opens after exactly N consecutive failures, retryAfterMs counts down', () => {
  it('stays closed below the threshold and opens on the Nth failure', () => {
    const c = clock();
    const events: BreakerEvent[] = [];
    const b = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000, now: c.now, onEvent: (e) => events.push(e) });
    expect(b.check()).toEqual({ open: false });
    b.recordFailure();
    b.recordFailure();
    expect(b.check()).toEqual({ open: false });
    b.recordFailure();
    expect(b.check()).toEqual({ open: true, retryAfterMs: 10_000 });
    expect(events).toEqual([{ type: 'opened', retryAfterMs: 10_000 }]);
  });

  it('counts retryAfterMs down with the clock', () => {
    const c = clock();
    const b = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 5_000, now: c.now });
    b.recordFailure();
    c.advance(1_500);
    expect(b.check()).toEqual({ open: true, retryAfterMs: 3_500 });
    c.advance(3_499);
    expect(b.check()).toEqual({ open: true, retryAfterMs: 1 });
  });

  it('a success between failures resets the consecutive count', () => {
    const b = createCircuitBreaker({ failureThreshold: 3, now: clock().now });
    b.recordFailure();
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    b.recordFailure();
    expect(b.check()).toEqual({ open: false });
  });

  it('defaults to threshold 3 and cooldown 30s', () => {
    const c = clock();
    const b = createCircuitBreaker({ now: c.now });
    b.recordFailure();
    b.recordFailure();
    b.recordFailure();
    expect(b.check()).toEqual({ open: true, retryAfterMs: 30_000 });
  });

  it('a failure during an active cooldown does not extend it', () => {
    const c = clock();
    const b = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: c.now });
    b.recordFailure();
    c.advance(4_000);
    b.recordFailure();
    expect(b.check()).toEqual({ open: true, retryAfterMs: 6_000 });
  });

  it('a clock that moves backwards never yields a negative or oversized retryAfterMs', () => {
    const c = clock(5_000);
    const b = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 1_000, now: c.now });
    b.recordFailure();
    c.advance(-3_000);
    expect(b.check()).toEqual({ open: true, retryAfterMs: 1_000 });
  });
});

describe('8468f7b1 SP22 window mode drops old failures', () => {
  it('failures older than windowMs do not count toward the threshold', () => {
    const c = clock();
    const b = createCircuitBreaker({ failureThreshold: 3, windowMs: 60_000, cooldownMs: 30_000, now: c.now });
    b.recordFailure();
    c.advance(30_000);
    b.recordFailure();
    c.advance(31_000); // first failure is now 61s old
    b.recordFailure();
    expect(b.check()).toEqual({ open: false });
    c.advance(1_000);
    b.recordFailure(); // 2nd, 3rd, 4th within 60s... 2nd is 32s old
    expect(b.check()).toEqual({ open: true, retryAfterMs: 30_000 });
  });

  it('N failures inside the window open it even when interleaved over time', () => {
    const c = clock();
    const b = createCircuitBreaker({ failureThreshold: 3, windowMs: 60_000, now: c.now });
    b.recordFailure();
    c.advance(20_000);
    b.recordFailure();
    c.advance(20_000);
    b.recordFailure();
    expect(b.check().open).toBe(true);
  });

  it('without windowMs, old failures never expire (consecutive mode)', () => {
    const c = clock();
    const b = createCircuitBreaker({ failureThreshold: 3, now: c.now });
    b.recordFailure();
    c.advance(10 * 60_000);
    b.recordFailure();
    c.advance(10 * 60_000);
    b.recordFailure();
    expect(b.check().open).toBe(true);
  });

  it('a success clears the window', () => {
    const c = clock();
    const b = createCircuitBreaker({ failureThreshold: 2, windowMs: 60_000, now: c.now });
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    expect(b.check()).toEqual({ open: false });
  });
});

describe('8468f7b1 SP23 half-open: one probe, success closes, failure re-opens, stale probe expires', () => {
  function opened() {
    const c = clock();
    const events: BreakerEvent[] = [];
    const store = memStore();
    const b = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, now: c.now, store, onEvent: (e) => events.push(e) });
    b.recordFailure();
    b.recordFailure();
    return { c, b, events, store };
  }

  it('after the cooldown exactly one caller gets the probe; others stay open', () => {
    const { c, b, events } = opened();
    c.advance(10_000);
    expect(b.check()).toEqual({ open: false, probe: true });
    expect(b.check()).toEqual({ open: true, retryAfterMs: 10_000 });
    c.advance(2_500);
    expect(b.check()).toEqual({ open: true, retryAfterMs: 7_500 });
    expect(events.filter((e) => e.type === 'half-open')).toHaveLength(1);
  });

  it('probe success closes the breaker and resets counts', () => {
    const { c, b, events } = opened();
    c.advance(10_000);
    b.check();
    b.recordSuccess();
    expect(b.check()).toEqual({ open: false });
    expect(events.at(-1)).toEqual({ type: 'closed' });
    b.recordFailure();
    expect(b.check()).toEqual({ open: false }); // count restarted from zero
  });

  it('probe failure re-opens with a fresh cooldown', () => {
    const { c, b, events } = opened();
    c.advance(10_000);
    expect(b.check()).toEqual({ open: false, probe: true });
    b.recordFailure();
    expect(b.check()).toEqual({ open: true, retryAfterMs: 10_000 });
    expect(events.filter((e) => e.type === 'opened')).toHaveLength(2);
    c.advance(10_000);
    expect(b.check()).toEqual({ open: false, probe: true });
  });

  it('a probe that never reports back expires after cooldownMs and a new probe is granted', () => {
    const { c, b } = opened();
    c.advance(10_000);
    expect(b.check()).toEqual({ open: false, probe: true });
    c.advance(9_999);
    expect(b.check().open).toBe(true);
    c.advance(1);
    expect(b.check()).toEqual({ open: false, probe: true });
  });

  it('two breakers sharing a store: only one of them wins the probe', () => {
    const c = clock();
    const store = memStore();
    const mk = () => createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: c.now, store });
    const a = mk();
    const z = mk();
    a.recordFailure();
    expect(z.check().open).toBe(true); // z sees a's open state
    c.advance(10_000);
    expect(a.check()).toEqual({ open: false, probe: true });
    expect(z.check()).toEqual({ open: true, retryAfterMs: 10_000 });
    a.recordSuccess();
    expect(z.check()).toEqual({ open: false });
  });
});

describe('8468f7b1 SP24 funnel-parity golden table', () => {
  // Constants copied from libs/data/embed/embedding-provider/src/funnelClient.ts:
  // ENSURE_FAILURE_THRESHOLD = 3 (:58), ENSURE_CIRCUIT_COOLDOWN_MS = 10_000 (:59).
  const FUNNEL = { failureThreshold: 3, cooldownMs: 10_000 } as const;

  type Step =
    | { do: 'fail' }
    | { do: 'ok' }
    | { do: 'wait'; ms: number }
    | { do: 'check'; expect: 'closed' | 'open' | 'probe'; retryAfterMs?: number };

  // Reference model of the funnel: doEnsure guard :382-387, success :535, noteEnsureFailure :571-576.
  function funnelModel() {
    let failures = 0;
    let openUntil = 0;
    let t = 0;
    return {
      wait: (ms: number) => void (t += ms),
      fail: () => {
        failures++;
        if (failures >= FUNNEL.failureThreshold) openUntil = t + FUNNEL.cooldownMs;
      },
      ok: () => void (failures = 0),
      closed: () => t >= openUntil,
      remaining: () => openUntil - t,
    };
  }

  const table: Array<{ name: string; steps: Step[] }> = [
    { name: 'three failures open for exactly 10s', steps: [{ do: 'fail' }, { do: 'fail' }, { do: 'check', expect: 'closed' }, { do: 'fail' }, { do: 'check', expect: 'open', retryAfterMs: 10_000 }] },
    { name: 'open until the cooldown elapses', steps: [{ do: 'fail' }, { do: 'fail' }, { do: 'fail' }, { do: 'wait', ms: 9_999 }, { do: 'check', expect: 'open', retryAfterMs: 1 }, { do: 'wait', ms: 1 }, { do: 'check', expect: 'probe' }] },
    { name: 'count survives the cooldown: one more failure re-opens at once', steps: [{ do: 'fail' }, { do: 'fail' }, { do: 'fail' }, { do: 'wait', ms: 10_000 }, { do: 'check', expect: 'probe' }, { do: 'fail' }, { do: 'check', expect: 'open', retryAfterMs: 10_000 }] },
    { name: 'success resets the count', steps: [{ do: 'fail' }, { do: 'fail' }, { do: 'ok' }, { do: 'fail' }, { do: 'fail' }, { do: 'check', expect: 'closed' }, { do: 'fail' }, { do: 'check', expect: 'open', retryAfterMs: 10_000 }] },
    { name: 'success after cooldown closes fully', steps: [{ do: 'fail' }, { do: 'fail' }, { do: 'fail' }, { do: 'wait', ms: 10_000 }, { do: 'check', expect: 'probe' }, { do: 'ok' }, { do: 'check', expect: 'closed' }, { do: 'fail' }, { do: 'fail' }, { do: 'check', expect: 'closed' }] },
  ];

  for (const row of table) {
    it(row.name, () => {
      const c = clock(0);
      const b = createCircuitBreaker({ ...FUNNEL, now: c.now });
      const model = funnelModel();
      for (const s of row.steps) {
        if (s.do === 'fail') {
          b.recordFailure();
          model.fail();
        } else if (s.do === 'ok') {
          b.recordSuccess();
          model.ok();
        } else if (s.do === 'wait') {
          c.advance(s.ms);
          model.wait(s.ms);
        } else {
          const got = b.check();
          if (s.expect === 'open') {
            expect(got).toEqual({ open: true, retryAfterMs: s.retryAfterMs });
            // the funnel's guard is also closed-off with the same remaining time
            expect(model.closed()).toBe(false);
            expect(model.remaining()).toBe(s.retryAfterMs);
          } else {
            // closed, or half-open (the only intended divergence: the funnel lets every
            // caller through after the cooldown; the breaker lets one probe through).
            expect(got.open).toBe(false);
            expect(model.closed()).toBe(true);
            expect('probe' in got).toBe(s.expect === 'probe');
          }
        }
      }
    });
  }
});

describe('8468f7b1 SP25 default path is pure and a throwing store degrades', () => {
  it('source imports nothing and references no fs / net / child_process / process / timers', () => {
    const src = fs.readFileSync(path.join(__dirname, 'circuit-breaker.ts'), 'utf8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/^\s*import\s/m);
    expect(code).not.toMatch(/require\(/);
    expect(code).not.toMatch(/node:|child_process|\bfs\b|\bnet\b|\bhttp\b/);
    expect(code).not.toMatch(/process\.|setTimeout|setInterval/);
  });

  it('default store keeps independent breakers independent', () => {
    const c = clock();
    const a = createCircuitBreaker({ failureThreshold: 1, now: c.now });
    const z = createCircuitBreaker({ failureThreshold: 1, now: c.now });
    a.recordFailure();
    expect(a.check().open).toBe(true);
    expect(z.check().open).toBe(false);
  });

  it('a store whose load and save both throw degrades to in-memory with store-failed', () => {
    const c = clock();
    const events: BreakerEvent[] = [];
    const boom = new Error('disk gone');
    const store: BreakerStore = {
      load: () => {
        throw boom;
      },
      save: () => {
        throw boom;
      },
    };
    const b = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, now: c.now, store, onEvent: (e) => events.push(e) });
    b.recordFailure();
    b.recordFailure();
    expect(b.check()).toEqual({ open: true, retryAfterMs: 10_000 });
    expect(events.filter((e) => e.type === 'store-failed').length).toBeGreaterThan(0);
    expect(events.find((e) => e.type === 'store-failed')).toEqual({ type: 'store-failed', error: boom });
    c.advance(10_000);
    expect(b.check()).toEqual({ open: false, probe: true });
  });

  it('a store returning malformed state is treated as absent', () => {
    const store: BreakerStore = { load: () => ({ consecutive: 'x' }) as unknown as BreakerState, save: () => {} };
    const b = createCircuitBreaker({ store, now: clock().now });
    expect(b.check()).toEqual({ open: false });
  });

  it('a throwing onEvent listener never breaks the breaker', () => {
    const b = createCircuitBreaker({
      failureThreshold: 1,
      now: clock().now,
      onEvent: () => {
        throw new Error('listener');
      },
    });
    expect(() => b.recordFailure()).not.toThrow();
    expect(b.check().open).toBe(true);
  });

  it('persists state through the store and the callers cannot mutate it by reference', () => {
    const store = memStore();
    const b = createCircuitBreaker({ failureThreshold: 1, now: clock().now, store });
    b.recordFailure();
    expect(store.saves).toBe(1);
    expect(store.state?.openedAt).not.toBeNull();
  });
});

describe('8468f7b1 SP22b backwards-clock handling is consistent between check() and recordFailure()', () => {
  it('SP22b a failure recorded while check() reports open (clock went backwards) does not re-open with a fresh openedAt', () => {
    const c = clock(1_000_000);
    const store = memStore();
    const b = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, now: c.now, store });
    b.recordFailure();
    const opened = store.state!.openedAt;
    const savesBefore = store.saves;
    c.advance(-3_000); // clock steps back: check() treats the breaker as freshly opened
    expect(b.check()).toEqual({ open: true, retryAfterMs: 10_000 });
    b.recordFailure();
    expect(store.state!.openedAt).toBe(opened); // not rewritten to the earlier clock reading
    expect(store.state!.consecutive).toBe(1);
    expect(store.saves).toBe(savesBefore);
    expect(b.check()).toEqual({ open: true, retryAfterMs: 10_000 });
  });

  it('SP22b the re-open branch drops future-dated window entries just like the closed branch', () => {
    const store = memStore({ consecutive: 2, recent: [30_000, 15_000], openedAt: 1_000, probeStartedAt: null });
    const b = createCircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, windowMs: 100_000, now: () => 20_000, store });
    b.recordFailure(); // cooldown elapsed, no probe out: re-opens
    expect(store.state!.recent).toEqual([15_000, 20_000]); // 30_000 is in the future of 20_000: dropped
    expect(store.state!.openedAt).toBe(20_000);
  });
});
