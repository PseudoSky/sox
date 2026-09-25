/**
 * 2fadb3cd — an in-flight embed survives the death of its host.
 *
 * `dialBackend` re-dials the same socket path and replays unanswered requests,
 * but it never SPAWNS: with the host gone, a replayed request waited out the
 * 10 s give-up and failed -32001. The funnel client now re-ensures a successor
 * the moment its connection drops with requests outstanding, and retries a
 * host-gone failure once. The caller's ONE call resolves from the successor.
 */
import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { FunneledFastembedClient } from './funnelClient.js';
import {
  applyEnv,
  destroyFunnelDir,
  funnelEnvVars,
  hostPids,
  killPid,
  makeFunnelDir,
  pidAlive,
  waitFor,
} from './test-support/funnelHarness.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

describe('2fadb3cd — in-flight work survives host death', () => {
  it('SIGKILL the host during an in-flight embedBatch ⇒ the same promise resolves from a respawned host', async () => {
    // Each embed/embedBatch takes 1.5 s in the stub, so the batch is in flight
    // when the host dies.
    const f = makeFunnelDir('sox-2fadb3cd', { delayMs: 1_500 });
    cleanups.push(() => destroyFunnelDir(f));
    cleanups.push(applyEnv(funnelEnvVars(f)));

    const client = new FunneledFastembedClient();
    await client.request({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
    const [firstPid] = hostPids(f.shimPath);
    expect(firstPid).toBeDefined();

    let calls = 0;
    const started = Date.now();
    calls++;
    const inflight = client.request<{ embeddings: number[][] }>(
      { type: 'embedBatch', texts: ['a', 'b', 'c'] },
      30_000,
    );
    // Let the request reach the host, then kill it mid-request.
    await new Promise((r) => setTimeout(r, 300));
    expect(client.pendingCount).toBe(1);
    killPid(firstPid!, 'SIGKILL');
    await waitFor(() => !pidAlive(firstPid!), 5_000, 'first host to die');

    const result = await inflight;
    const elapsed = Date.now() - started;

    expect(calls).toBe(1);
    expect(result.embeddings).toHaveLength(3);
    expect(elapsed, `resolved in ${elapsed} ms`).toBeLessThan(10_000);
    const now = hostPids(f.shimPath);
    expect(now, 'exactly one successor host').toHaveLength(1);
    expect(now[0]).not.toBe(firstPid);
    expect(fs.existsSync(client.hostSocketPath!)).toBe(true);
  }, 60_000);
});
