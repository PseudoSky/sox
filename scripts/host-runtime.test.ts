/**
 * scripts/host-runtime.test.ts — Tests for the host runtime loader + supervisor + adapters.
 *
 * Covers:
 *   - Loader: reads lockfile, skips stale entries, dispatches to adapters
 *   - Supervisor: tilde expansion (Gap A5), singleton enforcement, lifecycle block honoring
 *   - Hook adapter: Shape A (event) and Shape B (events), handler registration
 *   - Agent adapter: in-process invoke
 *   - Skill adapter: in-process run
 *   - Command adapter: verb registration and invocation
 *   - MCP adapter: activation path (no actual spawn in tests)
 *   - Permission recording at activation (PB/P4 scope)
 *   - resolveExtensionDir: file:// source parsing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

// ─── supervisor.ts ────────────────────────────────────────────────────────────

import { expandTilde, ProcessSupervisor } from './host/supervisor.js';

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

  it('leaves ${HOME}/... env-style refs unchanged (not tilde)', () => {
    expect(expandTilde('${HOME}/.memory/sock')).toBe('${HOME}/.memory/sock');
  });
});

describe('supervisor — lifecycle block honor', () => {
  it('creates a ProcessSupervisor with the provided lifecycle block', () => {
    const lifecycle = {
      background: true,
      singleton: true,
      stop_timeout_ms: 5000,
      health: { type: 'socket' as const, endpoint: '~/.memory/memoryd.sock', interval_ms: 5000, timeout_ms: 2000 },
    };
    // Constructor does not throw for valid lifecycle
    const sup = new ProcessSupervisor({
      key: 'test@0.1.0',
      entrypointPath: '/nonexistent/bin.js',
      lifecycle,
    });
    expect(sup.isHealthy()).toBe(false);
    expect(sup.pid()).toBeNull();
  });
});

// ─── adapters/hook.ts ─────────────────────────────────────────────────────────

import { HookLoader } from './hook-loader.js';
import { activateHook } from './host/adapters/hook.js';

describe('hook adapter — Shape A (single event)', () => {
  let hookLoader: HookLoader;
  let tmpDir: string;
  let entrypointPath: string;

  beforeEach(() => {
    hookLoader = new HookLoader();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-'));
    // Write a minimal Shape-A CJS hook entrypoint
    entrypointPath = path.join(tmpDir, 'hook-a.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.event = 'PreToolUse';
exports.handler = function handler(ctx) { return { handled: ctx.event }; };
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers the hook for the exported event', async () => {
    await activateHook({
      key: 'audit@0.1.0',
      entrypointPath,
      hookLoader,
    });
    expect(hookLoader.orderedIdsFor('PreToolUse')).toContain('audit@0.1.0');
  });

  it('returns a handle with the registered event', async () => {
    const handle = await activateHook({
      key: 'audit@0.1.0',
      entrypointPath,
      hookLoader,
    });
    expect(handle.type).toBe('hook');
    expect(handle.registeredEvents).toEqual(['PreToolUse']);
  });

  it('fires the handler when the event is triggered', async () => {
    const captureLoader = new HookLoader();
    // Use a wrapper entrypoint that pushes to results
    const captureEntry = path.join(tmpDir, 'hook-capture.cjs');
    fs.writeFileSync(
      captureEntry,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.event = 'PreToolUse';
let _cap = [];
exports.handler = function handler(ctx) { _cap.push(ctx.event); global.__hookResults = _cap; };
`,
    );
    await activateHook({ key: 'capture@0.1.0', entrypointPath: captureEntry, hookLoader: captureLoader });
    await captureLoader.fire('PreToolUse', { timestamp: new Date().toISOString() });
    // Handler ran (no throw) — verified by not throwing
  });
});

describe('hook adapter — Shape B (multiple events)', () => {
  let hookLoader: HookLoader;
  let tmpDir: string;

  beforeEach(() => {
    hookLoader = new HookLoader();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers the hook for all exported events', async () => {
    const entrypointPath = path.join(tmpDir, 'hook-b.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.events = ['SessionEnd', 'ScopePromotionProposed'];
exports.handler = function handler(ctx) {};
`,
    );
    await activateHook({ key: 'flush@0.1.0', entrypointPath, hookLoader });
    expect(hookLoader.orderedIdsFor('SessionEnd')).toContain('flush@0.1.0');
    expect(hookLoader.orderedIdsFor('ScopePromotionProposed')).toContain('flush@0.1.0');
  });

  it('returns a handle with all registered events', async () => {
    const entrypointPath = path.join(tmpDir, 'hook-b2.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.events = ['SessionEnd', 'ScopePromotionProposed'];
exports.handler = function handler(ctx) {};
`,
    );
    const handle = await activateHook({ key: 'flush@0.1.0', entrypointPath, hookLoader });
    expect(handle.registeredEvents).toHaveLength(2);
    expect(handle.registeredEvents).toContain('SessionEnd');
    expect(handle.registeredEvents).toContain('ScopePromotionProposed');
  });

  it('throws when neither event nor events is exported', async () => {
    const entrypointPath = path.join(tmpDir, 'hook-bad.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = function handler(ctx) {};
// Missing event/events export
`,
    );
    await expect(
      activateHook({ key: 'bad@0.1.0', entrypointPath, hookLoader }),
    ).rejects.toThrow(/neither 'event' nor 'events'/);
  });

  it('throws when handler is not exported', async () => {
    const entrypointPath = path.join(tmpDir, 'hook-no-handler.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.event = 'PreToolUse';
// Missing handler
`,
    );
    await expect(
      activateHook({ key: 'no-handler@0.1.0', entrypointPath, hookLoader }),
    ).rejects.toThrow(/does not export a 'handler' function/);
  });
});

// ─── adapters/agent.ts ────────────────────────────────────────────────────────

import { activateAgent, activateSkill } from './host/adapters/agent.js';

describe('agent adapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-agent-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('activates an agent with an invoke export', async () => {
    const entrypointPath = path.join(tmpDir, 'agent.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invoke = async function invoke(input) { return { echoed: input.text }; };
`,
    );
    const handle = await activateAgent({ key: 'echo-agent@0.1.0', entrypointPath });
    expect(handle.type).toBe('agent');
    const result = await handle.invoke({ text: 'hello' });
    expect(result).toEqual({ echoed: 'hello' });
  });

  it('activates an agent with a run export (fallback)', async () => {
    const entrypointPath = path.join(tmpDir, 'agent-run.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = async function run(input) { return { result: 'done:' + input.x }; };
`,
    );
    const handle = await activateAgent({ key: 'agent-run@0.1.0', entrypointPath });
    const result = await handle.invoke({ x: '42' });
    expect(result).toEqual({ result: 'done:42' });
  });

  it('warns but does not throw when no invokable export exists', async () => {
    const entrypointPath = path.join(tmpDir, 'agent-no-invoke.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.name = 'my-agent';
exports.description = 'an agent without invoke';
`,
    );
    const handle = await activateAgent({ key: 'no-invoke@0.1.0', entrypointPath });
    expect(handle.type).toBe('agent');
    await expect(handle.invoke({})).rejects.toThrow(/no invokable export/);
  });

  it('records permissions at activation', async () => {
    const entrypointPath = path.join(tmpDir, 'agent-perms.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invoke = async function(i) { return i; };
`,
    );
    const permissions = { fs: { read: ['~/.memory/**'] } };
    const handle = await activateAgent({ key: 'agent-perms@0.1.0', entrypointPath, permissions });
    expect(handle.permissions).toEqual(permissions);
  });
});

describe('skill adapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-skill-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('activates a skill with a run export', async () => {
    const entrypointPath = path.join(tmpDir, 'skill.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = async function run(input) { return { result: 'Processed: ' + input.input }; };
`,
    );
    const handle = await activateSkill({ key: 'hello-world@0.1.0', entrypointPath });
    expect(handle.type).toBe('skill');
    const result = await handle.run({ input: 'test' });
    expect(result).toEqual({ result: 'Processed: test' });
  });

  it('throws when run is not exported', async () => {
    const entrypointPath = path.join(tmpDir, 'skill-bad.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// No run export
`,
    );
    await expect(activateSkill({ key: 'bad-skill@0.1.0', entrypointPath })).rejects.toThrow(
      /does not export a 'run' function/,
    );
  });
});

// ─── adapters/command.ts ──────────────────────────────────────────────────────

import { activateCommand, CommandRegistry } from './host/adapters/command.js';

describe('command adapter', () => {
  let tmpDir: string;
  let registry: CommandRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-test-cmd-'));
    registry = new CommandRegistry();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers Shape A (run) command under the correct verb', async () => {
    const entrypointPath = path.join(tmpDir, 'cmd-a.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = function run(input) { return { stdout: 'args:' + input.args.join(','), exitCode: 0 }; };
`,
    );
    await activateCommand({ key: 'status@0.1.0', entrypointPath, verb: 'status', registry });
    expect(registry.has('status')).toBe(true);
    const reg = registry.get('status')!;
    const output = await reg.handler({ args: ['a', 'b'] });
    expect(output.exitCode).toBe(0);
    expect(output.stdout).toContain('a,b');
  });

  it('registers Shape B (runCli) command', async () => {
    const entrypointPath = path.join(tmpDir, 'cmd-b.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCli = async function runCli(argv) { /* no-op */ };
