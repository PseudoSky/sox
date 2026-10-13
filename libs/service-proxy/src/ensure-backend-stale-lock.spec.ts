/**
 * ensure-backend-stale-lock.spec.ts — 8468f7b1 SP9..SP12: the spawn lock decides
 * staleness with a process START TOKEN, not bare kill(pid,0).
 *
 * `node:child_process` is mocked (no backend is ever spawned, no `ps` runs); the
 * clock is faked via vitest (Date only). Lock files live in a mkdtemp dir.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock, execFileSync: execFileSyncMock }));

import { ensureBackend, type EnsureBackendOptions } from './ensure-backend.js';

const NOW = new Date('2026-10-12T12:00:00Z').getTime();
const HOLDER_PID = 4242;
const HOLDER_TOKEN = 'Mon Oct 12 08:00:00 2026';
const SELF_TOKEN = 'Mon Oct 12 07:00:00 2026';
const KEY = 'stale-lock-key';

/** Mirror of ensure-backend's private FNV-1a lockName (the lock filename contract). */
function lockName(k: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < k.length; i++) {
    h ^= k.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `proxy-backend-${h.toString(16).padStart(8, '0')}.lock`;
}

let dir: string;
let lockPath: string;
let ps: ReturnType<typeof vi.fn>;
let holderAlive: boolean;
let holderTokenNow: string | Error;
let lockSeenAtSpawn: string | null;

function fakeChild(): EventEmitter & { pid: number; unref: () => void } {
  return Object.assign(new EventEmitter(), { pid: 99001, unref: () => {} });
}

/** ps stub: SELF_TOKEN for our own pid, `holderTokenNow` for HOLDER_PID. */
function installPs(): void {
  ps = vi.fn((_c: string, args: string[]) => {
    const pid = Number(args[args.length - 1]);
    if (pid === process.pid) return SELF_TOKEN + '\n';
    if (pid === HOLDER_PID) {
      if (holderTokenNow instanceof Error) throw holderTokenNow;
      return holderTokenNow + '\n';
    }
    throw new Error('unexpected pid ' + String(pid));
  });
}

function opts(extra: Partial<EnsureBackendOptions> = {}): EnsureBackendOptions {
  return {
    socketPath: path.join(dir, 'b.sock'),
    singletonKey: KEY,
    command: 'node',
    args: ['backend.js'],
    onDiagnostic: () => {},
    readyTimeoutMs: 300,
    probeTimeoutMs: 40,
    processIdentity: {
      execFileSync: ps as never,
      pidAlive: (pid) => (pid === HOLDER_PID ? holderAlive : pid === process.pid),
    },
    ...extra,
  };
}

function seedLock(payload: Record<string, unknown>): void {
  fs.writeFileSync(lockPath, JSON.stringify(payload));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-stale-lock-'));
  fs.chmodSync(dir, 0o700);
  lockPath = path.join(dir, lockName(KEY));
  holderAlive = true;
  holderTokenNow = HOLDER_TOKEN;
  lockSeenAtSpawn = null;
  installPs();
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    lockSeenAtSpawn = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
    return fakeChild();
  });
  // Date only, auto-advancing: ensureBackend's deadline loops read Date.now().
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('8468f7b1 SP9 a 0.5.0 lock (no token) is evaluated exactly as before', () => {
  it('SP9 live holder, fresh, no token: honored; no spawn; ps never consulted', async () => {
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY });
    const r = await ensureBackend(opts());
    expect(r.disposition).toBe('failed');
    expect(r.detail).toMatch(/timed out waiting for a peer/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(ps).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('SP9 dead holder, no token: reclaimed (0.5.0 liveness rule)', async () => {
    holderAlive = false;
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY });
    await ensureBackend(opts());
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('SP9 TTL-expired lock, no token, live holder: reclaimed', async () => {
    seedLock({ pid: HOLDER_PID, t: NOW - 31_000, key: KEY });
    await ensureBackend(opts());
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('SP9 a lock younger than a custom lockTtlMs is honored, an older one reclaimed', async () => {
    seedLock({ pid: HOLDER_PID, t: NOW - 5_000, key: KEY });
    await ensureBackend(opts({ lockTtlMs: 10_000 }));
    expect(spawnMock).not.toHaveBeenCalled();
    await ensureBackend(opts({ lockTtlMs: 4_000 }));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('SP9 corrupt lock is reclaimed; a non-string startToken is ignored like an absent one', async () => {
    fs.writeFileSync(lockPath, '{not json');
    await ensureBackend(opts());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    spawnMock.mockClear();
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY, startToken: 12345 });
    const r = await ensureBackend(opts());
    expect(spawnMock).not.toHaveBeenCalled();
    expect(r.disposition).toBe('failed');
  });
});

describe('8468f7b1 SP10 pid reuse: alive pid with a different start token is reclaimed immediately', () => {
  it('SP10 fresh lock (not TTL-stale), live pid, token differs: reclaimed and we spawn', async () => {
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY, startToken: HOLDER_TOKEN });
    holderTokenNow = 'Tue Oct 13 03:03:03 2026'; // pid recycled to a newer process
    await ensureBackend(opts());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockPath)).toBe(false); // released after the (failed) spawn attempt
  });

  it('SP10 same token: the live holder is honored (no spawn, lock kept)', async () => {
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY, startToken: HOLDER_TOKEN });
    const r = await ensureBackend(opts());
    expect(spawnMock).not.toHaveBeenCalled();
    expect(r.detail).toMatch(/timed out waiting for a peer/);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it('SP10 dead holder with a token is reclaimed without running ps', async () => {
    holderAlive = false;
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY, startToken: HOLDER_TOKEN });
    await ensureBackend(opts());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(ps.mock.calls.every((c) => Number(c[1][c[1].length - 1]) === process.pid)).toBe(true);
  });

  it('SP10 the reclaiming winner records its OWN start token in the new lock', async () => {
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY, startToken: HOLDER_TOKEN });
    holderTokenNow = 'Tue Oct 13 03:03:03 2026';
    await ensureBackend(opts());
    const written = JSON.parse(lockSeenAtSpawn!) as { pid: number; t: number; key: string; startToken?: string };
    expect(written).toMatchObject({ pid: process.pid, key: KEY, startToken: SELF_TOKEN });
    expect(Math.abs(written.t - NOW)).toBeLessThan(5000);
  });
});

