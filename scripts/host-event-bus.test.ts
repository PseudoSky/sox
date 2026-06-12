/**
 * scripts/host-event-bus.test.ts — Host lifecycle event bus tests.
 *
 * Covers P6 acceptance requirements:
 *   1. Closed event vocabulary (LifecycleEvent union + isLifecycleEvent guard)
 *   2. HostEventBus dispatches through fireIsolated() — a throwing hook does NOT
 *      suppress later participants (the core DEFECT-1 regression test at bus level)
 *   3. Direct reaction registration (on/off) for mcp/agent/skill/command
 *   4. Mixed hook + reaction dispatch in a single emit()
 *   5. Unknown event names rejected at the type level (runtime isLifecycleEvent guard)
 *   6. Per-participant result array semantics (undefined = success, {id,error} = failure)
 */

import { describe, it, expect } from 'vitest';
import { HookLoader } from './hook-loader.js';
import {
  HostEventBus,
  createEventBus,
  LIFECYCLE_EVENTS,
  isLifecycleEvent,
} from './host/event-bus.js';

// ─── Closed event vocabulary ──────────────────────────────────────────────────

describe('LIFECYCLE_EVENTS — closed vocabulary', () => {
  it('contains all five canonical lifecycle event names', () => {
    expect(LIFECYCLE_EVENTS).toContain('PreToolUse');
    expect(LIFECYCLE_EVENTS).toContain('PostToolUse');
    expect(LIFECYCLE_EVENTS).toContain('SessionEnd');
    expect(LIFECYCLE_EVENTS).toContain('ScopePromotionProposed');
    expect(LIFECYCLE_EVENTS).toContain('Stop');
  });

  it('has exactly five members (vocabulary is closed)', () => {
    expect(LIFECYCLE_EVENTS).toHaveLength(5);
  });
});

describe('isLifecycleEvent() — type guard', () => {
  it('returns true for all five valid lifecycle event names', () => {
    for (const evt of LIFECYCLE_EVENTS) {
      expect(isLifecycleEvent(evt)).toBe(true);
    }
  });

  it('returns false for unknown strings', () => {
    expect(isLifecycleEvent('UnknownEvent')).toBe(false);
    expect(isLifecycleEvent('')).toBe(false);
    expect(isLifecycleEvent('pretooluse')).toBe(false); // case-sensitive
    expect(isLifecycleEvent('PRETOOLUSE')).toBe(false);
  });
});

// ─── HostEventBus core dispatch ───────────────────────────────────────────────

