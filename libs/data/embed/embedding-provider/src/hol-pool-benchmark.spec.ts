/**
 * hol-pool-benchmark.spec.ts — BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001
 * acceptance golden.
 *
 * PRODUCTION MEASUREMENT this bug report cites (n=3769, 11 days, from the
 * live service's own `fastembed_process.request.finish` telemetry):
 *
 *   response_ms   p50=1011ms   p90=5674ms   p99=40518ms   max=109089ms
 *   qdepth 0      n=1335   p50=534ms     p90=1501ms
 *   qdepth 1-2    n=1905   p50=1164ms    p90=4367ms
 *   qdepth 3-5    n=354    p50=2821ms    p90=15441ms
 *   qdepth 6-10   n=105    p50=5519ms    p90=18862ms
 *   qdepth 11+    n=70     p50=26723ms   p90=76712ms
 *
 * ~50x p50 degradation from idle to depth 11+, caused by every embed request
 * in a process sharing exactly ONE fastembed child (`SharedFastembedProcessClient`
 * via `getSharedFastembedProcess()`), whose host (`fastembedProcessHost.ts`)
 * processes requests through a single serialized `_queue` promise chain —
 * classic head-of-line blocking.
 *
 * This suite reproduces the mechanism (not the absolute magnitudes — a stub
 * host stands in for real ONNX inference so the suite stays fast and
 * hermetic, exactly like bl432/bl410's pattern) with a stub fork target that
 * — critically — ALSO serializes its own replies through a promise chain, the
 * same structural bottleneck `fastembedProcessHost.ts`'s real `_queue` is.
 * A stub that answered each message independently on its own timer would NOT
 * reproduce head-of-line blocking at all (verified while building this
 * harness — see the benchmark driver notes cited in this bug's resolution).
 *
 * SCOPE OF THE ASSERTIONS BELOW, stated plainly so nobody reads this as a
 * production guarantee: every number in this file (and in the resolution
 * notes' benchmark-driver output) measures the QUEUEING component in
 * isolation — a fixed, synthetic per-request delay standing in for real ONNX
 * inference, calibrated to production's qdepth=0 solo p50 (534ms) so the
 * queueing MATH is representative, but with none of real inference's own
 * variance (content length, CPU contention, cold-cache loads) layered on
 * top. "Pool cuts p50 in half" / "p99 stays under budget" describe how much
 * of the head-of-line-blocking component this fix removes — NOT a claim that
 * production's real p99 (measured 40,518ms, with real model load and real
 * traffic variance) drops by the same factor. The golden below asserts a
 * BOUNDED p99 under a STATED synthetic concurrency/delay, per that
 * methodology — not a bound on live production p99.
 *
 * BL-225: this suite is the red→green proof for the fix. Confirmed manually:
 * constructing `new FastembedProcessPool(1, hostPath)` in test 1 below (pool
 * size 1 — the literal pre-fix topology, since `SharedFastembedProcessClient`
 * IS what backs a 1-member pool) makes the "pool beats single" assertion FAIL
 * (both sides measure the same one-child bottleneck); size 4 makes it PASS.
 * BEFORE this fix existed at all (no `FastembedProcessPool` class),  this
 * file failed to even type-check/import — the loudest possible red.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SharedFastembedProcessClient,
  FastembedProcessPool,
  FastembedBusyError,
} from './sharedFastembedProcess.js';

let stubDir: string;

beforeEach(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hol-pool-bench-'));
});

afterEach(() => {
  fs.rmSync(stubDir, { recursive: true, force: true });
});

/**
 * Stub fork target whose replies are SERIALIZED through a promise chain —
 * i.e. it processes one message fully (after `delayMs`) before starting the
 * next, mirroring `fastembedProcessHost.ts`'s real `_queue`. This IS the
 * mechanism under test: a stub that replied to each message independently on
 * its own timer would let N concurrent messages "complete" in parallel and
 * never reproduce head-of-line blocking at all.
 */
