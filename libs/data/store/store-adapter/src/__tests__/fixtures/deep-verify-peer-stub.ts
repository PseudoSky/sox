/**
 * Shared harness for the peer-lock re-attempt races (BL-80965c9f,
 * BL-10b71ea6, BL-026af34c).
 *
 * A stub adapter is used on purpose: every one of these races lives between
 * two awaits inside `deep-verify.ts`, and only a controllable `executeGet`
 * makes the window deterministic.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import {
  _peerWaitPendingForTest,
  deepVerifyLockPath,
  scheduleDeepVerify,
  type ScheduleDeepVerifyOptions,
} from '../../deep-verify.js';
import { canonicalDbPath } from '../../path-identity.js';
import type { StoreAdapter } from '../../types.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export interface PeerStub {
  adapter: StoreAdapter;
  config: { dbPath: string; type: 'turso'; deepVerify: Record<string, unknown> };
  /** Every `executeGet`/`executeRun` the module issued through this adapter. */
  calls: string[];
  /** Resolves when the FIRST obligation read has been issued. */
  readIssued: Promise<void>;
  /** Controls the first obligation read; later reads resolve `OWED` at once. */
  read: Deferred<{ value: string } | null>;
}

export const OWED = {
  value: JSON.stringify({ reason: 'unclean_shutdown', since: '2026-09-27T00:00:00.000Z' }),
};

export function makeStub(dbPath: string): PeerStub {
  const calls: string[] = [];
  const read = deferred<{ value: string } | null>();
  const issued = deferred<void>();
  let reads = 0;
  const config = {
    dbPath,
    type: 'turso' as const,
    deepVerify: { schedule: 'owner', timeoutMs: 10_000, peerRetry: { initialMs: 100, maxMs: 400 } } as Record<
      string,
      unknown
    >,
  };
  const adapter = {
    config,
    executeGet: (sql: string) => {
      calls.push(`get:${sql}`);
      reads++;
      if (reads === 1) {
        issued.resolve();
        return read.promise;
      }
      return Promise.resolve(OWED);
    },
    executeRun: (sql: string) => {
      calls.push(`run:${sql}`);
      return Promise.resolve({ changes: 0 });
    },
  } as unknown as StoreAdapter;
  return { adapter, config, calls, readIssued: issued.promise, read };
}

export const OPTS: ScheduleDeepVerifyOptions = {
  fastResult: {
    verify: { ok: true, depth: 'fast', durationMs: 0, findings: [], damaged: [], unknown: [] },
    repair: null,
  } as unknown as ScheduleDeepVerifyOptions['fastResult'],
  reason: 'unclean_shutdown',
};

export async function macrotasks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20));
}

/**
 * A temp dir plus a live FOREIGN process whose pid holds deep-pass locks (our
 * own pid would be treated as a leaked lock of ours and stolen). Call
 * `cleanupLocks` in `afterEach` (the module never removes a lock naming a pid
 * other than its own) and `dispose` in `afterAll`.
 */
export interface PeerLockHarness {
  peerLockedStore(name: string): string;
  /** Remove the most recently written lock — the peer "finished". */
  freeLastLock(): void;
  cleanupLocks(): void;
  dispose(): void;
}

export function peerLockHarness(prefix: string): PeerLockHarness {
  const tmpDir = mkdtempSync(join(tmpdir(), prefix));
  const holder: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  const lockPaths: string[] = [];
  return {
    peerLockedStore(name: string): string {
      const dbPath = join(tmpDir, name);
      writeFileSync(dbPath, '');
      const lockPath = deepVerifyLockPath(canonicalDbPath(dbPath));
      mkdirSync(dirname(lockPath), { recursive: true });
      writeFileSync(lockPath, `${String(holder.pid)}\n${new Date().toISOString()}\n`);
      lockPaths.push(lockPath);
      return dbPath;
    },
    freeLastLock(): void {
      const p = lockPaths[lockPaths.length - 1];
      if (p !== undefined) rmSync(p, { force: true });
    },
    cleanupLocks(): void {
      for (const p of lockPaths.splice(0)) rmSync(p, { force: true });
    },
    dispose(): void {
      if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

/** Schedule as an owner, then wait until the peer-wait timer has FIRED and the
 *  re-attempt is parked on its obligation read (its entry already consumed). */
export async function retryInFlight(stub: PeerStub): Promise<void> {
  expect(await scheduleDeepVerify(stub.adapter, OPTS)).toBeNull(); // peer_running
  expect(_peerWaitPendingForTest(stub.adapter)).toBe(true);
  await stub.readIssued;
  expect(_peerWaitPendingForTest(stub.adapter)).toBe(false);
}
