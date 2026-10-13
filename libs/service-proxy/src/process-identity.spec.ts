/**
 * process-identity.spec.ts — 8468f7b1 SP7 (readProcessStartToken table) and
 * SP8 (isSameProcess table). `ps` and the clock-free liveness check are injected
 * or mocked: nothing here spawns a process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock, spawn: vi.fn() }));

import { isSameProcess, readProcessStartToken, type ProcessIdentityDeps } from './process-identity.js';

const TOKEN = 'Mon Oct 12 09:15:02 2026';

afterEach(() => {
  execFileSyncMock.mockReset();
  vi.restoreAllMocks();
});

const psReturning = (out: string): NonNullable<ProcessIdentityDeps['execFileSync']> => vi.fn(() => out);
const psThrowing = (err: unknown): NonNullable<ProcessIdentityDeps['execFileSync']> =>
  vi.fn(() => {
    throw err;
  });

describe('8468f7b1 SP7 readProcessStartToken', () => {
  it('SP7 returns the ps lstart text', () => {
    expect(readProcessStartToken(4242, { execFileSync: psReturning(TOKEN + '\n') })).toBe(TOKEN);
  });

  it('SP7 trims surrounding whitespace', () => {
    expect(readProcessStartToken(4242, { execFileSync: psReturning('  ' + TOKEN + ' \n\n') })).toBe(TOKEN);
  });

  it('SP7 empty or whitespace-only output is null', () => {
    expect(readProcessStartToken(4242, { execFileSync: psReturning('') })).toBeNull();
    expect(readProcessStartToken(4242, { execFileSync: psReturning(' \n') })).toBeNull();
  });

  it('SP7 ps throwing (missing binary, exit 1 for an absent pid) is null, never a throw', () => {
    expect(readProcessStartToken(4242, { execFileSync: psThrowing(Object.assign(new Error('x'), { code: 'ENOENT' })) })).toBeNull();
    expect(readProcessStartToken(4242, { execFileSync: psThrowing(Object.assign(new Error('x'), { status: 1 })) })).toBeNull();
  });

  it('SP7 a ps timeout (ETIMEDOUT) is null', () => {
    expect(readProcessStartToken(4242, { execFileSync: psThrowing(Object.assign(new Error('spawnSync ps ETIMEDOUT'), { code: 'ETIMEDOUT' })) })).toBeNull();
  });

  it('SP7 non-POSIX platform is null without running ps', () => {
    const ps = vi.fn(() => TOKEN);
    const orig = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(readProcessStartToken(4242, { execFileSync: ps })).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', orig);
    }
    expect(ps).not.toHaveBeenCalled();
  });

  it('SP7 invalid pids are null without running ps', () => {
    const ps = vi.fn(() => TOKEN);
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(readProcessStartToken(pid, { execFileSync: ps })).toBeNull();
    expect(ps).not.toHaveBeenCalled();
  });

  it('SP7 passes LC_ALL=C, TZ=UTC, a 1000 ms timeout, utf8 and the exact ps argv', () => {
    const ps = vi.fn((_c: string, _a: string[], _o: { encoding: 'utf8'; timeout: number; env: NodeJS.ProcessEnv }) => TOKEN);
    vi.stubEnv('LC_ALL', 'de_DE.UTF-8');
    vi.stubEnv('LANG', 'de_DE.UTF-8');
    vi.stubEnv('TZ', 'Asia/Tokyo');
    readProcessStartToken(4242, { execFileSync: ps });
    vi.unstubAllEnvs();
    expect(ps).toHaveBeenCalledTimes(1);
    const [cmd, args, o] = ps.mock.calls[0]!;
    expect(cmd).toBe('ps');
    expect(args).toEqual(['-o', 'lstart=', '-p', '4242']);
    expect(o.env.LC_ALL).toBe('C');
    expect(o.env.TZ).toBe('UTC');
    expect(o.timeout).toBe(1000);
    expect(o.encoding).toBe('utf8');
  });

  it('SP7 the default reader is node:child_process.execFileSync (mocked here)', () => {
    execFileSyncMock.mockReturnValue(TOKEN + '\n');
    expect(readProcessStartToken(77)).toBe(TOKEN);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(execFileSyncMock.mock.calls[0]![0]).toBe('ps');
  });
});

describe('8468f7b1 SP8 isSameProcess', () => {
  const alive = (v: boolean) => vi.fn(() => v);

  it('SP8 dead pid is false regardless of token, and ps is not consulted', () => {
    const ps = psReturning(TOKEN);
    expect(isSameProcess(9, TOKEN, { pidAlive: alive(false), execFileSync: ps })).toBe(false);
    expect(isSameProcess(9, null, { pidAlive: alive(false), execFileSync: ps })).toBe(false);
    expect(isSameProcess(9, undefined, { pidAlive: alive(false), execFileSync: ps })).toBe(false);
    expect(ps).not.toHaveBeenCalled();
  });

  it('SP8 null/undefined token is alive-only (0.5.0 behavior) and never runs ps', () => {
    const ps = psReturning('Tue Jan 1 00:00:00 2030');
    expect(isSameProcess(9, null, { pidAlive: alive(true), execFileSync: ps })).toBe(true);
    expect(isSameProcess(9, undefined, { pidAlive: alive(true), execFileSync: ps })).toBe(true);
    expect(ps).not.toHaveBeenCalled();
  });

  it('SP8 alive + equal token is true', () => {
    expect(isSameProcess(9, TOKEN, { pidAlive: alive(true), execFileSync: psReturning(TOKEN + '\n') })).toBe(true);
  });

  it('SP8 alive + different token is false (recycled pid)', () => {
    expect(isSameProcess(9, TOKEN, { pidAlive: alive(true), execFileSync: psReturning('Tue Oct 13 01:02:03 2026') })).toBe(false);
  });

  it('SP8 ps failure or empty output at check time fails toward keeping the lock (true)', () => {
    expect(isSameProcess(9, TOKEN, { pidAlive: alive(true), execFileSync: psThrowing(new Error('no ps')) })).toBe(true);
    expect(isSameProcess(9, TOKEN, { pidAlive: alive(true), execFileSync: psReturning('') })).toBe(true);
  });

  it('SP8 default liveness: the current process is the same process; an absurd pid is not', () => {
    const own = process.pid;
    expect(isSameProcess(own, null)).toBe(true);
    expect(isSameProcess(0, TOKEN)).toBe(false);
    expect(isSameProcess(-5, null)).toBe(false);
  });
});
