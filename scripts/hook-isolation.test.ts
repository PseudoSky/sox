/**
 * hook-isolation.test.ts — hook error isolation
 *
 * Tests for HookLoader error isolation behavior:
 *
 * fire() (back-compat):
 *   - The throw propagates out of fire() (no internal catch)
 *   - Hooks AFTER the failing hook do NOT execute (the sequence aborts on first throw)
 *   - The caller must wrap fire() in try/catch to isolate failures
 *
 * fireIsolated() (DEFECT-1 fix — docs/engine-defects-found.md):
 *   - Each hook is wrapped in its own try/catch
 *   - A throwing hook does NOT abort the chain; later hooks still execute
 *   - Returns a per-hook result array: undefined (success) | { id, error } (failure)
 */

import { describe, it, expect } from 'vitest';
import { HookLoader } from './hook-loader.js';

// ─── Hook error isolation tests ───────────────────────────────────────────────

describe('hook error isolation', () => {
  it('a throwing hook causes fire() to reject with the thrown error', async () => {
    const loader = new HookLoader();
    const err = new Error('hook-alpha exploded');

    loader.register(
      { id: 'hook-alpha', event: 'PreToolUse', order: 10 },
      async () => { throw err; },
    );

    // fire() must reject (the error propagates to the caller)
    await expect(
      loader.fire('PreToolUse', { timestamp: new Date().toISOString() }),
    ).rejects.toThrow('hook-alpha exploded');
  });

  it(
    'fireIsolated(): hooks after a throwing hook DO execute (chain continues past failure)',
    async () => {
      const loader = new HookLoader();
      const executed: string[] = [];

      loader.register(
        { id: 'hook-first', event: 'PreToolUse', order: 10 },
        async () => { throw new Error('first hook fails'); },
      );
      loader.register(
        { id: 'hook-second', event: 'PreToolUse', order: 20 },
        () => { executed.push('hook-second'); },
      );
      loader.register(
        { id: 'hook-third', event: 'PreToolUse', order: 30 },
        () => { executed.push('hook-third'); },
      );

      // fireIsolated() does NOT throw — errors are captured per-hook
      const results = await loader.fireIsolated('PreToolUse', { timestamp: new Date().toISOString() });

      // hook-first failed — recorded in results; hook-second and hook-third still ran
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ id: 'hook-first', error: expect.any(Error) });
      expect(results[1]).toBeUndefined();
      expect(results[2]).toBeUndefined();
      expect(executed).toEqual(['hook-second', 'hook-third']);
    },
  );

  it('caller-side try/catch successfully isolates a single-hook failure', async () => {
    const loader = new HookLoader();
    let caughtError: Error | undefined;

    loader.register(
      { id: 'risky-hook', event: 'PostToolUse', order: 100 },
      async () => { throw new Error('risky hook failed'); },
    );

    // Caller wraps in try/catch — demonstrates the mitigation pattern
    try {
      await loader.fire('PostToolUse', { timestamp: new Date().toISOString() });
    } catch (e) {
      caughtError = e as Error;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError?.message).toBe('risky hook failed');
  });

  it('hooks on OTHER events are unaffected when a hook on one event throws', async () => {
    const loader = new HookLoader();
    const executed: string[] = [];

    loader.register(
      { id: 'bad-hook', event: 'PreToolUse', order: 10 },
      async () => { throw new Error('bad hook on PreToolUse'); },
    );
    loader.register(
      { id: 'good-hook', event: 'PostToolUse', order: 10 },
      () => { executed.push('good-hook'); },
    );

    // Fire PreToolUse (fails)
    try {
      await loader.fire('PreToolUse', { timestamp: new Date().toISOString() });
    } catch (_e) {
      // Expected
    }

    // Fire PostToolUse (should succeed — different event, isolated from the PreToolUse failure)
    await loader.fire('PostToolUse', { timestamp: new Date().toISOString() });

    // good-hook on PostToolUse ran fine — separate event is unaffected
    expect(executed).toContain('good-hook');
  });

  it('fireIsolated(): a hook that throws asynchronously does NOT abort the chain', async () => {
    const loader = new HookLoader();
    const executed: string[] = [];

    loader.register(
      { id: 'async-throw', event: 'Stop', order: 1 },
      async () => {
        await Promise.resolve(); // simulate async work
        throw new Error('async failure');
      },
    );
    loader.register(
      { id: 'after-async', event: 'Stop', order: 2 },
      () => { executed.push('after-async'); },
    );

    // fireIsolated() does NOT throw — the async rejection is caught and recorded
    const results = await loader.fireIsolated('Stop', { timestamp: new Date().toISOString() });

    // async-throw's error was captured; after-async still executed
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ id: 'async-throw', error: expect.any(Error) });
    expect((results[0] as { id: string; error: Error }).error.message).toBe('async failure');
    expect(results[1]).toBeUndefined();
    expect(executed).toEqual(['after-async']);
  });

  it('a non-throwing hook sequence runs all hooks successfully (baseline isolation passes)', async () => {
    const loader = new HookLoader();
    const executed: string[] = [];

    loader.register({ id: 'h1', event: 'PreToolUse', order: 10 }, () => { executed.push('h1'); });
    loader.register({ id: 'h2', event: 'PreToolUse', order: 20 }, () => { executed.push('h2'); });
    loader.register({ id: 'h3', event: 'PreToolUse', order: 30 }, () => { executed.push('h3'); });

    await loader.fire('PreToolUse', { timestamp: new Date().toISOString() });

    // All 3 hooks ran in order — baseline (no errors) is fine
    expect(executed).toEqual(['h1', 'h2', 'h3']);
  });

  it('fire() on an event with no registered hooks resolves without error', async () => {
    const loader = new HookLoader();
    // No hooks registered for 'UnknownEvent'
    await expect(
      loader.fire('UnknownEvent', { timestamp: new Date().toISOString() }),
    ).resolves.toBeUndefined();
  });
});
