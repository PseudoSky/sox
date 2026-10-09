/**
 * context.spec.ts — c536ce29 TRC-AC9 (ALS part) and TRC-AC20 (L1 portion).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentLogContext, withLogContext } from './context.js';

const SLOT = Symbol.for('@adhd/sox-telemetry/log-context');
const g = globalThis as unknown as Record<symbol, unknown>;

describe('c536ce29 TRC-AC9 withLogContext / currentLogContext', () => {
  it('c536ce29 TRC-AC9 context is empty outside any scope', () => {
    expect(currentLogContext()).toEqual({});
  });

  it('c536ce29 TRC-AC9 child contexts merge over parent; parent restored after; undefined unsets', () => {
    withLogContext({ run: 'r1', turn: 1 }, () => {
      expect(currentLogContext()).toEqual({ run: 'r1', turn: 1 });
      withLogContext({ turn: 2, call_id: 'c9' }, () => {
        expect(currentLogContext()).toEqual({ run: 'r1', turn: 2, call_id: 'c9' });
        withLogContext({ run: undefined }, () => expect(currentLogContext()).toEqual({ turn: 2, call_id: 'c9' }));
      });
      expect(currentLogContext()).toEqual({ run: 'r1', turn: 1 });
    });
    expect(currentLogContext()).toEqual({});
  });

  it('c536ce29 TRC-AC9 returns the callback result and propagates its exceptions', () => {
    expect(withLogContext({ a: 1 }, () => 42)).toBe(42);
    expect(() => withLogContext({ a: 1 }, () => { throw new Error('boom'); })).toThrow('boom');
    expect(currentLogContext()).toEqual({});
  });

  it('c536ce29 TRC-AC9 context survives await and setTimeout boundaries, and concurrent scopes do not bleed', async () => {
    const seen: Array<Readonly<Record<string, unknown>>> = [];
    await Promise.all(
      ['a', 'b'].map((id) =>
        withLogContext({ id }, async () => {
          await Promise.resolve();
          seen.push({ ...currentLogContext(), at: 'await' });
          await new Promise<void>((resolve) => setTimeout(() => { seen.push({ ...currentLogContext(), at: 'timer' }); resolve(); }, 5));
          await new Promise<void>((resolve) => setImmediate(resolve));
          seen.push({ ...currentLogContext(), at: 'after' });
        }),
      ),
    );
    for (const id of ['a', 'b']) {
      expect(seen.filter((s) => s.id === id).map((s) => s.at)).toEqual(['await', 'timer', 'after']);
    }
    expect(seen).toHaveLength(6);
    expect(currentLogContext()).toEqual({});
  });
});

describe('c536ce29 TRC-AC20 shared globalThis slot', () => {
  afterEach(() => {
    delete g[SLOT];
    vi.resetModules();
  });

  it('c536ce29 TRC-AC20 a slot created by an older copy lacking the field is accepted and lazily extended, not replaced', async () => {
    vi.resetModules();
    const legacy: Record<string, unknown> = { legacyField: 'keep-me' };
    g[SLOT] = legacy;
    const mod = await import('./context.js');
    expect(mod.currentLogContext()).toEqual({});
    mod.withLogContext({ x: 1 }, () => expect(mod.currentLogContext()).toEqual({ x: 1 }));
    expect(g[SLOT]).toBe(legacy);
    expect(legacy.legacyField).toBe('keep-me');
    expect(legacy.als).toBeDefined();
  });

  it('c536ce29 TRC-AC20 a non-object or frozen slot never throws (falls back to a module-local context)', async () => {
    vi.resetModules();
    g[SLOT] = Object.freeze({});
    const mod = await import('./context.js');
    expect(() => mod.withLogContext({ y: 2 }, () => mod.currentLogContext())).not.toThrow();
    expect(mod.withLogContext({ y: 2 }, () => mod.currentLogContext())).toEqual({ y: 2 });
  });

  it('c536ce29 TRC-AC20 two module instances share one context', async () => {
    vi.resetModules();
    const a = await import('./context.js');
    vi.resetModules();
    const b = await import('./context.js');
    expect(a).not.toBe(b);
    a.withLogContext({ run: 'shared' }, () => {
      expect(b.currentLogContext()).toEqual({ run: 'shared' });
      b.withLogContext({ turn: 3 }, () => expect(a.currentLogContext()).toEqual({ run: 'shared', turn: 3 }));
    });
    expect(b.currentLogContext()).toEqual({});
  });
});