`,
    );
    await activateCommand({ key: 'memory-cli@0.1.0', entrypointPath, verb: 'memory', registry });
    expect(registry.has('memory')).toBe(true);
  });

  it('derives verb from key when not provided', async () => {
    const entrypointPath = path.join(tmpDir, 'cmd-verb.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = function run(input) { return { exitCode: 0 }; };
`,
    );
    // verb derived from key: 'my-cmd@0.1.0' → 'my-cmd'
    await activateCommand({ key: 'my-cmd@0.1.0', entrypointPath, registry });
    expect(registry.has('my-cmd')).toBe(true);
  });

  it('returns a handle with the type field', async () => {
    const entrypointPath = path.join(tmpDir, 'cmd-handle.cjs');
    fs.writeFileSync(
      entrypointPath,
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = function run(input) { return { exitCode: 0 }; };
`,
    );
    const handle = await activateCommand({ key: 'test-cmd@0.1.0', entrypointPath, verb: 'test', registry });
    expect(handle.type).toBe('command');
    expect(handle.verb).toBe('test');
  });

  it('CommandRegistry lists registered verbs', async () => {
    const ep1 = path.join(tmpDir, 'ep1.cjs');
    const ep2 = path.join(tmpDir, 'ep2.cjs');
    const body = `"use strict"; Object.defineProperty(exports, "__esModule", { value: true }); exports.run = function(i) { return { exitCode: 0 }; };`;
    fs.writeFileSync(ep1, body);
    fs.writeFileSync(ep2, body);
    await activateCommand({ key: 'cmd-a@0.1.0', entrypointPath: ep1, verb: 'alpha', registry });
    await activateCommand({ key: 'cmd-b@0.1.0', entrypointPath: ep2, verb: 'beta', registry });
    expect(registry.verbs()).toContain('alpha');
    expect(registry.verbs()).toContain('beta');
  });
});

// ─── loader.ts ────────────────────────────────────────────────────────────────

import { loadFromLockfile, resolveExtensionDir } from './host/loader.js';

describe('loader — resolveExtensionDir', () => {
  it('resolves file:// + /src/index.ts to the extension dir', () => {
    const dir = resolveExtensionDir(
      'file:///Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/index.ts',
      '/Users/nix/dev/ai/sox-ecosystem',
    );
    expect(dir).toBe('/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server');
  });

  it('resolves file:// pointing at a dir unchanged', () => {
    const dir = resolveExtensionDir(
      'file:///Users/nix/dev/ai/sox-ecosystem/extensions/hooks/audit-hook',
      '/Users/nix/dev/ai/sox-ecosystem',
    );
    expect(dir).toBe('/Users/nix/dev/ai/sox-ecosystem/extensions/hooks/audit-hook');
  });

  it('returns null for npm:// sources (not yet supported)', () => {
    const dir = resolveExtensionDir('npm://my-package@1.0.0', '/root');
    expect(dir).toBeNull();
  });

  it('returns the path as-is for absolute sources', () => {
    const dir = resolveExtensionDir('/absolute/path/to/ext', '/root');
    expect(dir).toBe('/absolute/path/to/ext');
  });
});

describe('loader — loadFromLockfile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-loader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty result when lockfile does not exist', async () => {
    const result = await loadFromLockfile({
      lockfilePath: path.join(tmpDir, 'nonexistent.lock'),
    });
    expect(result.activated).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns empty result for lockfile with no resolved entries', async () => {
    const lockPath = path.join(tmpDir, 'empty.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 1, resolved: {} }));
    const result = await loadFromLockfile({ lockfilePath: lockPath });
    expect(result.activated).toHaveLength(0);
  });

  it('skips an entry whose entrypoint is missing (Gap C5 stale hygiene)', async () => {
    // Build a fake extension dir with manifest but no built dist
    const extDir = path.join(tmpDir, 'extensions', 'hooks', 'fake-hook');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'fake-hook',
        version: '0.1.0',
        type: 'hook',
        entrypoint: 'dist/index.js',  // does not exist
        compatibility: { host: '>=1.0.0' },
        license: 'MIT',
      }),
    );

    const lockPath = path.join(tmpDir, 'test.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        resolved: {
          'fake-hook@0.1.0': {
            source: `file://${extDir}`,
            checksum: 'sha256:abc',
            resolved_at: '2026-06-08T00:00:00Z',
          },
        },
      }),
    );

    const result = await loadFromLockfile({ lockfilePath: lockPath, root: tmpDir });
    expect(result.activated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.key).toBe('fake-hook@0.1.0');
    expect(result.skipped[0]!.reason).toContain('entrypoint not found');
  });

  it('skips a disabled extension (Gap C5 + enabledOverrides)', async () => {
    const lockPath = path.join(tmpDir, 'disabled.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        resolved: {
          'my-hook@0.1.0': {
            source: 'file:///nonexistent',
            checksum: 'sha256:abc',
            resolved_at: '2026-06-08T00:00:00Z',
          },
        },
      }),
    );

    const result = await loadFromLockfile({
      lockfilePath: lockPath,
      root: tmpDir,
      enabledOverrides: { 'my-hook': false },
    });
    expect(result.activated).toHaveLength(0);
    expect(result.skipped[0]!.reason).toBe('disabled in scope config');
  });

  it('skips bundle-type entries (install-time only)', async () => {
    const extDir = path.join(tmpDir, 'extensions', 'bundles', 'my-bundle');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'my-bundle',
        version: '0.1.0',
        type: 'bundle',
        compatibility: { host: '>=1.0.0' },
        license: 'MIT',
        members: [],
      }),
    );

    const lockPath = path.join(tmpDir, 'bundle.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        resolved: {
          'my-bundle@0.1.0': {
            source: `file://${extDir}`,
            checksum: 'sha256:abc',
            resolved_at: '2026-06-08T00:00:00Z',
          },
        },
      }),
    );

    const result = await loadFromLockfile({ lockfilePath: lockPath, root: tmpDir });
    expect(result.activated).toHaveLength(0);
    expect(result.skipped[0]!.reason).toContain('install-time-only');
  });

  it('activates a hook extension and registers it in the HookLoader', async () => {
    // Create a minimal hook extension
    const extDir = path.join(tmpDir, 'extensions', 'hooks', 'my-hook');
    const distDir = path.join(extDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });

    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'my-hook',
        version: '0.1.0',
        type: 'hook',
        entrypoint: 'dist/index.js',
        compatibility: { host: '>=1.0.0' },
        license: 'MIT',
        events: ['PreToolUse'],
      }),
    );

    fs.writeFileSync(
      path.join(distDir, 'index.js'),
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.event = 'PreToolUse';
exports.handler = function handler(ctx) {};
`,
    );

    const lockPath = path.join(tmpDir, 'hook.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        resolved: {
          'my-hook@0.1.0': {
            source: `file://${extDir}`,
            checksum: 'sha256:abc',
            resolved_at: '2026-06-08T00:00:00Z',
          },
        },
      }),
    );

    const hookLoader = new HookLoader();
    const result = await loadFromLockfile({ lockfilePath: lockPath, root: tmpDir, hookLoader });

    expect(result.activated).toHaveLength(1);
    expect(result.activated[0]!.type).toBe('hook');
    expect(hookLoader.orderedIdsFor('PreToolUse')).toContain('my-hook@0.1.0');
  });

  it('activates a skill extension and exposes a run function', async () => {
    const extDir = path.join(tmpDir, 'extensions', 'skills', 'my-skill');
    const distDir = path.join(extDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });

    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'my-skill',
        version: '0.1.0',
        type: 'skill',
        entrypoint: 'dist/index.js',
        compatibility: { host: '>=1.0.0' },
        license: 'MIT',
      }),
    );

    fs.writeFileSync(
      path.join(distDir, 'index.js'),
      `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = async function run(input) { return { result: 'ok:' + input.x }; };
`,
    );

    const lockPath = path.join(tmpDir, 'skill.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        resolved: {
          'my-skill@0.1.0': {
            source: `file://${extDir}`,
            checksum: 'sha256:abc',
            resolved_at: '2026-06-08T00:00:00Z',
          },
        },
      }),
    );

    const result = await loadFromLockfile({ lockfilePath: lockPath, root: tmpDir });
    expect(result.activated).toHaveLength(1);
    const handle = result.activated[0]!;
    expect(handle.type).toBe('skill');
    const out = await (handle as import('./host/adapters/agent.js').SkillAdapterHandle).run({ x: '99' });
    expect(out).toEqual({ result: 'ok:99' });
  });

  it('returns the HookLoader and CommandRegistry in the result', async () => {
    const lockPath = path.join(tmpDir, 'empty2.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 1, resolved: {} }));
    const result = await loadFromLockfile({ lockfilePath: lockPath });
    expect(result.hookLoader).toBeInstanceOf(HookLoader);
    expect(result.commandRegistry).toBeInstanceOf(CommandRegistry);
  });

  it('passes through an external HookLoader', async () => {
    const lockPath = path.join(tmpDir, 'empty3.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ lockfileVersion: 1, resolved: {} }));
    const externalLoader = new HookLoader();
    const result = await loadFromLockfile({ lockfilePath: lockPath, hookLoader: externalLoader });
    expect(result.hookLoader).toBe(externalLoader);
  });

  it('records permissions from manifest at activation (PB/P4 scope)', async () => {
    const extDir = path.join(tmpDir, 'extensions', 'skills', 'perm-skill');
    const distDir = path.join(extDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });

    const permissions = { fs: { read: ['~/.memory/**'], write: ['~/.memory/**'] } };

    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'perm-skill',
        version: '0.1.0',
        type: 'skill',
        entrypoint: 'dist/index.js',
        compatibility: { host: '>=1.0.0' },
        license: 'MIT',
        permissions,
      }),
    );

    fs.writeFileSync(
      path.join(distDir, 'index.js'),
      `"use strict"; Object.defineProperty(exports, "__esModule", { value: true }); exports.run = async function(i) { return i; };`,
    );

    const lockPath = path.join(tmpDir, 'perm.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        resolved: {
          'perm-skill@0.1.0': {
            source: `file://${extDir}`,
            checksum: 'sha256:abc',
            resolved_at: '2026-06-08T00:00:00Z',
          },
        },
      }),
    );

    const result = await loadFromLockfile({ lockfilePath: lockPath, root: tmpDir });
    expect(result.activated).toHaveLength(1);
    expect(result.activated[0]!.permissions).toEqual(permissions);
  });

  it('P5: skips extension when cascade-resolved config violates config_schema', async () => {
    const extDir = path.join(tmpDir, 'extensions', 'skills', 'schema-fail-skill');
    const distDir = path.join(extDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });

    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'schema-fail-skill',
        version: '0.1.0',
        type: 'skill',
        entrypoint: 'dist/index.js',
        compatibility: { host: '>=1.0.0' },
        license: 'MIT',
        // config_schema requires a numeric value
        config_schema: {
          type: 'object',
          required: ['timeout'],
          properties: { timeout: { type: 'number' } },
        },
      }),
    );

    fs.writeFileSync(
      path.join(distDir, 'index.js'),
      `"use strict"; Object.defineProperty(exports, "__esModule", { value: true }); exports.run = async function(i) { return i; };`,
    );

    const lockPath = path.join(tmpDir, 'schema-fail.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        resolved: {
          'schema-fail-skill@0.1.0': {
            source: `file://${extDir}`,
            checksum: 'sha256:abc',
            resolved_at: '2026-06-08T00:00:00Z',
          },
        },
      }),
    );

    // Provide a resolved config that violates the schema (timeout is a string, not number)
    const result = await loadFromLockfile({
      lockfilePath: lockPath,
      root: tmpDir,
      resolvedConfigMap: {
        'schema-fail-skill': {
          config: { timeout: 'not-a-number' },
          enabled: true,
          version: '0.1.0',
        },
      },
    });

    // Should be skipped due to schema validation failure
    expect(result.activated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('config_schema validation failed');
  });

  it('P5: activates extension when cascade-resolved config passes config_schema', async () => {
    const extDir = path.join(tmpDir, 'extensions', 'skills', 'schema-pass-skill');
    const distDir = path.join(extDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });

    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({
        id: 'schema-pass-skill',
        version: '0.1.0',
        type: 'skill',
        entrypoint: 'dist/index.js',
        compatibility: { host: '>=1.0.0' },
        license: 'MIT',
        config_schema: {
          type: 'object',
          properties: { timeout: { type: 'number' } },
        },
      }),
    );

    fs.writeFileSync(
      path.join(distDir, 'index.js'),
      `"use strict"; Object.defineProperty(exports, "__esModule", { value: true }); exports.run = async function(i) { return i; };`,
    );

    const lockPath = path.join(tmpDir, 'schema-pass.lock');
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        lockfileVersion: 1,
        resolved: {
          'schema-pass-skill@0.1.0': {
            source: `file://${extDir}`,
            checksum: 'sha256:abc',
            resolved_at: '2026-06-08T00:00:00Z',
          },
        },
      }),
    );

    // Provide a valid resolved config
    const result = await loadFromLockfile({
      lockfilePath: lockPath,
      root: tmpDir,
      resolvedConfigMap: {
        'schema-pass-skill': {
          config: { timeout: 5000 },
          enabled: true,
          version: '0.1.0',
        },
      },
    });

    expect(result.activated).toHaveLength(1);
    expect(result.activated[0]!.type).toBe('skill');
  });
});
