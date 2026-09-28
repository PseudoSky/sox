/**
 * BL-026af34c — an in-flight peer-lock re-attempt follows a Turso reconnect's
 * membership transfer instead of resuming against the abandoned instance.
 *
 * The race: the reconnect opens a throwaway `fresh` adapter, adopts its
 * connection onto the surviving one, and calls
 * `transferDeepVerifyMembership(fresh, this)` — never closing `fresh`. If
 * `fresh`'s peer-wait timer had already FIRED, there is no `peerWaits` entry
 * left to move: the re-attempt is parked on its obligation read, and when it
 * resolves it re-arms / starts a pass / persists state through `fresh`.
 * RED (no forwarding): the retry re-arms on `from`, and a started run writes
 * through `from`.
 *
 * The chosen semantics is FOLLOW, not retire: the obligation belongs to the
 * store, and the in-flight re-attempt is the only thing still serving it, so
 * dropping it would leave the owed pass unserved for the survivor's life.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  _activeDeepVerifyForTest,
  _peerWaitPendingForTest,
  releaseDeepVerify,
  transferDeepVerifyMembership,
} from '../deep-verify.js';
import { makeStub, macrotasks, OWED, peerLockHarness, retryInFlight } from './fixtures/deep-verify-peer-stub.js';

const harness = peerLockHarness('bl-026af34c-');
afterEach(() => {
  harness.cleanupLocks();
});
afterAll(() => {
  harness.dispose();
});

describe('BL-026af34c — an in-flight peer-lock re-attempt follows the reconnect transfer', () => {
  it('peer still holds the lock: the re-attempt re-arms on the survivor, never on the abandoned instance', async () => {
    const dbPath = harness.peerLockedStore('held.db');
    const from = makeStub(dbPath);
    const to = makeStub(dbPath);
    try {
      await retryInFlight(from);

      transferDeepVerifyMembership(from.adapter, to.adapter); // the Turso reconnect
      const fromCallsAtTransfer = from.calls.length;
      from.read.resolve(OWED);
      await macrotasks(5);

      expect(_peerWaitPendingForTest(from.adapter)).toBe(false);
      expect(_peerWaitPendingForTest(to.adapter)).toBe(true); // followed, not dropped
      expect(from.calls.slice(fromCallsAtTransfer)).toEqual([]);

      // The survivor keeps serving the obligation on its own backoff.
      await new Promise((r) => setTimeout(r, 300));
      expect(from.calls.slice(fromCallsAtTransfer)).toEqual([]);
      expect(to.calls.some((c) => c.startsWith('get:'))).toBe(true);
    } finally {
      await releaseDeepVerify(to.adapter);
      await releaseDeepVerify(from.adapter);
    }
  }, 20_000);

  it('peer lock freed meanwhile: the pass runs with the survivor as its member and persists through it only', async () => {
    const dbPath = harness.peerLockedStore('freed.db');
    const from = makeStub(dbPath);
    const to = makeStub(dbPath);
    try {
      await retryInFlight(from);

      transferDeepVerifyMembership(from.adapter, to.adapter);
      const fromCallsAtTransfer = from.calls.length;
      harness.freeLastLock(); // the peer finished
      from.read.resolve(OWED);

      const deadline = Date.now() + 5_000;
      while (_activeDeepVerifyForTest(dbPath) === null && to.calls.every((c) => !c.startsWith('run:'))) {
        if (Date.now() > deadline) throw new Error('the followed re-attempt never started a pass');
        await new Promise((r) => setTimeout(r, 20));
      }
      await _activeDeepVerifyForTest(dbPath)?.done;

      expect(from.calls.slice(fromCallsAtTransfer)).toEqual([]);
      expect(to.calls.some((c) => c.startsWith('run:'))).toBe(true); // state persisted via the survivor
    } finally {
      await releaseDeepVerify(to.adapter);
      await releaseDeepVerify(from.adapter);
    }
  }, 30_000);
});
