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
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { log } from '@adhd/sox-telemetry';
import {
  _activeDeepVerifyForTest,
  _peerWaitPendingForTest,
  releaseDeepVerify,
  scheduleDeepVerify,
} from '../deep-verify.js';
import { makeStub, macrotasks, OPTS, OWED, peerLockHarness, retryInFlight } from './fixtures/deep-verify-peer-stub.js';

const harness = peerLockHarness('bl-80965c9f-');
afterEach(() => {
  vi.restoreAllMocks();
  harness.cleanupLocks();
});
afterAll(() => {
  harness.dispose();
});
const peerLockedStore = (name: string): string => harness.peerLockedStore(name);

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
    harness.freeLastLock(); // peer finished
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
