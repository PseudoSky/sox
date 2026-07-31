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
    // BL-344: this sentinel used to be `SOX_C6_TEST_SENTINEL_*`. `SOX_*` is now
    // a DELIBERATELY forwarded namespace — operator tunables
    // (`SOX_MEMORY_LOG_*`, `SOX_DISABLE_*`, …) were being silently dropped,
    // which broke two shipped tunables on their first outing and made a live
    // emergency brake a no-op.
    //
    // The invariant this test exists for is unchanged and still asserted: an
    // ARBITRARY parent variable must not leak into an enforced child. Only the
    // choice of sentinel moved, to a name outside the forwarded namespace.
    // The security-critical half is asserted immediately below.
    const sentinel = 'C6_TEST_SENTINEL_' + Date.now().toString(36);
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

  it('BL-344: an inherited SOX_PERM_* is REFUSED — forwarding SOX_* must not widen the sandbox', async () => {
    // The one genuinely unsafe case. `SOX_PERM_*` is the compiled permission
    // policy; if a child inherited it from the ambient environment, anyone able
    // to set an env var before the spawn could widen or disable enforcement.
    // Before BL-344 this was blocked incidentally (it simply was not on the
    // allowlist). Under a `SOX_*` prefix rule that protection has to be
    // explicit, so it is now a deny-list entry — and this is its regression test.
    process.env['SOX_PERM_ENFORCE'] = '0';
    process.env['SOX_PERM_FS_WRITE'] = '["/**"]';

    try {
      const sup = makeEnforcedSupervisor();
      await sup.start();

      const env = spawnCalls[0]!.opts.env as Record<string, string>;
      // The authoritative values come from policy.toEnv(), applied after the
      // scrub — so enforcement stays ON and the inherited widening is gone.
      expect(env['SOX_PERM_ENFORCE']).toBe('1');
      expect(env['SOX_PERM_FS_WRITE']).not.toBe('["/**"]');
    } finally {
      delete process.env['SOX_PERM_ENFORCE'];
      delete process.env['SOX_PERM_FS_WRITE'];
    }
  });

  it('BL-344: an operator SOX_* tunable DOES reach the enforced child', async () => {
    // The defect itself: this was silently dropped, with no warning anywhere,
    // and the operator's mental model ("I set the env var") was simply wrong.
    const tunable = 'SOX_MEMORY_LOG_LEVEL';
    const prev = process.env[tunable];
    process.env[tunable] = 'debug';

    try {
      const sup = makeEnforcedSupervisor();
      await sup.start();

      const env = spawnCalls[0]!.opts.env as Record<string, string>;
      expect(env[tunable]).toBe('debug');
    } finally {
      if (prev === undefined) delete process.env[tunable];
      else process.env[tunable] = prev;
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

// ─── [BL-52] SOX_EMBED_* forwarded through enforced env scrub ─────────────────
//
// The enforced env allowlist previously stripped SOX_EMBED_BACKEND and
// SOX_EMBED_CACHE_DIR, leaving the served/spawned server's embed() resolveConfig()
// reading undefined → backend='auto' → worker fails. (Historically this silently fell back to a
// hash backend; that backend was removed — createEmbeddingProvider() now throws ResolutionError
// instead of downgrading. See BL-52 for the original incident, BL-250 for the removal.)
// These tests assert the vars pass through the scrub.

describe('[BL-52] SOX_EMBED_* forwarded through enforced env scrub', () => {
  const EMBED_SENTINEL = 'SOX_EMBED_BACKEND';
  const CACHE_SENTINEL = 'SOX_EMBED_CACHE_DIR';
  const XDG_SENTINEL = 'XDG_CACHE_HOME';

  const savedEmbed = process.env[EMBED_SENTINEL];
  const savedCache = process.env[CACHE_SENTINEL];
  const savedXdg = process.env[XDG_SENTINEL];

  beforeEach(() => {
    process.env[EMBED_SENTINEL] = 'real';
    process.env[CACHE_SENTINEL] = '/tmp/sox-test-models';
    process.env[XDG_SENTINEL] = '/tmp/sox-xdg-cache';
  });

  afterEach(() => {
    if (savedEmbed === undefined) delete process.env[EMBED_SENTINEL];
    else process.env[EMBED_SENTINEL] = savedEmbed;
    if (savedCache === undefined) delete process.env[CACHE_SENTINEL];
    else process.env[CACHE_SENTINEL] = savedCache;
    if (savedXdg === undefined) delete process.env[XDG_SENTINEL];
    else process.env[XDG_SENTINEL] = savedXdg;
  });

  it('SOX_EMBED_BACKEND is forwarded through the enforced env scrub', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    expect(env['SOX_EMBED_BACKEND']).toBe('real');
  });

  it('SOX_EMBED_CACHE_DIR is forwarded through the enforced env scrub', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    expect(env['SOX_EMBED_CACHE_DIR']).toBe('/tmp/sox-test-models');
  });

  it('XDG_CACHE_HOME is forwarded through the enforced env scrub', async () => {
    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    expect(env['XDG_CACHE_HOME']).toBe('/tmp/sox-xdg-cache');
  });

  it('SOX_EMBED_* absent → not injected (undefined from scrub, not "" empty string)', async () => {
    delete process.env[EMBED_SENTINEL];
    delete process.env[CACHE_SENTINEL];

    const sup = makeEnforcedSupervisor();
    await sup.start();

    const env = spawnCalls[0]!.opts.env as Record<string, string>;
    // Must be absent (undefined), not an injected empty string
    expect(env[EMBED_SENTINEL]).toBeUndefined();
    expect(env[CACHE_SENTINEL]).toBeUndefined();
  });

  it('unrelated secrets are still scrubbed even when SOX_EMBED_* is set', async () => {
    const secret = 'MY_SECRET_TOKEN_' + Date.now().toString(36);
    process.env[secret] = 'should-not-appear';

    try {
      const sup = makeEnforcedSupervisor();
      await sup.start();

      const env = spawnCalls[0]!.opts.env as Record<string, string>;
      expect(env[secret]).toBeUndefined();
      // But embed vars are still there
      expect(env['SOX_EMBED_BACKEND']).toBe('real');
    } finally {
      delete process.env[secret];
    }
  });
});
