/**
 * hook-loader.test.ts — Vitest for hook execution ordering (Gap 2 acceptance).
 *
 * Acceptance criterion (migration.md Phase 5 verification):
 *   "a fixture with two hooks on the same event loads them in
 *    order-ascending, id-tiebroken sequence"
 *
 * Covers:
 *   1. Single hook — fires without error.
 *   2. Two hooks, distinct order — lower order fires first.
 *   3. Two hooks, same order — id lexicographic tie-break (a < b).
 *   4. Three hooks, mixed order + tie — full sort.
 *   5. Default order (100) treated same as explicit 100.
 *   6. Hooks on different events don't interfere.
 *   7. async handlers are awaited in sequence.
 *   8. orderedIdsFor() helper returns ids without running handlers.
 *   9. fire() passes the full HookContext (event, timestamp, payload).
 *  10. hooksFor() returns empty array for unknown event.
 */

import { describe, it, expect, vi } from 'vitest';
import { HookLoader, compareHooks } from './hook-loader.js';
import type { HookManifest, RegisteredHook, HookContext, HookHandler } from './hook-loader.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeManifest(id: string, event: string, order?: number): HookManifest {
  return { id, event, ...(order !== undefined ? { order } : {}) };
}

function noop(_ctx: HookContext): void {}

// ─── Unit tests for compareHooks ─────────────────────────────────────────────

describe('compareHooks', () => {
  function hook(id: string, order?: number): RegisteredHook {
    return { manifest: makeManifest(id, 'TestEvent', order), handler: noop };
  }

  it('lower order sorts before higher order', () => {
    expect(compareHooks(hook('a', 10), hook('b', 20))).toBeLessThan(0);
    expect(compareHooks(hook('b', 20), hook('a', 10))).toBeGreaterThan(0);
  });

  it('missing order defaults to 100', () => {
    // hook with explicit 100 and hook with missing order should be equal in order key
    // then fall through to id tie-break
    expect(compareHooks(hook('a', 100), hook('b'))).toBeLessThan(0); // 'a' < 'b'
    expect(compareHooks(hook('b'), hook('a', 100))).toBeGreaterThan(0); // 'b' > 'a'
  });

  it('ties broken by id lexicographic ascending', () => {
    expect(compareHooks(hook('alpha', 50), hook('beta', 50))).toBeLessThan(0);
    expect(compareHooks(hook('z', 50), hook('a', 50))).toBeGreaterThan(0);
    expect(compareHooks(hook('same', 50), hook('same', 50))).toBe(0);
  });

  it('order 1 sorts before order 99', () => {
    expect(compareHooks(hook('z', 1), hook('a', 99))).toBeLessThan(0);
  });
});

// ─── HookLoader integration ───────────────────────────────────────────────────