describe('HostEventBus — dispatch via fireIsolated()', () => {
  it('emits an event with no participants and returns an empty result array', async () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    const results = await bus.emit('PreToolUse', { timestamp: new Date().toISOString() });
    expect(results).toEqual([]);
  });

  it('a single non-throwing hook returns [undefined] (success)', async () => {
    const loader = new HookLoader();
    const ran: string[] = [];
    loader.register({ id: 'hook-a', event: 'PreToolUse', order: 10 }, () => {
      ran.push('hook-a');
    });

    const bus = new HostEventBus(loader);
    const results = await bus.emit('PreToolUse', { timestamp: new Date().toISOString() });

    expect(results).toHaveLength(1);
    expect(results[0]).toBeUndefined();
    expect(ran).toEqual(['hook-a']);
  });

  it(
    'THROWING HOOK DOES NOT SUPPRESS LATER HOOKS — chain continues past failure (DEFECT-1 closure via bus)',
    async () => {
      const loader = new HookLoader();
      const executed: string[] = [];

      loader.register(
        { id: 'hook-first', event: 'PreToolUse', order: 10 },
        async () => {
          throw new Error('first hook blows up');
        },
      );
      loader.register(
        { id: 'hook-second', event: 'PreToolUse', order: 20 },
        () => { executed.push('hook-second'); },
      );
      loader.register(
        { id: 'hook-third', event: 'PreToolUse', order: 30 },
        () => { executed.push('hook-third'); },
      );

      const bus = new HostEventBus(loader);
      // emit() must NOT throw — errors are isolated per-participant
      const results = await bus.emit('PreToolUse', { timestamp: new Date().toISOString() });

      // hook-first failed → result[0] is {id, error}
      expect(results[0]).toEqual({ id: 'hook-first', error: expect.any(Error) });
      // hook-second and hook-third still ran
      expect(results[1]).toBeUndefined();
      expect(results[2]).toBeUndefined();
      expect(executed).toEqual(['hook-second', 'hook-third']);
    },
  );

  it('async throwing hook does not abort the chain (async isolation)', async () => {
    const loader = new HookLoader();
    const executed: string[] = [];

    loader.register(
      { id: 'async-fail', event: 'SessionEnd', order: 1 },
      async () => {
        await Promise.resolve();
        throw new Error('async SessionEnd failure');
      },
    );
    loader.register(
      { id: 'after-fail', event: 'SessionEnd', order: 2 },
      () => { executed.push('after-fail'); },
    );

    const bus = new HostEventBus(loader);
    const results = await bus.emit('SessionEnd', { timestamp: new Date().toISOString() });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id: 'async-fail', error: expect.any(Error) });
    expect(results[1]).toBeUndefined();
    expect(executed).toEqual(['after-fail']);
  });

  it('all hooks succeed — result array is all undefined', async () => {
    const loader = new HookLoader();
    loader.register({ id: 'h1', event: 'PostToolUse', order: 10 }, () => {});
    loader.register({ id: 'h2', event: 'PostToolUse', order: 20 }, () => {});
    loader.register({ id: 'h3', event: 'PostToolUse', order: 30 }, () => {});

    const bus = new HostEventBus(loader);
    const results = await bus.emit('PostToolUse', { timestamp: new Date().toISOString() });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r === undefined)).toBe(true);
  });

  it('HookLoader hooks are fired in deterministic order (order ASC, id ASC tie-break)', async () => {
    const loader = new HookLoader();
    const order: string[] = [];

    loader.register({ id: 'z-hook', event: 'Stop', order: 10 }, () => { order.push('z-hook'); });
    loader.register({ id: 'a-hook', event: 'Stop', order: 10 }, () => { order.push('a-hook'); });
    loader.register({ id: 'm-hook', event: 'Stop', order: 5 }, () => { order.push('m-hook'); });

    const bus = new HostEventBus(loader);
    await bus.emit('Stop', { timestamp: new Date().toISOString() });

    // m-hook (order=5) → a-hook (order=10, id 'a' < 'z') → z-hook (order=10)
    expect(order).toEqual(['m-hook', 'a-hook', 'z-hook']);
  });
});

// ─── Direct reaction registration (mcp/agent/skill/command) ──────────────────

describe('HostEventBus — direct reaction registration (on/off)', () => {
  it('on() registers a reaction that fires on emit()', async () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    const fired: string[] = [];

    bus.on('SessionEnd', () => { fired.push('reaction-a'); });
    await bus.emit('SessionEnd', { timestamp: new Date().toISOString() });

    expect(fired).toEqual(['reaction-a']);
  });

  it('on() returns a stable reaction id', () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    const id = bus.on('PreToolUse', () => {}, 'my-stable-id');
    expect(id).toBe('my-stable-id');
  });

  it('on() auto-generates unique ids when none provided', () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    const id1 = bus.on('PreToolUse', () => {});
    const id2 = bus.on('PreToolUse', () => {});
    expect(id1).not.toBe(id2);
  });

  it('off() removes a registered reaction by id', async () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    const fired: string[] = [];

    const id = bus.on('PostToolUse', () => { fired.push('removed'); });
    const removed = bus.off('PostToolUse', id);
    await bus.emit('PostToolUse', { timestamp: new Date().toISOString() });

    expect(removed).toBe(true);
    expect(fired).toEqual([]);
  });

  it('off() returns false when the id is not found', () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    expect(bus.off('PreToolUse', 'nonexistent-id')).toBe(false);
  });

  it('reactionsFor() lists registered reaction ids in order', () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    bus.on('ScopePromotionProposed', () => {}, 'r1');
    bus.on('ScopePromotionProposed', () => {}, 'r2');
    bus.on('ScopePromotionProposed', () => {}, 'r3');
    expect(bus.reactionsFor('ScopePromotionProposed')).toEqual(['r1', 'r2', 'r3']);
  });

  it('clearReactions() removes all directly-registered reactions', async () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    const fired: string[] = [];

    bus.on('Stop', () => { fired.push('r1'); });
    bus.on('Stop', () => { fired.push('r2'); });
    bus.clearReactions();
    await bus.emit('Stop', { timestamp: new Date().toISOString() });

    expect(fired).toEqual([]);
  });

  it('a throwing reaction does NOT suppress later reactions (isolation)', async () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    const executed: string[] = [];

    bus.on('SessionEnd', async () => { throw new Error('reaction fails'); }, 'bad-reaction');
    bus.on('SessionEnd', () => { executed.push('good-reaction'); }, 'good-reaction');

    const results = await bus.emit('SessionEnd', { timestamp: new Date().toISOString() });

    expect(results[0]).toEqual({ id: 'bad-reaction', error: expect.any(Error) });
    expect(results[1]).toBeUndefined();
    expect(executed).toEqual(['good-reaction']);
  });
});