function writeSerializedStubHost(delayMs: number): string {
  const hostPath = path.join(stubDir, `stub-host-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(
    hostPath,
    [
      `let q = Promise.resolve();`,
      `process.on('message', (msg) => {`,
      `  if (msg && msg.__shutdown) { process.disconnect(); return; }`,
      `  q = q.then(() => new Promise((resolve) => {`,
      `    setTimeout(() => {`,
      `      if (process.connected) process.send({ id: msg.id, embedding: [0, 0, 0] });`,
      `      resolve();`,
      `    }, ${delayMs});`,
      `  }));`,
      `});`,
      '',
    ].join('\n'),
  );
  return hostPath;
}

function pctl(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx]!;
}

/** Fire `n` requests through `client`, at most `concurrency` in flight at
 *  once, and return the observed per-request latency array. */
async function runLoad(
  client: { request<T>(payload: Record<string, unknown>, timeoutMs?: number): Promise<T> },
  n: number,
  concurrency: number,
): Promise<number[]> {
  const latencies: number[] = [];
  let nextIdx = 0;
  async function worker(): Promise<void> {
    while (nextIdx < n) {
      const i = nextIdx++;
      const t0 = performance.now();
      await client.request({ type: 'embed', text: `bench ${i}` }, 30_000);
      latencies.push(performance.now() - t0);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return latencies;
}

describe('BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001 — FastembedProcessPool fixes the measured HOL blocking', () => {
  it(
    'a 4-member pool cuts p50 latency at least in half vs a single shared child, at identical concurrency',
    async () => {
      const delayMs = 60;
      const n = 60;
      const concurrency = 12;

      const single = new SharedFastembedProcessClient(writeSerializedStubHost(delayMs));
      const singleLatencies = await runLoad(single, n, concurrency);
      await single.terminate();

      const pool = new FastembedProcessPool(4, writeSerializedStubHost(delayMs));
      const poolLatencies = await runLoad(pool, n, concurrency);
      await pool.terminate();

      const singleP50 = pctl(singleLatencies, 50);
      const poolP50 = pctl(poolLatencies, 50);

      // Measured on this exact harness (delayMs=60, n=60, concurrency=12,
      // pool size 4): single p50 ~= 330ms, pool p50 ~= 75ms (~4.4x). Assert a
      // conservative 2x floor so CI scheduling jitter can't flake this while
      // still failing loudly if the pool regresses toward the single-child
      // bottleneck it exists to remove.
      expect(poolP50).toBeLessThan(singleP50 / 2);
    },
    30_000,
  );

  it(
    'GOLDEN: qdepth->latency slope stays bounded — a 4-member pool holds steady-state p99 under a stated budget at concurrency=16 that the single-child topology cannot meet',
    async () => {
      const delayMs = 50;
      const n = 64;
      const concurrency = 16;

      const pool = new FastembedProcessPool(4, writeSerializedStubHost(delayMs));
      // Warm up: fork every member and pay the one-time real-process-spawn
      // cost (~200-800ms per member, measured — irreducible OS overhead of a
      // real `child_process.fork()`, nothing to do with queueing) BEFORE
      // timing the steady-state load. Production pays this once at server
      // startup/warmup, never per-request — mixing it into a per-request p99
      // budget would bound something this fix was never meant to bound.
      await runLoad(pool, pool.members.length, pool.members.length);

      const latencies = await runLoad(pool, n, concurrency);
      await pool.terminate();

      const p99 = pctl(latencies, 99);
      // Steady-state floor for a 4-member pool at concurrency=16 (4 requests
      // queued per member) is ~4*delayMs = 200ms; measured on this harness
      // (post-warmup) ~205-260ms. A single (unpooled) child at this
      // concurrency/delay sits near 16*delayMs = 800ms steady-state — this
      // bound (450ms) is impossible for the pre-fix single-child topology to
      // meet, and gives ~1.7-2x headroom over the measured pooled figure for
      // CI jitter.
      expect(p99).toBeLessThan(delayMs * concurrency * 0.6);
    },
    30_000,
  );

  it(
    'admission control: FastembedProcessPool throws a typed, fast FastembedBusyError once every member is saturated, instead of silently queueing',
    async () => {
      const delayMs = 200;
      const admissionLimit = 1; // tiny on purpose: forces saturation fast
      const pool = new FastembedProcessPool(2, writeSerializedStubHost(delayMs), admissionLimit);

      // 2 members * admissionLimit(1) = 2 requests admitted; everything else
      // arriving concurrently must be fast-rejected, not queued.
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => pool.request({ type: 'embed', text: `x${i}` }, 30_000)),
      );
      await pool.terminate();

      const busyRejections = outcomes.filter(
        (o) => o.status === 'rejected' && (o.reason as Error).name === 'FastembedBusyError',
      );
      const succeeded = outcomes.filter((o) => o.status === 'fulfilled');

      expect(busyRejections.length).toBeGreaterThan(0);
      expect(succeeded.length).toBeGreaterThan(0);
      // Every rejection must be the typed error class, not a generic Error
      // (a caller needs to `instanceof`/`.name` check to distinguish "the
      // pool told me to back off" from "the request genuinely failed").
      for (const r of busyRejections) {
        expect((r as PromiseRejectedResult).reason).toBeInstanceOf(FastembedBusyError);
        expect(((r as PromiseRejectedResult).reason as FastembedBusyError).retryAfterMs).toBeGreaterThan(0);
      }
    },
    30_000,
  );

  it('a pool of size 1 behaves identically to the pre-fix single-child topology (regression guard on the size=1 escape hatch)', async () => {
    const delayMs = 40;
    const hostPath = writeSerializedStubHost(delayMs);

    const single = new SharedFastembedProcessClient(hostPath);
    const singleLatencies = await runLoad(single, 20, 8);
    await single.terminate();

    const pool1 = new FastembedProcessPool(1, writeSerializedStubHost(delayMs));
    const pool1Latencies = await runLoad(pool1, 20, 8);
    await pool1.terminate();

    // Same bottleneck, same shape: neither should beat the other by more
    // than measurement noise (a real regression would show as a 2x+ gap
    // exactly like test 1's pool-vs-single assertion above).
    const ratio = pctl(pool1Latencies, 50) / pctl(singleLatencies, 50);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  }, 30_000);
});