describe('HookLoader — hook execution ordering (Gap 2 acceptance fixture)', () => {
  it('fires a single hook without error', async () => {
    const loader = new HookLoader();
    const called: string[] = [];
    loader.register(makeManifest('only', 'TestEvent', 50), () => {
      called.push('only');
    });
    await loader.fire('TestEvent', { timestamp: 't1' });
    expect(called).toEqual(['only']);
  });

  it('fires two hooks in ascending order (lower order first)', async () => {
    const loader = new HookLoader();
    const seq: string[] = [];
    loader.register(makeManifest('slow', 'TestEvent', 200), () => { seq.push('slow'); });
    loader.register(makeManifest('fast', 'TestEvent', 10), () => { seq.push('fast'); });
    await loader.fire('TestEvent', { timestamp: 't1' });
    expect(seq).toEqual(['fast', 'slow']);
  });

  it('breaks ties by id lexicographic ascending when order values are equal', async () => {
    const loader = new HookLoader();
    const seq: string[] = [];
    loader.register(makeManifest('zebra', 'TestEvent', 50), () => { seq.push('zebra'); });
    loader.register(makeManifest('alpha', 'TestEvent', 50), () => { seq.push('alpha'); });
    await loader.fire('TestEvent', { timestamp: 't1' });
    // 'alpha' < 'zebra' lexicographically → alpha fires first
    expect(seq).toEqual(['alpha', 'zebra']);
  });

  it('handles three hooks with mixed order values and one tie', async () => {
    const loader = new HookLoader();
    const seq: string[] = [];
    // order 50/id 'b', order 50/id 'a', order 200/id 'c'
    loader.register(makeManifest('b', 'LifecycleEvent', 50), () => { seq.push('b'); });
    loader.register(makeManifest('c', 'LifecycleEvent', 200), () => { seq.push('c'); });
    loader.register(makeManifest('a', 'LifecycleEvent', 50), () => { seq.push('a'); });
    await loader.fire('LifecycleEvent', { timestamp: 't1' });
    // a(50) < b(50) — tie at 50 broken by id; then c(200)
    expect(seq).toEqual(['a', 'b', 'c']);
  });

  it('treats missing order as 100 (same as explicit 100)', async () => {
    const loader = new HookLoader();
    const seq: string[] = [];
    // 'beta' has no order (defaults to 100); 'alpha' has explicit 100
    // tie-break: 'alpha' < 'beta'
    loader.register(makeManifest('beta', 'TestEvent'), () => { seq.push('beta'); });
    loader.register(makeManifest('alpha', 'TestEvent', 100), () => { seq.push('alpha'); });
    await loader.fire('TestEvent', { timestamp: 't1' });
    expect(seq).toEqual(['alpha', 'beta']);
  });

  it('hooks on different events do not interfere with each other', async () => {
    const loader = new HookLoader();
    const pre: string[] = [];
    const post: string[] = [];
    loader.register(makeManifest('pre-hook', 'PreToolUse', 10), () => { pre.push('pre-hook'); });
    loader.register(makeManifest('post-hook', 'PostToolUse', 10), () => { post.push('post-hook'); });
    await loader.fire('PreToolUse', { timestamp: 't1' });
    expect(pre).toEqual(['pre-hook']);
    expect(post).toEqual([]); // PostToolUse not fired yet
    await loader.fire('PostToolUse', { timestamp: 't2' });
    expect(post).toEqual(['post-hook']);
  });

  it('awaits async handlers in order', async () => {
    const loader = new HookLoader();
    const seq: string[] = [];
    loader.register(makeManifest('first', 'AsyncEvent', 1), async () => {
      await new Promise<void>((res) => setTimeout(res, 10));
      seq.push('first');
    });
    loader.register(makeManifest('second', 'AsyncEvent', 2), async () => {
      seq.push('second');
    });
    await loader.fire('AsyncEvent', { timestamp: 't1' });
    expect(seq).toEqual(['first', 'second']);
  });

  it('orderedIdsFor returns id sequence without running handlers', () => {
    const loader = new HookLoader();
    const spy = vi.fn();
    loader.register(makeManifest('z-hook', 'MyEvent', 50), spy as HookHandler);
    loader.register(makeManifest('a-hook', 'MyEvent', 50), spy as HookHandler);
    const ids = loader.orderedIdsFor('MyEvent');
    expect(spy).not.toHaveBeenCalled();
    expect(ids).toEqual(['a-hook', 'z-hook']);
  });

  it('passes full HookContext (event, timestamp, payload) to handler', async () => {
    const loader = new HookLoader();
    const captured: HookContext[] = [];
    loader.register(makeManifest('ctx-hook', 'CtxEvent', 1), (ctx) => { captured.push(ctx); });
    await loader.fire('CtxEvent', { timestamp: '2026-01-01T00:00:00Z', payload: { tool: 'bash' } });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      event: 'CtxEvent',
      timestamp: '2026-01-01T00:00:00Z',
      payload: { tool: 'bash' },
    });
  });

  it('hooksFor returns empty array for unregistered event', () => {
    const loader = new HookLoader();
    expect(loader.hooksFor('UnknownEvent')).toEqual([]);
  });

  it('clear() removes all hooks from all events', async () => {
    const loader = new HookLoader();
    const seq: string[] = [];
    loader.register(makeManifest('h1', 'EventA', 1), () => { seq.push('h1'); });
    loader.register(makeManifest('h2', 'EventB', 1), () => { seq.push('h2'); });
    loader.clear();
    await loader.fire('EventA', { timestamp: 't1' });
    await loader.fire('EventB', { timestamp: 't1' });
    expect(seq).toEqual([]);
  });
});