describe('8468f7b1 SP11 ps is not run on already-live or the uncontended path (beyond one cached self read)', () => {
  it('SP11 already-live (a live socket) never runs ps and never spawns', async () => {
    const sock = path.join(dir, 'live.sock');
    const server = net.createServer((c) => c.on('error', () => {}));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, resolve);
    });
    try {
      const r = await ensureBackend(opts({ socketPath: sock }));
      expect(r.disposition).toBe('already-live');
      expect(ps).not.toHaveBeenCalled();
      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('SP11 uncontended spawn runs ps exactly once, for our own pid, and writes the token', async () => {
    await ensureBackend(opts());
    expect(ps).toHaveBeenCalledTimes(1);
    expect(ps.mock.calls[0]![1]).toEqual(['-o', 'lstart=', '-p', String(process.pid)]);
    expect(JSON.parse(lockSeenAtSpawn!).startToken).toBe(SELF_TOKEN);
  });

  it('SP11 with the real (non-injected) reader the self token is cached for the process lifetime', async () => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(SELF_TOKEN + '\n');
    const fresh = await import('./ensure-backend.js');
    const { processIdentity: _injected, ...base } = opts();
    await fresh.ensureBackend(base);
    await fresh.ensureBackend(base);
    await fresh.ensureBackend(base);
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });

  it('SP11 contending against a token-less live lock does not run ps at all', async () => {
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY });
    await ensureBackend(opts());
    expect(ps).not.toHaveBeenCalled();
  });
});

describe('8468f7b1 SP12 any token-read failure leaves dispositions identical to 0.5.0', () => {
  it('SP12 ps fails at CHECK time: a live, fresh, tokened lock is honored (0.5.0)', async () => {
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY, startToken: HOLDER_TOKEN });
    holderTokenNow = new Error('ps: command not found');
    const r = await ensureBackend(opts());
    expect(spawnMock).not.toHaveBeenCalled();
    expect(r.disposition).toBe('failed');
    expect(r.detail).toMatch(/timed out waiting for a peer/);
  });

  it('SP12 ps fails at CHECK time: a dead holder is still reclaimed and a TTL-expired one too', async () => {
    holderTokenNow = new Error('ps broken');
    holderAlive = false;
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY, startToken: HOLDER_TOKEN });
    await ensureBackend(opts());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    spawnMock.mockClear();
    holderAlive = true;
    seedLock({ pid: HOLDER_PID, t: NOW - 60_000, key: KEY, startToken: HOLDER_TOKEN });
    await ensureBackend(opts());
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('SP12 ps fails at WRITE time: spawn proceeds and the lock omits startToken (0.5.0 shape)', async () => {
    ps.mockImplementation(() => {
      throw new Error('ps unavailable');
    });
    const r = await ensureBackend(opts());
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(r.disposition).toBe('failed'); // fake child never binds; same as 0.5.0 would report
    const w = JSON.parse(lockSeenAtSpawn!) as Record<string, unknown>;
    expect(Object.keys(w).sort()).toEqual(['key', 'pid', 't']);
    expect(w.pid).toBe(process.pid);
  });

  it('SP12 a lock we wrote is readable by a 0.5.0 reader (pid/t/key intact, extra field ignorable)', async () => {
    await ensureBackend(opts());
    const parsed = JSON.parse(lockSeenAtSpawn!) as { pid: unknown; t: unknown; key: unknown };
    expect(typeof parsed.pid).toBe('number');
    expect(typeof parsed.t).toBe('number');
    expect(parsed.key).toBe(KEY);
  });

  it('SP12 thundering herd of 5 against a recycled-pid lock: all concurrent callers terminate with only the O_EXCL winner spawning', async () => {
    seedLock({ pid: HOLDER_PID, t: NOW, key: KEY, startToken: HOLDER_TOKEN });
    holderTokenNow = 'Tue Oct 13 03:03:03 2026';
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => ensureBackend(opts())));
    expect(results).toHaveLength(5);
    // Exactly one spawn: the recycled-pid lock is reclaimed by one O_EXCL winner; the other four
    // either see the winner's fresh lock (and wait/adopt) or probe the socket. A double spawn means
    // two callers both believed they held the lock.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    for (const r of results) expect(['failed', 'adopted-after-wait', 'spawned']).toContain(r.disposition);
  });
});

describe('8468f7b1 SP9 F7 the lock is never observable empty', () => {
  it('SP9 the self start token is read BEFORE the lock file is created (no empty-lock window)', async () => {
    const order: string[] = [];
    // A fresh-token read for our own pid must precede the O_EXCL create of the lock file.
    ps.mockImplementation((_c: string, args: string[]) => {
      if (Number(args[args.length - 1]) === process.pid) {
        order.push(fs.existsSync(lockPath) ? 'ps-after-create' : 'ps-before-create');
        return SELF_TOKEN + '\n';
      }
      throw new Error('unexpected pid');
    });
    spawnMock.mockImplementation(() => {
      order.push('spawn');
      return fakeChild();
    });
    await ensureBackend(opts());
    expect(order[0]).toBe('ps-before-create');
    expect(order).not.toContain('ps-after-create');
  });
});
