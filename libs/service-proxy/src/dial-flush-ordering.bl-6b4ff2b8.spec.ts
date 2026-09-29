/**
 * dial-flush-ordering.bl-6b4ff2b8.spec.ts — BL-6b4ff2b8 review finding: a
 * request that lands DURING the yield window of a chunked drain must not
 * overtake older, still-queued backlog items on the wire.
 *
 * BACKGROUND. Before the BL-6b4ff2b8 fix, `flushQueue()` was a single
 * unbroken synchronous pass — the event loop could not process anything else
 * while it ran, so no new `send()` could ever be interleaved with the
 * backlog being flushed. The fix (`dial-flush-yields.bl-6b4ff2b8.spec.ts`)
 * correctly bounds each drain pass to `maxItemsPerTick` and yields via
 * `setImmediate` between chunks — but that yield reopens exactly the window
 * the old code closed: `send()`'s unmodified fast path
 * (`if (socket && socket.writable) { writeToBackend(p); } else { ... }`)
 * writes directly whenever the socket happens to be writable, with no regard
 * for whether a drain is mid-flight. A request issued in the gap between two
 * chunks sees a connected, writable socket and gets written immediately —
 * ahead of the older backlog items still waiting for their next chunk.
 *
 * THE PROOF. Queue N items while disconnected (so they sit in `queue` in
 * order 0..N-1), start the backend, and — from inside `onConnect`, which
 * fires synchronously BEFORE `flushQueue()` runs in that same 'connect'
 * callback (see dial.ts's `connect()`) — schedule a `setImmediate` that
 * issues ONE new request ('LATE'). Because `onConnect`'s `setImmediate` is
 * enqueued before `flushQueue()`'s own chunk-continuation `setImmediate`
 * (scheduled synchronously inside the same callback, after `onConnect`
 * returns), the LATE send's callback runs in the immediate queue BEFORE the
 * second chunk's continuation — i.e. exactly in the yield window between
 * chunk 1 (items 0..99) and chunk 2 (items 100..199).
 *
 * The backend handler records requests in the order it receives them off the
 * wire (a single stream preserves write order), so that receipt order is a
 * direct measurement of write order on the socket.
 *
 * RED (current `send()`, socket.writable with no drain-in-flight check):
 * LATE is written into the gap after chunk 1 and before chunk 2 — it lands
 * at wire position ~100, overtaking items 100..N-1.
 *
 * GREEN (fix — `send()` also requires `!flushImmediate`): LATE is pushed to
 * the back of `queue` instead, so it drains only after every one of the
 * N pre-existing items — wire position N (last).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dialBackend, type BackendConnection } from './dial.js';
import { serveBackend, type BackendHandle } from './backend.js';

function tmpSock(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-proxy-order-')), `${name}.sock`);
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('BL-6b4ff2b8 (review finding) — a send() during a chunked drain must not overtake queued backlog', () => {
  it('routes a mid-drain send() through the queue instead of writing it ahead of older backlog items', async () => {
    const sock = tmpSock('ordering');
    // Large enough to span multiple maxItemsPerTick(=100 default) chunks —
    // reuses the 50k-item pattern from dial-flush-yields.bl-6b4ff2b8.spec.ts,
    // sized down since this test only needs >= 2 chunks, not a timing probe.
    const N = 5_000;

    const receivedIds: Array<string | number> = [];

    const conn: BackendConnection = dialBackend({
      socketPath: sock,
      onDiagnostic: () => {},
      backoff: { initialMs: 20, maxMs: 40, giveUpAfterMs: 60_000, maxQueue: N + 10 },
      // Fires synchronously inside the 'connect' handler, BEFORE flushQueue()
      // runs in that same callback. Scheduling our own setImmediate here means
      // it is enqueued ahead of flushQueue()'s own chunk-continuation
      // setImmediate (scheduled a moment later, once the synchronous first
      // chunk in drainQueueChunk() has run) — landing our new send() exactly
      // in the yield window between chunk 1 and chunk 2.
      onConnect: () => {
        setImmediate(() => {
          conn.send({ jsonrpc: '2.0', id: 'LATE', method: 'echo', params: { i: -1 } });
        });
      },
    });
    cleanups.push(() => conn.close());

    const sends: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      sends.push(conn.send({ jsonrpc: '2.0', id: i, method: 'echo', params: { i } }));
    }

    const backend: BackendHandle = await serveBackend({
      socketPath: sock,
      onDiagnostic: () => {},
      handler: (req) => {
        receivedIds.push(req.id as string | number);
        return { jsonrpc: '2.0', id: req.id ?? null, result: { echo: req.params } };
      },
    });
    cleanups.push(() => backend.close());

    const results = (await Promise.all(sends)) as Array<{
      id: number;
      result?: { echo?: { i: number } };
      error?: unknown;
    }>;

    expect(results).toHaveLength(N);
    for (let i = 0; i < N; i++) {
      const r = results[i];
      expect(r?.error, `request ${i} errored`).toBeUndefined();
      expect(r?.result?.echo?.i, `request ${i} got the wrong reply`).toBe(i);
    }

    // THE ASSERTION: 'LATE' was issued during the yield window between
    // chunk 1 and chunk 2 of a drain covering N pre-existing, older items.
    // It must not be written ahead of any of them — it must land dead last
    // in wire order, after every pre-existing backlog item has drained.
    expect(receivedIds).toHaveLength(N + 1);
    const latePos = receivedIds.indexOf('LATE');
    expect(latePos, "'LATE' never reached the backend").not.toBe(-1);
    expect(latePos, "'LATE' overtook older queued backlog items — it must be written last").toBe(N);
  }, 30_000);
});
