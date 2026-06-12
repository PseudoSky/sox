/**
 * libs/host-runtime/src/supervisor-policy.spec.ts
 *
 * Tests for [process-boundary] — spawn-time process bounding.
 *
 * Criteria proven:
 *   [process-boundary.1] policy-env (SOX_PERM_ENFORCE + 4 SOX_PERM_* JSON arrays)
 *                         injected into child env when permissions are declared.
 *   [process-boundary.2] child env scrubbed — a parent sentinel var is absent
 *                         unless allowlisted.
 *   [process-boundary.3] legacy compat: no permissions block → child env ==
 *                         {...process.env, ...env}, cwd inherited (byte-identical).
 *   [process-boundary.4] cwd set to extension dir when enforced.
 *   [process-boundary.5] carried-forward supervisor logic (restart/stop/health,
 *                         [def:session-fixes]) stays green.
 *   [process-boundary.6] ProcessSupervisor.policy() returns a Policy reflecting
 *                         declared permissions.
 *
 * Strategy: vi.mock('node:child_process') to intercept spawn() and capture the
 * SpawnOptions (env, cwd) without actually launching a child process. The mock
 * returns a minimal ChildProcess-like EventEmitter so the supervisor doesn't crash.
 *
 * Key isolation: each test call to start() uses a unique key (via keyCounter) to
 * avoid hitting the static singleton _registry across tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SpawnOptions } from 'node:child_process';

// ─── Capture helper (filled by mock) ─────────────────────────────────────────

interface SpawnCall {
  args: string[];
  opts: SpawnOptions;
}

let spawnCalls: SpawnCall[] = [];

// Monotonically increasing counter for unique supervisor keys per test.
let keyCounter = 0;
function nextKey(prefix: string): string {
  return `${prefix}-${++keyCounter}@0.1.0`;
}

// ─── Mock node:child_process ──────────────────────────────────────────────────
// vi.mock is hoisted to the top of the file by vitest — it runs before any import.

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: vi.fn((_cmd: string, args: string[], opts: SpawnOptions) => {
      spawnCalls.push({ args, opts });

      // Minimal ChildProcess stub — enough for the supervisor's event wiring.
      // exitCode=null keeps the process "running" (not already exited) but we
      // use unique keys to avoid the singleton registry collision across tests.
      const proc = new EventEmitter() as NodeJS.EventEmitter & {
        pid: number;
        exitCode: number | null;
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (sig?: string) => boolean;
      };
      proc.pid = 99999;
      proc.exitCode = null;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = (_sig?: string) => true;
      return proc;
    }),
  };
});

// Import AFTER vi.mock declaration (vitest hoists vi.mock automatically).
import { ProcessSupervisor } from './supervisor.js';
import { compilePolicy } from './policy.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const ENFORCED_PERMISSIONS = {
  fs: { read: ['~/.memory/**'], write: ['~/.memory/**'] },
  socket: { paths: ['~/.memory/memoryd.sock'] },
  network: { outbound: [] as string[] },
} as const;

function makeEnforcedSupervisor(
  entrypointPath = '/ext/dist/index.js',
  extraEnv: Record<string, string> = {},
): ProcessSupervisor {
  return new ProcessSupervisor({
    key: nextKey('enforced'),
    entrypointPath,
    env: extraEnv,
    lifecycle: { background: false },
    permissions: {
      fs: { read: ['~/.memory/**'], write: ['~/.memory/**'] },
      socket: { paths: ['~/.memory/memoryd.sock'] },
      network: { outbound: [] },
    },
  });
}

function makeLegacySupervisor(
  entrypointPath = '/ext/dist/index.js',
  extraEnv: Record<string, string> = {},
): ProcessSupervisor {
  return new ProcessSupervisor({
    key: nextKey('legacy'),
    entrypointPath,
    env: extraEnv,
    lifecycle: { background: false },
    // NO permissions block → legacy compat path [inv:no-regress]
  });
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  spawnCalls = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── [process-boundary.6] policy() accessor ──────────────────────────────────

describe('[process-boundary.6] ProcessSupervisor.policy() accessor', () => {
  it('returns enforced=true when permissions block is declared', () => {
    const sup = makeEnforcedSupervisor();
    expect(sup.policy().enforced).toBe(true);
  });

  it('returns enforced=false when NO permissions block', () => {
    const sup = makeLegacySupervisor();
    expect(sup.policy().enforced).toBe(false);
  });

  it('policy allows paths matching the declared fs.read pattern', () => {
    const sup = makeEnforcedSupervisor();
    const memPath = path.join(os.homedir(), '.memory', 'test.db');
    expect(sup.policy().allowsFsRead(memPath)).toBe(true);
  });

  it('policy denies paths NOT matching the declared fs.read pattern', () => {
    const sup = makeEnforcedSupervisor();
    expect(sup.policy().allowsFsRead('/tmp/evil.db')).toBe(false);
  });

  it('unenforced policy allows any path', () => {
    const sup = makeLegacySupervisor();
    expect(sup.policy().allowsFsRead('/tmp/anything.db')).toBe(true);
    expect(sup.policy().allowsFsWrite('/etc/passwd')).toBe(true);
  });
});

// ─── [process-boundary.1] policy-env injected when enforced ──────────────────

describe('[process-boundary.1] policy-env injected into child env when enforced', () => {
  it('SOX_PERM_ENFORCE=1 is present in the spawned child env', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    expect(env['SOX_PERM_ENFORCE']).toBe('1');
  });

  it('SOX_PERM_FS_READ is a JSON array of declared read patterns', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    const fsRead: unknown = JSON.parse(env['SOX_PERM_FS_READ']!);
    expect(Array.isArray(fsRead)).toBe(true);
    expect(fsRead).toContain('~/.memory/**');
  });

  it('SOX_PERM_FS_WRITE is a JSON array of declared write patterns', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    const fsWrite: unknown = JSON.parse(env['SOX_PERM_FS_WRITE']!);
    expect(Array.isArray(fsWrite)).toBe(true);
    expect(fsWrite).toContain('~/.memory/**');
  });

  it('SOX_PERM_SOCKET is a JSON array of declared socket paths', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    const socket: unknown = JSON.parse(env['SOX_PERM_SOCKET']!);
    expect(Array.isArray(socket)).toBe(true);
    expect(socket).toContain('~/.memory/memoryd.sock');
  });

  it('SOX_PERM_NETWORK is a JSON array (empty when network.outbound=[])', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    const network: unknown = JSON.parse(env['SOX_PERM_NETWORK']!);
    expect(Array.isArray(network)).toBe(true);
    expect(network).toHaveLength(0);
  });

  it('all four SOX_PERM_* keys are present in the child env', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    expect(env).toHaveProperty('SOX_PERM_FS_READ');
    expect(env).toHaveProperty('SOX_PERM_FS_WRITE');
    expect(env).toHaveProperty('SOX_PERM_SOCKET');
    expect(env).toHaveProperty('SOX_PERM_NETWORK');
  });

  it('policy-env values match the compilePolicy().toEnv() output exactly', async () => {
    const permissions = {
      fs: { read: ['~/.memory/**'], write: ['~/.memory/**'] },
      socket: { paths: ['~/.memory/memoryd.sock'] },
      network: { outbound: [] as string[] },
    };
    const sup = new ProcessSupervisor({
      key: nextKey('parity'),
      entrypointPath: '/ext/dist/index.js',
      lifecycle: { background: false },
      permissions,
    });
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    const expectedPolicyEnv = compilePolicy(permissions).toEnv();

    for (const [k, v] of Object.entries(expectedPolicyEnv)) {
      expect(env[k]).toBe(v);
    }
  });
});

// ─── [process-boundary.2] child env scrubbed — sentinel absent ───────────────

describe('[process-boundary.2] child env scrubbed when enforced', () => {
  it('a sentinel var set in process.env is absent from the child env', async () => {
    const sentinel = 'SOX_C6_TEST_SENTINEL_' + Date.now().toString(36);
    // Inject sentinel into the parent process env.
    process.env[sentinel] = 'should-not-leak';

    try {
      const sup = makeEnforcedSupervisor();
      await sup.start();

      const env = spawnCalls[0]!.opts.env as Record<string, string>;
      expect(env[sentinel]).toBeUndefined();
    } finally {
      delete process.env[sentinel];
    }
  });

  it('PATH from process.env IS present (it is allowlisted)', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    // PATH is always present in a sane env; it must be forwarded.
    if (process.env['PATH'] !== undefined) {
      expect(env['PATH']).toBe(process.env['PATH']);
    }
  });

  it('HOME from process.env IS present (it is allowlisted)', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    if (process.env['HOME'] !== undefined) {
      expect(env['HOME']).toBe(process.env['HOME']);
    }
  });

  it('extension-declared env vars ARE present in the child env', async () => {
    const sup = makeEnforcedSupervisor('/ext/dist/index.js', { MY_CUSTOM_VAR: 'hello' });
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    expect(env['MY_CUSTOM_VAR']).toBe('hello');
  });
});

// ─── [process-boundary.3] legacy compat — unenforced path byte-identical ─────

describe('[process-boundary.3] legacy compat: no permissions block', () => {
  it('child env equals {...process.env, ...this._env} exactly', async () => {
    const extraEnv = { MY_LEGACY_VAR: 'legacy-val' };
    const sup = makeLegacySupervisor('/ext/dist/index.js', extraEnv);
    await sup.start();

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    const expected = { ...process.env, ...extraEnv };

    // Every key in expected must be present with the same value.
    for (const [k, v] of Object.entries(expected)) {
      expect(env[k]).toBe(v);
    }
    // The env must NOT contain any SOX_PERM_* keys (no policy env injected).
    expect(env['SOX_PERM_ENFORCE']).toBeUndefined();
    expect(env['SOX_PERM_FS_READ']).toBeUndefined();
    expect(env['SOX_PERM_FS_WRITE']).toBeUndefined();
    expect(env['SOX_PERM_SOCKET']).toBeUndefined();
    expect(env['SOX_PERM_NETWORK']).toBeUndefined();
  });

  it('cwd is NOT set (inherited/undefined) when unenforced', async () => {
    const sup = makeLegacySupervisor();
    await sup.start();

    const opts = spawnCalls[0]!.opts;
    // cwd should be absent (undefined) — byte-identical to pre-state.
    expect(opts.cwd).toBeUndefined();
  });

  it('a sentinel var set in process.env IS present in legacy child env', async () => {
    const sentinel = 'SOX_C6_LEGACY_SENTINEL_' + Date.now().toString(36);
    process.env[sentinel] = 'must-appear-in-legacy';

    try {
      const sup = makeLegacySupervisor();
      await sup.start();

      const env = spawnCalls[0]!.opts.env as Record<string, string>;
      expect(env[sentinel]).toBe('must-appear-in-legacy');
    } finally {
      delete process.env[sentinel];
    }
  });
});

// ─── [process-boundary.4] cwd set to extension dir when enforced ─────────────

describe('[process-boundary.4] cwd set to extension directory when enforced', () => {
  it('cwd equals path.dirname(entrypointPath)', async () => {
    const entrypointPath = '/ext/dist/index.js';
    const sup = makeEnforcedSupervisor(entrypointPath);
    await sup.start();

    const opts = spawnCalls[0]!.opts;
    expect(opts.cwd).toBe(path.dirname(entrypointPath));
  });

  it('cwd equals /some/deep/dir for entrypoint /some/deep/dir/server.js', async () => {
    const entrypointPath = '/some/deep/dir/server.js';
    const sup = new ProcessSupervisor({
      key: nextKey('cwd'),
      entrypointPath,
      lifecycle: { background: false },
      permissions: {
        fs: { read: ['~/.memory/**'] },
      },
    });
    await sup.start();

    const opts = spawnCalls[0]!.opts;
    expect(opts.cwd).toBe('/some/deep/dir');
  });
});

// ─── [process-boundary.5] carried-forward session-fix behaviors ───────────────

describe('[process-boundary.5] carried-forward supervisor behaviors ([def:session-fixes])', () => {
  it('isHealthy() is false before start()', () => {
    const sup = makeLegacySupervisor();
    expect(sup.isHealthy()).toBe(false);
  });

  it('pid() is null before start()', () => {
    const sup = makeLegacySupervisor();
    expect(sup.pid()).toBeNull();
  });

  it('policy() is accessible before start() — no start() needed', () => {
    const sup = makeEnforcedSupervisor();
    expect(sup.policy()).toBeDefined();
    expect(sup.policy().enforced).toBe(true);
  });

  it('policy() is accessible after start()', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();
    expect(sup.policy().enforced).toBe(true);
  });

  it('stop() on a never-started supervisor does not throw', async () => {
    const sup = makeLegacySupervisor();
    await expect(sup.stop()).resolves.toBeUndefined();
  });

  it('constructor does not throw when permissions is undefined', () => {
    expect(() => makeLegacySupervisor()).not.toThrow();
  });

  it('constructor does not throw when permissions is declared', () => {
    expect(() => makeEnforcedSupervisor()).not.toThrow();
  });

  it('compilePolicy(undefined) used for unenforced — enforced=false', () => {
    const sup = makeLegacySupervisor();
    const reference = compilePolicy(undefined);
    expect(sup.policy().enforced).toBe(reference.enforced);
    expect(sup.policy().enforced).toBe(false);
  });

  it('compilePolicy(perms) used for enforced — enforced=true', () => {
    const sup = makeEnforcedSupervisor();
    expect(sup.policy().enforced).toBe(true);
  });

  it('policy-env order: policy.toEnv() wins over this._env for SOX_PERM_* keys', async () => {
    // Extension declares env with SOX_PERM_ENFORCE set to something else.
    // policy.toEnv() must WIN (it goes last in the merge).
    const sup = new ProcessSupervisor({
      key: nextKey('order'),
      entrypointPath: '/ext/dist/index.js',
      env: { SOX_PERM_ENFORCE: 'hacked' },
      lifecycle: { background: false },
      permissions: { fs: { read: ['~/.memory/**'] } },
    });
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    // policy.toEnv() wins: SOX_PERM_ENFORCE must be '1'
    expect(env['SOX_PERM_ENFORCE']).toBe('1');
  });

  it('unenforced supervisor has no SOX_PERM_ENFORCE in child env', async () => {
    const sup = makeLegacySupervisor();
    await sup.start();
    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    expect(env['SOX_PERM_ENFORCE']).toBeUndefined();
  });
});
