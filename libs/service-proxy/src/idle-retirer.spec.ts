import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createIdleRetirer,
  idleDueInMs,
  type IdleDueInput,
  type IdleRetirer,
  type IdleRetirerEvent,
  type IdleRetirerOptions,
  type IdleRetirerTimer,
  type RetireStep,
} from './idle-retirer.js';

// Plan 8468f7b1 (single-pass lifecycle), Feature C, acceptance SP13-SP20.
// Pure module: fake clock and fake timers only. No sockets, no processes.

interface FakeTimer extends IdleRetirerTimer {
  at: number;
  fn: () => void;
  unrefCalled: boolean;
  cleared: boolean;
  fired: boolean;
}

/** Deterministic clock + timer wheel. `advance` fires due timers in order. */
function fakeEnv(start = 1_000) {
  let t = start;
  const timers: FakeTimer[] = [];
  const env = {
    now: () => t,
    timers,
    setTimer: (fn: () => void, ms: number): FakeTimer => {
      const timer: FakeTimer = {
        at: t + ms,
        fn,
        unrefCalled: false,
        cleared: false,
        fired: false,
        unref() {
          timer.unrefCalled = true;
        },
        clear() {
          timer.cleared = true;
        },
      };
      timers.push(timer);
      return timer;
    },
    /** Timers still able to fire. */
    pending: () => timers.filter((x) => !x.cleared && !x.fired),
    /** Timer by creation order; throws if absent (noUncheckedIndexedAccess). */
    at: (i: number): FakeTimer => {
      const x = timers.at(i);
      if (!x) throw new Error(`no timer at ${i}`);
      return x;
    },
    set: (ms: number) => {
      t = ms;
    },
    async advance(ms: number): Promise<void> {
      const target = t + ms;
      for (;;) {
        const next = timers
          .filter((x) => !x.cleared && !x.fired && x.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = Math.max(t, next.at);
        next.fired = true;
        next.fn();
        // Let retire()'s async steps run.
        await Promise.resolve();
        await Promise.resolve();
      }
      t = target;
      await Promise.resolve();
    },
  };
  return env;
}

function build(extra: Partial<IdleRetirerOptions> = {}, windowMs = 1_000) {
  const env = fakeEnv();
  const events: IdleRetirerEvent[] = [];
  const order: string[] = [];
  const steps: RetireStep[] = [
    { name: 'a', run: () => void order.push('a') },
    { name: 'b', run: () => void order.push('b') },
  ];
  const r = createIdleRetirer({
    idleWindowMs: windowMs,
    steps,
    now: env.now,
    setTimer: env.setTimer,
    onEvent: (e) => events.push(e),
    ...extra,
  });
  return { env, events, order, r };
}

describe('8468f7b1 SP13 idleDueInMs truth table', () => {
  const base: IdleDueInput = { busy: false, retiring: false, lastWorkAt: 100, now: 150, idleWindowMs: 1_000 };
  const cases: Array<[string, Partial<IdleDueInput>, number | null]> = [
    ['idle, mid-window', {}, 950],
    ['exactly at deadline', { now: 1_100 }, 0],
    ['past deadline clamps to 0', { now: 9_999 }, 0],
    ['just after work', { now: 100 }, 1_000],
    ['busy => null', { busy: true }, null],
    ['retiring => null', { retiring: true }, null],
    ['busy past deadline => still null', { busy: true, now: 9_999 }, null],
    ['busy and retiring => null', { busy: true, retiring: true }, null],
    ['clock behind lastWorkAt => window plus skew', { now: 50 }, 1_050],
  ];
  for (const [name, patch, expected] of cases) {
    it(name, () => {
      expect(idleDueInMs({ ...base, ...patch })).toBe(expected);
    });
  }
});

describe('8468f7b1 SP14 fires once at W after the last touch/work; unref; re-arms after work', () => {
  it('does nothing before arm()', async () => {
    const { env, r } = build();
    await env.advance(10_000);
    expect(r.state).toBe('running');
    expect(env.timers).toHaveLength(0);
  });

  it('arms an unref d timer and retires exactly once at W', async () => {
    const { env, events, order, r } = build();
    r.arm();
    expect(env.at(0).unrefCalled).toBe(true);
    await env.advance(999);
    expect(r.state).toBe('running');
    await env.advance(1);
    expect(r.state).toBe('retired');
    expect(order).toEqual(['a', 'b']);
    expect(events.filter((e) => e.type === 'fired')).toHaveLength(1);
    await env.advance(60_000);
    expect(events.filter((e) => e.type === 'retired')).toHaveLength(1);
  });

  it('arm() is idempotent (one timer)', () => {
    const { env, r } = build();
    r.arm();
    r.arm();
    expect(env.pending()).toHaveLength(1);
  });

  it('touch() before W pushes the deadline to W after the touch', async () => {
    const { env, r } = build();
    r.arm();
    await env.advance(600);
    r.touch();
    await env.advance(500); // 1100 since arm, 500 since touch
    expect(r.state).toBe('running');
    await env.advance(500); // 1000 since touch
    expect(r.state).toBe('retired');
  });

  it('re-arms after work: retire happens W after the work settled', async () => {
    const { env, r } = build();
    r.arm();
    await env.advance(900);
    await r.work(() => 'x');
    await env.advance(999);
    expect(r.state).toBe('running');
    await env.advance(1);
    expect(r.state).toBe('retired');
  });

  it('dueInMs() reports the remainder and null once retired', async () => {
    const { env, r } = build();
    r.arm();
    await env.advance(250);
    expect(r.dueInMs()).toBe(750);
    await env.advance(750);
    expect(r.dueInMs()).toBeNull();
  });
});

describe('8468f7b1 SP15 work(): bumps on resolve and reject; busy while pending; unwrapped ping delays nothing', () => {
  it('busy while pending: does not retire past W, retires W after settle', async () => {
    const { env, r } = build();
    let release!: (v: string) => void;
    const pending = r.work(() => new Promise<string>((res) => (release = res)));
    r.arm();
    await env.advance(5_000);
    expect(r.state).toBe('running');
    expect(r.dueInMs()).toBeNull();
    release('done');
    await expect(pending).resolves.toBe('done');
    expect(r.dueInMs()).toBe(1_000);
    await env.advance(1_000);
    expect(r.state).toBe('retired');
  });

  it('bumps on resolve', async () => {
    const { env, r } = build();
    env.set(2_000);
    await r.work(() => 1);
    expect(r.dueInMs()).toBe(1_000);
  });

  it('bumps on reject and rethrows the original error', async () => {
    const { env, r } = build();
    const boom = new Error('boom');
    env.set(5_000);
    await expect(
      r.work(() => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(r.dueInMs()).toBe(1_000);
  });

  it('a rejected async work is no longer busy afterwards', async () => {
    const { env, r } = build();
    await expect(r.work(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    r.arm();
    await env.advance(1_000);
    expect(r.state).toBe('retired');
  });

  it('an un-wrapped ping (no touch/work) delays nothing', async () => {
    const { env, r } = build();
    r.arm();
    const ping = (): string => 'pong'; // health probe: deliberately not wrapped
    await env.advance(400);
    ping();
    await env.advance(300);
    ping();
    await env.advance(300);
    expect(r.state).toBe('retired');
  });

  it('isBusy() defers while true and retires at the next poll after it clears', async () => {
    let busy = true;
    const { env, r } = build({ isBusy: () => busy });
    r.arm();
    await env.advance(3_000);
    expect(r.state).toBe('running');
    busy = false;
    r.touch(); // the host reports the work that just ended
    await env.advance(1_000);
    expect(r.state).toBe('retired');
  });

  it('a throwing isBusy is treated as busy (never retires on a guess)', async () => {
    const { env, r } = build({
      isBusy: () => {
        throw new Error('probe broke');
      },
    });
    r.arm();
    await env.advance(5_000);
    expect(r.state).toBe('running');
  });
});

describe('8468f7b1 SP16 timer re-arm never writes lastWorkAt', () => {
  it('re-arming while busy does not move the deadline: retires on the first poll after busy clears', async () => {
    let busy = true;
    const { env, r } = build({ isBusy: () => busy });
    r.arm();
    await env.advance(3_500); // three re-arms while busy
    busy = false;
    // lastWorkAt is still creation time, so the deadline is long past.
    expect(r.dueInMs()).toBe(0);
    await env.advance(1_000); // next poll
    expect(r.state).toBe('retired');
  });

  it('two retirers deferring to each other (isBusy over the peer) still retire', async () => {
    const env = fakeEnv();
    const holder: { a?: IdleRetirer; b?: IdleRetirer } = {};
    const mk = (peer: () => IdleRetirer | undefined) =>
      createIdleRetirer({
        idleWindowMs: 1_000,
        steps: [],
        now: env.now,
        setTimer: env.setTimer,
        // Defers only while the peer is running AND has time left; the peer's
        // answer comes from its own deadline, so re-arming must not create a livelock.
        isBusy: () => {
          const p = peer();
          const d = p?.dueInMs();
          return p !== undefined && p.state === 'running' && d !== null && d !== undefined && d > 0;
        },
      });
    holder.a = mk(() => holder.b);
    holder.b = mk(() => holder.a);
    holder.a.arm();
    holder.b.arm();
    await env.advance(10_000);
    expect(holder.a.state).toBe('retired');
    expect(holder.b.state).toBe('retired');
  });
});

describe('8468f7b1 SP17 retire(): idempotent, ordered, continues after a throwing step, hold-open', () => {
  it('runs steps in order, awaiting async ones', async () => {
    const order: string[] = [];
    const { r } = build({
      steps: [
        {
          name: 'slow',
          run: async () => {
            await Promise.resolve();
            await Promise.resolve();
            order.push('slow');
          },
        },
        { name: 'after', run: () => void order.push('after') },
      ],
    });
    await r.retire('manual');
    expect(order).toEqual(['slow', 'after']);
  });

  it('is idempotent: same promise, steps run once, state flips once', async () => {
    const { events, order, r } = build();
    const p1 = r.retire('first');
    const p2 = r.retire('second');
    expect(p2).toBe(p1);
    expect(r.state).toBe('retiring');
    await p1;
    expect(r.state).toBe('retired');
    await r.retire('third');
    expect(order).toEqual(['a', 'b']);
    expect(events.filter((e) => e.type === 'retire-begin')).toEqual([{ type: 'retire-begin', reason: 'first' }]);
  });

  it('continues after a throwing step (sync and async) and never rejects', async () => {
    const ran: string[] = [];
    const e1 = new Error('sync');
    const e2 = new Error('async');
    const { events, r } = build({
      steps: [
        {
          name: 's1',
          run: () => {
            throw e1;
          },
        },
        { name: 's2', run: () => Promise.reject(e2) },
        { name: 's3', run: () => void ran.push('s3') },
      ],
    });
    await expect(r.retire('x')).resolves.toBeUndefined();
    expect(ran).toEqual(['s3']);
    expect(events.filter((e) => e.type === 'retire-step-failed')).toEqual([
      { type: 'retire-step-failed', step: 's1', error: e1 },
      { type: 'retire-step-failed', step: 's2', error: e2 },
    ]);
    expect(r.state).toBe('retired');
  });

  it('holds the loop open with a ref d timer until the last step ends, then clears it', async () => {
    let finish!: () => void;
    const { env, r } = build({
      steps: [{ name: 'long', run: () => new Promise<void>((res) => (finish = res)) }],
    });
    const done = r.retire('x');
    const hold = env.at(-1);
    expect(hold.unrefCalled).toBe(false);
    expect(hold.cleared).toBe(false);
    await Promise.resolve();
    expect(r.state).toBe('retiring');
    expect(hold.cleared).toBe(false);
    finish();
    await done;
    expect(hold.cleared).toBe(true);
    expect(r.state).toBe('retired');
  });

  it('clears the idle timer on retire and a late fire is inert', async () => {
    const { env, order, r } = build();
    r.arm();
    const idle = env.at(0);
    await r.retire('manual');
    expect(idle.cleared).toBe(true);
    idle.fn();
    await env.advance(10_000);
    expect(order).toEqual(['a', 'b']);
  });

  it('retire() from the timer and from a caller racing yields one retirement', async () => {
    const { env, events, r } = build();
    r.arm();
    await env.advance(1_000);
    await r.retire('late');
    expect(events.filter((e) => e.type === 'retire-begin')).toHaveLength(1);
  });
});

describe('8468f7b1 SP18 five typed events', () => {
  it('emits armed, fired, retire-begin, retire-step-failed, retired with typed payloads', async () => {
    const boom = new Error('boom');
    const { env, events, r } = build({
      steps: [
        {
          name: 'bad',
          run: () => {
            throw boom;
          },
        },
      ],
    });
    r.arm();
    await env.advance(1_000);
    expect(events).toEqual([
      { type: 'armed', dueInMs: 1_000 },
      { type: 'fired', reason: 'idle' },
      { type: 'retire-begin', reason: 'idle' },
      { type: 'retire-step-failed', step: 'bad', error: boom },
      { type: 'retired', reason: 'idle', durationMs: 0 },
    ]);
  });

  it('armed carries the re-armed remainder after a touch', async () => {
    const { env, events, r } = build();
    r.arm();
    await env.advance(600);
    r.touch();
    await env.advance(400); // original deadline: timer fires, work is 400 old
    const armed = events.filter((e) => e.type === 'armed');
    expect(armed).toEqual([
      { type: 'armed', dueInMs: 1_000 },
      { type: 'armed', dueInMs: 600 },
    ]);
  });

  it('retired.durationMs reflects the clock across slow steps', async () => {
    const env = fakeEnv();
    const events: IdleRetirerEvent[] = [];
    const r = createIdleRetirer({
      idleWindowMs: 1_000,
      steps: [{ name: 'slow', run: () => void env.set(env.now() + 250) }],
      now: env.now,
      setTimer: env.setTimer,
      onEvent: (e) => events.push(e),
    });
    await r.retire('manual');
    expect(events[events.length - 1]).toEqual({ type: 'retired', reason: 'manual', durationMs: 250 });
  });

  it('a throwing observer never breaks the lifecycle', async () => {
    const { r } = build({
      onEvent: () => {
        throw new Error('observer');
      },
    });
    r.arm();
    await expect(r.retire('x')).resolves.toBeUndefined();
    expect(r.state).toBe('retired');
  });
});

describe('8468f7b1 SP19 ADR-0022: no connection or presence input exists', () => {
  // Any key that names connection/presence-shaped input. Matched on the lowercase key.
  type ForbiddenWord = 'connect' | 'presence' | 'client' | 'session' | 'socket' | 'peer' | 'lease';
  type ForbiddenKeys<T> = {
    [K in keyof T & string]: Lowercase<K> extends `${string}${ForbiddenWord}${string}` ? K : never;
  }[keyof T & string];

  // Compile-time: each of these must be exactly `never`. If a field named like a
  // connection/presence input is ever added, `tsc` fails here.
  const optionsClean: ForbiddenKeys<IdleRetirerOptions> extends never ? true : false = true;
  const retirerClean: ForbiddenKeys<IdleRetirer> extends never ? true : false = true;
  const dueInputClean: ForbiddenKeys<IdleDueInput> extends never ? true : false = true;

  it('no option, method or input is named after a connection or presence', () => {
    expect([optionsClean, retirerClean, dueInputClean]).toEqual([true, true, true]);
  });

  it('rejects connection/presence fields at compile time', () => {
    const base = { idleWindowMs: 1_000, steps: [] as RetireStep[] };
    // @ts-expect-error ADR-0022: presence may release a host, never pin it
    const a: IdleRetirerOptions = { ...base, connections: () => 5 };
    // @ts-expect-error ADR-0022: no presence field
    const b: IdleRetirerOptions = { ...base, presence: true };
    // @ts-expect-error ADR-0022: no connection count input to the deadline
    const c: IdleDueInput = { busy: false, retiring: false, lastWorkAt: 0, now: 0, idleWindowMs: 1, connections: 3 };
    // @ts-expect-error ADR-0022: idleWindowMs has no default and is required
    const d: IdleRetirerOptions = { steps: [] };
    expect([a, b, c, d]).toHaveLength(4);
  });

  it('five permanent idle fake connections still retire at W', async () => {
    const { env, r } = build();
    // A fixture of permanently connected, never-active clients. The retirer
    // cannot see them, by construction; they only exist to make the intent explicit.
    const connections = new Set(['c1', 'c2', 'c3', 'c4', 'c5']);
    r.arm();
    await env.advance(1_000);
    expect(connections.size).toBe(5);
    expect(r.state).toBe('retired');
  });

  it('even a connected client that pings every 100 ms (not work) cannot pin the host', async () => {
    const { env, r } = build();
    r.arm();
    for (let i = 0; i < 9; i += 1) await env.advance(100);
    await env.advance(100);
    expect(r.state).toBe('retired');
  });
});

describe('8468f7b1 SP20 static scan: no process listeners, no exit, no env', () => {
  const source = readFileSync(join(__dirname, 'idle-retirer.ts'), 'utf8')
    // strip block and line comments so prose cannot satisfy or trip the scan
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('registers no process listeners', () => {
    expect(source).not.toMatch(/process\s*\.\s*(on|once|off|addListener|prependListener|removeListener)\s*\(/);
  });
  it('never exits or kills the process', () => {
    expect(source).not.toMatch(/process\s*\.\s*(exit|kill|abort|reallyExit)\b/);
  });
  it('reads no environment', () => {
    expect(source).not.toMatch(/process\s*\.\s*env\b/);
  });
  it('imports nothing (pure leaf)', () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
  });
});

describe('8468f7b1 SP14b windows beyond the timer ceiling are armed in slices, never as a >2^31-1 ms timer', () => {
  const MAX = 2 ** 31 - 1;

  it('SP14b a 100-day window is armed with a delay <= 2^31-1 and re-arms (without retiring) on each fire', async () => {
    const window = 100 * 24 * 3_600_000; // 8.64e9 ms
    const { env, events, r } = build({}, window);
    r.arm();
    expect(env.timers.every((x) => x.at - 1_000 <= MAX)).toBe(true);
    // A clamped-to-1ms timer would spin; here each slice is long and nothing retires early.
    await env.advance(MAX);
    expect(r.state).toBe('running');
    await env.advance(MAX);
    expect(r.state).toBe('running');
    expect(env.timers.length).toBeLessThan(10);
    for (const x of env.timers) expect(x.at).toBeGreaterThanOrEqual(1_000);
    await env.advance(window); // past the deadline
    expect(r.state).toBe('retired');
    expect(events.filter((e) => e.type === 'fired')).toHaveLength(1);
  });

  it('SP14b the requested delay is capped at the ceiling for every scheduled timer', () => {
    const delays: number[] = [];
    const env = fakeEnv();
    const r = createIdleRetirer({
      idleWindowMs: 2 ** 40,
      steps: [],
      now: env.now,
      setTimer: (fn, ms) => {
        delays.push(ms);
        return env.setTimer(fn, ms);
      },
    });
    r.arm();
    expect(delays).toEqual([MAX]);
  });
});

describe('8468f7b1 SP17b optional per-step retire timeout', () => {
  it('SP17b default (no retireStepTimeoutMs): a step is awaited indefinitely, behavior unchanged', async () => {
    const { env, order, r } = build({
      steps: [
        { name: 'slow', run: () => new Promise<void>(() => {}) },
        { name: 'after', run: () => void order.push('after') },
      ],
    });
    void r.retire('x');
    await env.advance(1_000_000);
    expect(r.state).toBe('retiring');
  });

  it('SP17b a hung step times out, is reported as failed, and later steps still run', async () => {
    const order: string[] = [];
    const { env, events, r } = build({
      retireStepTimeoutMs: 500,
      steps: [
        { name: 'hung', run: () => new Promise<void>(() => {}) },
        { name: 'after', run: () => void order.push('after') },
      ],
    });
    void r.retire('x');
    await env.advance(499);
    expect(r.state).toBe('retiring');
    await env.advance(1);
    await new Promise<void>((resolve) => setImmediate(resolve)); // drain the retire chain
    expect(r.state).toBe('retired');
    expect(order).toEqual(['after']);
    const failed = events.find((e) => e.type === 'retire-step-failed');
    expect(failed).toMatchObject({ type: 'retire-step-failed', step: 'hung' });
    expect(String((failed as { error: Error }).error.message)).toMatch(/timed out after 500ms/);
  });

  it('SP17b a step that settles in time clears its guard and reports no failure', async () => {
    const { env, events, order, r } = build({ retireStepTimeoutMs: 500 });
    await r.retire('x');
    expect(order).toEqual(['a', 'b']);
    expect(events.some((e) => e.type === 'retire-step-failed')).toBe(false);
    await env.advance(10_000); // a leaked guard would fire here and must not matter
    expect(r.state).toBe('retired');
    expect(env.pending()).toHaveLength(0);
  });

  it('SP17b a synchronously throwing step is still reported, with or without a timeout', async () => {
    const { events, r } = build({
      retireStepTimeoutMs: 500,
      steps: [{ name: 'boom', run: () => { throw new Error('sync'); } }],
    });
    await r.retire('x');
    expect(events.find((e) => e.type === 'retire-step-failed')).toMatchObject({ step: 'boom' });
  });

  it('SP17b rejects a non-positive or non-finite retireStepTimeoutMs', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createIdleRetirer({ idleWindowMs: 1, steps: [], retireStepTimeoutMs: bad })).toThrow(RangeError);
    }
  });
});
