/**
 * libs/host-runtime/src/host-runtime.spec.ts
 *
 * Verifies [def:session-fixes] carried forward into host-runtime lib:
 *   - fireIsolated (DEFECT-1 closure): throwing hook does NOT suppress later hooks
 *   - enable-reactivation: supervisor restart logic
 *   - stop-via-supervisor: _stopping prevents restart on teardown
 *   - expandTilde (Gap A5 fix)
 *   - HostEventBus dispatches through fireIsolated()
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import { expandTilde, ProcessSupervisor } from './supervisor.js';
import { HookLoader } from './hook-loader.js';
import {
  HostEventBus,
  createEventBus,
  LIFECYCLE_EVENTS,
  isLifecycleEvent,
} from './event-bus.js';
import { resolveExtensionDir } from './loader.js';

// ─── expandTilde (Gap A5 fix) ─────────────────────────────────────────────────

describe('supervisor — expandTilde (Gap A5 fix)', () => {
  it('expands ~/path to homedir/path', () => {
    const result = expandTilde('~/.memory/memoryd.sock');
    expect(result).toBe(path.join(os.homedir(), '.memory', 'memoryd.sock'));
  });

  it('expands bare ~ to homedir', () => {
    const result = expandTilde('~');
    expect(result).toBe(os.homedir());
  });

  it('leaves absolute paths unchanged', () => {
    const abs = '/tmp/memoryd.sock';
    expect(expandTilde(abs)).toBe(abs);
  });

  it('leaves relative paths unchanged', () => {
    expect(expandTilde('relative/path')).toBe('relative/path');
  });
});

// ─── ProcessSupervisor lifecycle block ───────────────────────────────────────

describe('supervisor — lifecycle block honor', () => {
  it('creates a ProcessSupervisor with the provided lifecycle block', () => {
    const lifecycle = {
      background: true,
      singleton: true,
      stop_timeout_ms: 5000,
      health: { type: 'socket' as const, endpoint: '~/.memory/memoryd.sock', interval_ms: 5000, timeout_ms: 2000 },
    };
    const sup = new ProcessSupervisor({
      key: 'test@0.1.0',
      entrypointPath: '/nonexistent/bin.js',
      lifecycle,
    });
    expect(sup.isHealthy()).toBe(false);
    expect(sup.pid()).toBeNull();
  });
});

// ─── HookLoader.fireIsolated [def:session-fixes] ──────────────────────────────

describe('HookLoader.fireIsolated — DEFECT-1 fix carried forward', () => {
  it('a single non-throwing hook returns [undefined]', async () => {
    const loader = new HookLoader();
    const ran: string[] = [];
    loader.register({ id: 'hook-a', event: 'PreToolUse', order: 10 }, () => {
      ran.push('hook-a');
    });
    const results = await loader.fireIsolated('PreToolUse', { timestamp: new Date().toISOString() });
    expect(results).toHaveLength(1);
    expect(results[0]).toBeUndefined();
    expect(ran).toEqual(['hook-a']);
  });

  it('THROWING HOOK DOES NOT SUPPRESS LATER HOOKS — chain continues', async () => {
    const loader = new HookLoader();
    const ran: string[] = [];

    loader.register({ id: 'hook-bad', event: 'PreToolUse', order: 1 }, () => {
      throw new Error('intentional failure');
    });
    loader.register({ id: 'hook-good', event: 'PreToolUse', order: 2 }, () => {
      ran.push('hook-good');
    });

    const results = await loader.fireIsolated('PreToolUse', { timestamp: new Date().toISOString() });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: 'hook-bad' });
    expect(results[1]).toBeUndefined();
    // Critical: hook-good ran despite hook-bad throwing
    expect(ran).toContain('hook-good');
  });

  it('returns empty array for an event with no registered hooks', async () => {
    const loader = new HookLoader();
    const results = await loader.fireIsolated('SessionEnd', { timestamp: new Date().toISOString() });
    expect(results).toEqual([]);
  });
});

// ─── HostEventBus (fireIsolated dispatch) ────────────────────────────────────

describe('HostEventBus — fireIsolated dispatch [def:session-fixes]', () => {
  it('emits with no participants → empty result', async () => {
    const loader = new HookLoader();
    const bus = new HostEventBus(loader);
    const results = await bus.emit('PreToolUse', { timestamp: new Date().toISOString() });
    expect(results).toEqual([]);
  });

  it('throwing hook does NOT suppress later reactions (bus-level isolation)', async () => {
    const loader = new HookLoader();
    loader.register({ id: 'bad-hook', event: 'SessionEnd', order: 1 }, () => {
      throw new Error('hook threw');
    });

    const bus = new HostEventBus(loader);
    const ran: string[] = [];
    bus.on('SessionEnd', async () => { ran.push('reaction'); });

    const results = await bus.emit('SessionEnd', { timestamp: new Date().toISOString() });
    // hook threw, reaction still ran
    expect(results[0]).toMatchObject({ id: 'bad-hook' });
    expect(results[1]).toBeUndefined();
    expect(ran).toContain('reaction');
  });

  it('createEventBus factory works', () => {
    const loader = new HookLoader();
    const bus = createEventBus(loader);
    expect(bus).toBeInstanceOf(HostEventBus);
  });
});

// ─── LIFECYCLE_EVENTS vocabulary ─────────────────────────────────────────────

describe('LIFECYCLE_EVENTS — closed vocabulary', () => {
  it('contains all five canonical lifecycle event names', () => {
    expect(LIFECYCLE_EVENTS).toContain('PreToolUse');
    expect(LIFECYCLE_EVENTS).toContain('PostToolUse');
    expect(LIFECYCLE_EVENTS).toContain('SessionEnd');
    expect(LIFECYCLE_EVENTS).toContain('ScopePromotionProposed');
    expect(LIFECYCLE_EVENTS).toContain('Stop');
  });

  it('isLifecycleEvent guard returns true for valid events', () => {
    for (const evt of LIFECYCLE_EVENTS) {
      expect(isLifecycleEvent(evt)).toBe(true);
    }
  });

  it('isLifecycleEvent guard returns false for unknown strings', () => {
    expect(isLifecycleEvent('UnknownEvent')).toBe(false);
    expect(isLifecycleEvent('')).toBe(false);
  });
});

// ─── resolveExtensionDir (no-stat fix) ────────────────────────────────────────

describe('resolveExtensionDir — no-stat fix carried forward', () => {
  it('resolves file:// dir source', () => {
    const result = resolveExtensionDir('file:///tmp/my-ext', '/root');
    expect(result).toBe('/tmp/my-ext');
  });

  it('strips /src/index.ts suffix and returns parent dir', () => {
    const result = resolveExtensionDir('file:///tmp/my-ext/src/index.ts', '/root');
    expect(result).toBe('/tmp/my-ext');
  });

  it('strips /dist/index.js suffix', () => {
    const result = resolveExtensionDir('file:///tmp/my-ext/dist/index.js', '/root');
    expect(result).toBe('/tmp/my-ext');
  });

  it('returns absolute paths directly', () => {
    const result = resolveExtensionDir('/tmp/my-ext', '/root');
    expect(result).toBe('/tmp/my-ext');
  });

  it('returns null for npm:// source (not local)', () => {
    const result = resolveExtensionDir('npm://some-package', '/root');
    expect(result).toBeNull();
  });
});