// ─── Mixed hook + reaction dispatch ───────────────────────────────────────────

describe('HostEventBus — mixed hook + reaction dispatch', () => {
  it('hooks fire before direct reactions; both groups are isolated', async () => {
    const loader = new HookLoader();
    const order: string[] = [];

    loader.register({ id: 'hook-early', event: 'PreToolUse', order: 10 }, () => {
      order.push('hook-early');
    });
    loader.register(
      { id: 'hook-throws', event: 'PreToolUse', order: 20 },
      async () => { throw new Error('hook throws'); },
    );

    const bus = new HostEventBus(loader);
    bus.on('PreToolUse', () => { order.push('reaction-mcp'); }, 'reaction-mcp');
    bus.on(
      'PreToolUse',
      async () => { throw new Error('reaction throws'); },
      'reaction-bad',
    );
    bus.on('PreToolUse', () => { order.push('reaction-cmd'); }, 'reaction-cmd');

    const results = await bus.emit('PreToolUse', { timestamp: new Date().toISOString() });

    // 2 hooks + 3 reactions = 5 total results
    expect(results).toHaveLength(5);

    // hook-early: success
    expect(results[0]).toBeUndefined();
    // hook-throws: failure
    expect(results[1]).toEqual({ id: 'hook-throws', error: expect.any(Error) });
    // reaction-mcp: success
    expect(results[2]).toBeUndefined();
    // reaction-bad: failure
    expect(results[3]).toEqual({ id: 'reaction-bad', error: expect.any(Error) });
    // reaction-cmd: success (not suppressed by reaction-bad)
    expect(results[4]).toBeUndefined();

    // Execution order: hooks first, then reactions
    expect(order).toEqual(['hook-early', 'reaction-mcp', 'reaction-cmd']);
  });

  it('ctx carries the event name and timestamp through to every participant', async () => {
    const loader = new HookLoader();
    const seen: Array<{ event: string; timestamp: string }> = [];

    loader.register({ id: 'h1', event: 'PostToolUse', order: 1 }, (ctx) => {
      seen.push({ event: ctx.event, timestamp: ctx.timestamp });
    });

    const bus = new HostEventBus(loader);
    bus.on('PostToolUse', (ctx) => {
      seen.push({ event: ctx.event, timestamp: ctx.timestamp });
    });

    const ts = '2026-06-08T00:00:00.000Z';
    await bus.emit('PostToolUse', { timestamp: ts });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ event: 'PostToolUse', timestamp: ts });
    expect(seen[1]).toEqual({ event: 'PostToolUse', timestamp: ts });
  });

  it('each event is independent — a failure on one event does not affect another', async () => {
    const loader = new HookLoader();
    const executed: string[] = [];

    loader.register(
      { id: 'bad-hook', event: 'PreToolUse', order: 10 },
      async () => { throw new Error('PreToolUse hook fails'); },
    );
    loader.register({ id: 'good-hook', event: 'PostToolUse', order: 10 }, () => {
      executed.push('good-hook');
    });

    const bus = new HostEventBus(loader);
    // Emit the failing event
    const r1 = await bus.emit('PreToolUse', { timestamp: new Date().toISOString() });
    // Emit the unrelated event — must not be affected
    const r2 = await bus.emit('PostToolUse', { timestamp: new Date().toISOString() });

    expect(r1[0]).toEqual({ id: 'bad-hook', error: expect.any(Error) });
    expect(r2[0]).toBeUndefined();
    expect(executed).toEqual(['good-hook']);
  });
});

// ─── createEventBus() factory ─────────────────────────────────────────────────

describe('createEventBus() — convenience factory', () => {
  it('returns a HostEventBus instance', () => {
    const loader = new HookLoader();
    const bus = createEventBus(loader);
    expect(bus).toBeInstanceOf(HostEventBus);
  });

  it('the returned bus shares the provided HookLoader', async () => {
    const loader = new HookLoader();
    const executed: string[] = [];
    loader.register({ id: 'shared-hook', event: 'Stop', order: 1 }, () => {
      executed.push('shared-hook');
    });

    const bus = createEventBus(loader);
    await bus.emit('Stop', { timestamp: new Date().toISOString() });

    expect(executed).toEqual(['shared-hook']);
  });
});
