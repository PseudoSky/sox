/**
 * dial-flush-yields.bl-6b4ff2b8.spec.ts — BL-6b4ff2b8: a large reconnect
 * backlog must not pin the main thread.
 *
 * THE INCIDENT (2026-09-28, memory-server pid 50436, `sample <pid> 3` showed
 * 100% of a 3s window inside `PipeWrap::AfterConnect -> ArrayPrototypeShift`;
 * observed stall 640,232ms) had TWO compounding defects — this file covers
 * ONE of them in isolation (see dial.ts's file header and
 * dial-flush-writable-check.bl-6b4ff2b8.spec.ts for the other, dominant one,
 * a genuine infinite hang under a mid-drain EPIPE — NOT reproduced in this
 * file, which has no EPIPE at all). This file's defect: `flushQueue()` drove
 * a `while` loop calling `Array.prototype.shift()` once per queued request —
 * O(remaining length) per call, so draining N requests was O(N^2) — with no
 * yield point, so the whole backlog drained in one unbroken synchronous
 * pass. The default `maxQueue` (256) means this alone cannot explain a 640s
 * stall — it is real and worth fixing, but secondary to the infinite hang.
 *
 * THE PROOF. Queue 50,000 requests while the backend is down (so they sit in
 * `queue`), start the backend, and use `onConnect` — fired synchronously
 * INSIDE the 'connect' handler, immediately BEFORE `flushQueue()` runs in the
 * same callback (see dial.ts's `connect()`) — to schedule a `setImmediate`
 * probe at the exact instant the drain is about to start. If `flushQueue()`
 * drains the whole backlog in one unbroken synchronous pass, the probe cannot
 * fire until that entire pass (every `socket.write()` for all 50,000 items)
 * has returned and the 'connect' callback's stack has unwound. If it drains
 * in bounded chunks yielding via `setImmediate` between them, the probe fires
 * as soon as the FIRST chunk (<= `maxItemsPerTick`, default 100) returns —
 * orders of magnitude sooner.
 *
 * RED (fix disabled — restore the old `while (queue.length > 0 && socket) {
 * const p = queue.shift(); ...}` unbounded loop in flushQueue with no
 * per-tick cap and no `setImmediate` yield): measured directly against this
 * exact fixture — reverting flushQueue to the unbounded loop (Deque itself
 * still O(1), so this isolates ONLY the missing chunk/yield, not the
 * separate O(N^2) Array.shift defect) — the onConnect->setImmediate delta for
 * N=50,000 was **55.77ms**, over the `MAX_CHUNK_DELTA_MS` threshold below.
 * GREEN (fix restored): the same measurement was **1.90ms** — a ~29x drop,
 * because the probe fires after the first <=100-item chunk instead of after
 * the full 50,000-item drain.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dialBackend, type BackendConnection } from './dial.js';
import { serveBackend, type BackendHandle } from './backend.js';

function tmpSock(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sox-proxy-flush-')), `${name}.sock`);
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('BL-6b4ff2b8 — reconnect flush yields the event loop under a large backlog', () => {
  it('yields within a bounded first chunk instead of draining 50,000 items in one synchronous pass', async () => {
    const sock = tmpSock('backlog');
    const N = 50_000;
    // RED measured 55.77ms; GREEN measured 1.90ms. Set well above GREEN noise
    // and well below RED so the assertion discriminates cleanly either way.
    const MAX_CHUNK_DELTA_MS = 20;

    let probeDeltaMs: number | null = null;
    let connectedAt = 0;

    // No backend started yet — every send() lands in the disconnected queue.
    const conn: BackendConnection = dialBackend({
      socketPath: sock,
      onDiagnostic: () => {},
      backoff: { initialMs: 20, maxMs: 40, giveUpAfterMs: 60_000, maxQueue: N + 10 },
      // Fires synchronously inside the 'connect' handler, immediately BEFORE
      // flushQueue() runs in that same callback (dial.ts connect()) — this is
      // the exact instant the drain of the 50,000-item backlog is about to
      // start.
      onConnect: () => {
        connectedAt = performance.now();
        setImmediate(() => {
          probeDeltaMs = performance.now() - connectedAt;
        });
      },
    });
    cleanups.push(() => conn.close());

    const sends: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      sends.push(conn.send({ jsonrpc: '2.0', id: i, method: 'ping' }));
    }

    const backend: BackendHandle = await serveBackend({
      socketPath: sock,
      onDiagnostic: () => {},
      handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: { ok: true } }),
    });
    cleanups.push(() => backend.close());

    const results = await Promise.all(sends);

    expect(results).toHaveLength(N);
    for (const r of results) {
      expect((r as { error?: unknown }).error).toBeUndefined();
    }

    // THE ASSERTION: the setImmediate scheduled at the instant the drain
    // began fired promptly — proving flushQueue() returned control to the
    // event loop after a bounded first chunk instead of draining all 50,000
    // items in one unbroken synchronous pass.
    expect(probeDeltaMs, 'onConnect->setImmediate probe never fired').not.toBeNull();
    expect(probeDeltaMs ?? Number.POSITIVE_INFINITY).toBeLessThan(MAX_CHUNK_DELTA_MS);
  }, 30_000);

  it('preserves request order and drops none across a chunked drain', async () => {
    const sock = tmpSock('order');
    const N = 5_000;
    const conn: BackendConnection = dialBackend({
      socketPath: sock,
      onDiagnostic: () => {},
      backoff: { initialMs: 20, maxMs: 40, giveUpAfterMs: 60_000, maxQueue: N + 10 },
    });
    cleanups.push(() => conn.close());

    const sends: Array<Promise<unknown>> = [];
    for (let i = 0; i < N; i++) {
      sends.push(conn.send({ jsonrpc: '2.0', id: i, method: 'echo', params: { i } }));
    }

    const backend: BackendHandle = await serveBackend({
      socketPath: sock,
      onDiagnostic: () => {},
      handler: (req) => ({ jsonrpc: '2.0', id: req.id ?? null, result: { echo: req.params } }),
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
  }, 30_000);
});
