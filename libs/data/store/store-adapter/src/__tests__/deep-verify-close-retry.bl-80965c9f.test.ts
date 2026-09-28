/**
 * BL-80965c9f — an owner's peer-lock re-attempt must never outlive `close()`.
 * BL-10b71ea6 — the re-attempt's promise must never reject unhandled.
 *
 * The race (80965c9f): the peer-wait timer fires, deletes its own entry, and
 * `retryAfterPeer` parks on `await readDeepVerifyObligation(adapter)`. A
 * `close()` landing in that window finds no wait to cancel, so when the read
 * resolves the retry re-arms a fresh timer (peer still holding the lock),
 * forks a verifier that persists through the closed adapter (lock freed), or
 * joins a run with it. RED (no tombstone): a timer is re-armed after close.
 *
 * The rejection (10b71ea6): the timer callback discarded `retryAfterPeer`'s
 * promise with `void`, so any throw after its await — here the config
 * re-resolution in `scheduleDeepVerifyInternal` — was an unhandled rejection.
 * RED (no catch): `unhandledRejection` fires.
 *
 * A stub adapter is used on purpose: the window is between two awaits inside
 * the module, and only a controllable `executeGet` makes it deterministic.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { log } from '@adhd/sox-telemetry';
import {
  _activeDeepVerifyForTest,
  _peerWaitPendingForTest,
  deepVerifyLockPath,
  releaseDeepVerify,
  scheduleDeepVerify,
  type ScheduleDeepVerifyOptions,
} from '../deep-verify.js';
import { canonicalDbPath } from '../path-identity.js';
import type { StoreAdapter } from '../types.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface Stub {
  adapter: StoreAdapter;
  config: { dbPath: string; type: 'turso'; deepVerify: Record<string, unknown> };
  calls: string[];
  /** Resolves when the retry's obligation read has been issued. */
  readIssued: Promise<void>;
  /** Controls the in-flight obligation read. */
  read: Deferred<{ value: string } | null>;
}

function makeStub(dbPath: string): Stub {
  const calls: string[] = [];
  const read = deferred<{ value: string } | null>();
  const issued = deferred<void>();
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
      issued.resolve();
      return read.promise;
    },
    executeRun: (sql: string) => {
      calls.push(`run:${sql}`);
      return Promise.resolve({ changes: 0 });
    },
  } as unknown as StoreAdapter;
  return { adapter, config, calls, readIssued: issued.promise, read };
}

const OPTS: ScheduleDeepVerifyOptions = {
  fastResult: {
    verify: { ok: true, depth: 'fast', durationMs: 0, findings: [], damaged: [], unknown: [] },
    repair: null,
  } as unknown as ScheduleDeepVerifyOptions['fastResult'],
  reason: 'unclean_shutdown',
};

const OWED = { value: JSON.stringify({ reason: 'unclean_shutdown', since: '2026-09-27T00:00:00.000Z' }) };

const macrotasks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 20));
};

let tmpDir: string;
let holder: ChildProcess;
const lockPaths: string[] = [];

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl-80965c9f-'));
  // A live FOREIGN pid holds the lock (our own pid would be treated as a
  // leaked lock of ours and stolen).
  holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
});
afterEach(() => {
  vi.restoreAllMocks();
  // The module never removes a lock naming a pid other than its own.
  for (const p of lockPaths.splice(0)) rmSync(p, { force: true });
});
afterAll(() => {
  if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A store file whose deep-pass lock is held by the live foreign `holder`. */
function peerLockedStore(name: string): string {
  const dbPath = join(tmpDir, name);
  writeFileSync(dbPath, '');
  const lockPath = deepVerifyLockPath(canonicalDbPath(dbPath));
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${String(holder.pid)}\n${new Date().toISOString()}\n`);
  lockPaths.push(lockPath);
  return dbPath;
}

/** Schedule as an owner, then wait until the peer-wait timer has FIRED and the
 *  retry is parked on its obligation read (the entry is already consumed). */
async function retryInFlight(stub: Stub): Promise<void> {
  expect(await scheduleDeepVerify(stub.adapter, OPTS)).toBeNull(); // peer_running
  expect(_peerWaitPendingForTest(stub.adapter)).toBe(true);
  await stub.readIssued;
  expect(_peerWaitPendingForTest(stub.adapter)).toBe(false);
}

describe('BL-80965c9f — a peer-lock re-attempt never touches a closed adapter', () => {
  it('close during the in-flight re-attempt (peer still holds the lock): no timer is re-armed, no adapter I/O after close', async () => {
    const dbPath = peerLockedStore('held.db');
    const stub = makeStub(dbPath);
    await retryInFlight(stub);

    await releaseDeepVerify(stub.adapter); // the adapter's close()
    const callsAtClose = stub.calls.length;
    stub.read.resolve(OWED); // still owed → the buggy path re-schedules
    await macrotasks(5);

    expect(_peerWaitPendingForTest(stub.adapter)).toBe(false);
    expect(_activeDeepVerifyForTest(dbPath)).toBeNull();
    expect(stub.calls.slice(callsAtClose)).toEqual([]);
    // And stays that way past the would-be backoff.
    await new Promise((r) => setTimeout(r, 300));
    expect(stub.calls.slice(callsAtClose)).toEqual([]);
    expect(_peerWaitPendingForTest(stub.adapter)).toBe(false);
  }, 20_000);

  it('close during the in-flight re-attempt (peer lock freed meanwhile): no verifier run starts through the closed adapter', async () => {
    const dbPath = peerLockedStore('freed.db');
    const stub = makeStub(dbPath);
    await retryInFlight(stub);

    await releaseDeepVerify(stub.adapter);
    const callsAtClose = stub.calls.length;
    rmSync(lockPaths[lockPaths.length - 1] as string, { force: true }); // peer finished
    stub.read.resolve(OWED);
    await macrotasks(5);

    expect(_activeDeepVerifyForTest(dbPath)).toBeNull();
    expect(_peerWaitPendingForTest(stub.adapter)).toBe(false);
    expect(stub.calls.slice(callsAtClose)).toEqual([]);
  }, 20_000);

  it('scheduling against an already-closed adapter arms nothing', async () => {
    const dbPath = peerLockedStore('preclosed.db');
    const stub = makeStub(dbPath);
    await releaseDeepVerify(stub.adapter);
    expect(await scheduleDeepVerify(stub.adapter, OPTS)).toBeNull();
    expect(_peerWaitPendingForTest(stub.adapter)).toBe(false);
    expect(_activeDeepVerifyForTest(dbPath)).toBeNull();
    expect(stub.calls).toEqual([]);
  });
});

describe('BL-10b71ea6 — a throwing peer-lock re-attempt is caught and traced, never an unhandled rejection', () => {
  it('a re-attempt that throws after its obligation read raises no unhandledRejection and logs peer_retry_failed', async () => {
    const dbPath = peerLockedStore('throws.db');
    const stub = makeStub(dbPath);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const errorSpy = vi.spyOn(log, 'error');
    try {
      await retryInFlight(stub);
      // Any throw in the re-attempt path: here, config re-resolution.
      stub.config.deepVerify['timeoutMs'] = 'not-a-number';
      stub.read.resolve(OWED);
      await macrotasks(5);

      expect(unhandled).not.toHaveBeenCalled();
      const events = errorSpy.mock.calls.map((c) => c[0]);
      expect(events).toContain('store_adapter.deep_verify.peer_retry_failed');
    } finally {
      process.off('unhandledRejection', unhandled);
      await releaseDeepVerify(stub.adapter);
    }
  }, 20_000);
});
