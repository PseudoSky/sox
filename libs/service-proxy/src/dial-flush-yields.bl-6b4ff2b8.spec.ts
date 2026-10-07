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
 * THE PROOF (deterministic — counts, not wall-clock). Queue 50,000 requests
 * while the backend is down (so they sit in `queue`), start the backend, and
 * use `onConnect` — fired synchronously INSIDE the 'connect' handler,
 * immediately BEFORE `flushQueue()` runs in the same callback (see dial.ts's
 * `connect()`) — to schedule a `setImmediate` probe at the exact instant the
 * drain is about to start. A spy on `net.Socket.prototype.write` counts how
 * many request frames have been handed to the socket when the probe runs. If
 * `flushQueue()` drains the whole backlog in one unbroken synchronous pass,
 * the probe cannot run until all 50,000 frames have been written. If it
 * drains in bounded chunks yielding via `setImmediate` between them, the
 * probe runs after the FIRST chunk, i.e. <= `maxItemsPerTick` (default 100)
 * frames. The count is a pure function of the code's control flow, so it is
 * independent of machine load.
 *
 * Why not a time threshold: an earlier version asserted
 * `onConnect->setImmediate` delta < 20ms (GREEN ~1.9ms, RED ~55.8ms idle) and
 * failed at 51.77ms with the machine at load average ~80 — OS preemption of
 * the test process inflated the GREEN delta into the RED band. The yield
 * guarantee is "bounded work per tick", which the write count asserts
 * directly.
 *
 * RED (fix disabled — an unbounded `while (queue.length > 0 && socket)` loop in
 * flushQueue with no per-tick cap and no `setImmediate` yield): frames written
 * at probe time == N (50,000). GREEN: <= 100.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
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
    // Default per-tick cap in dial.ts (DEFAULTS.maxItemsPerTick).
    const MAX_ITEMS_PER_TICK = 100;

    // Count request frames handed to a socket. Backend replies carry a
    // `result`, never `"method":"ping"`, so only the client's drain is counted.
    let pingFramesWritten = 0;
    const realWrite = net.Socket.prototype.write;
    const writeSpy = vi
      .spyOn(net.Socket.prototype, 'write')
      .mockImplementation(function (this: net.Socket, ...args: unknown[]) {
        const chunk = args[0];
        const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
        if (text.includes('"method":"ping"')) pingFramesWritten++;
        return (realWrite as (...a: unknown[]) => boolean).apply(this, args);
      } as typeof net.Socket.prototype.write);
    cleanups.push(() => writeSpy.mockRestore());

    let framesWrittenAtProbe: number | null = null;

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
        setImmediate(() => {
          framesWrittenAtProbe = pingFramesWritten;
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

    // THE ASSERTION: when the setImmediate scheduled at the instant the drain
    // began ran, at most one bounded chunk had been written — proving
    // flushQueue() returned control to the event loop instead of draining all
    // 50,000 items in one unbroken synchronous pass.
    expect(framesWrittenAtProbe, 'onConnect->setImmediate probe never ran').not.toBeNull();
    expect(framesWrittenAtProbe ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(MAX_ITEMS_PER_TICK);
    // All 50,000 were eventually written (the drain continued across ticks).
    expect(pingFramesWritten).toBe(N);
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
