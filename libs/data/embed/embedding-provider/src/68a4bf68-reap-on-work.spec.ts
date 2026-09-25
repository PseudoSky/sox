/**
 * 68a4bf68 — the embedding host retires on WORK, not on connections (ADR-0022 §1, §2).
 *
 * Before: the reap armed only when the live connection count reached zero.
 * memory-server's `:3099` front shim holds a permanent connection, so the host
 * never retired, and a keep-warm loop kept its model paged in forever. Now:
 *
 *   - {@link reapDueInMs} is the whole policy: null while work is in flight or
 *     the pool has pending requests; otherwise `lastWorkAt + W − now`.
 *   - A still-CONNECTED client does not keep the host alive; health probes do
 *     not either. Keep-warm is gone.
 *   - The next embed from that still-connected client — even after the dial
 *     layer's 10 s give-up has long elapsed — respawns a host and succeeds, with
 *     no "Model not initialized".
 *   - A request that lands as the host retires is answered or transparently
 *     retried, never surfaced as an error.
 */
import * as fs from 'node:fs';
import { dialBackend, serveBackend } from '@adhd/sox-service-proxy';
import { afterEach, describe, expect, it } from 'vitest';
import { reapDueInMs } from './embedHostMain.js';
import {
  __resetEmbedHostConfigForTests,
  computeEmbedHostBuildId,
  configureEmbedHostIdleGraceMs,
  embedHostSingletonKey,
  embedHostSocketPath,
  resolveEmbedHostConfig,
} from './embedHostConfig.js';
import { FunneledFastembedClient } from './funnelClient.js';
import {
  applyEnv,
  destroyFunnelDir,
  funnelEnvVars,
  hostPids,
  makeFunnelDir,
  pidAlive,
  readHostTelemetry,
  waitFor,
  type FunnelDir,
} from './test-support/funnelHarness.js';

const W = 500;
/** Scheduling slack on a heavily loaded box (load avg 100-300 observed). */
const SLACK_MS = 4_500;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  __resetEmbedHostConfigForTests();
});

function sandbox(prefix: string, stub: { delayMs?: number } = {}): FunnelDir {
  const f = makeFunnelDir(prefix, stub);
  cleanups.push(() => destroyFunnelDir(f));
  cleanups.push(applyEnv(funnelEnvVars(f)));
  configureEmbedHostIdleGraceMs(W);
  return f;
}

async function warmClient(f: FunnelDir): Promise<{ client: FunneledFastembedClient; pid: number }> {
  const client = new FunneledFastembedClient();
  await client.request({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
  await client.request({ type: 'embed', text: 'warm' }, 30_000);
  const pids = hostPids(f.shimPath);
  expect(pids).toHaveLength(1);
  return { client, pid: pids[0]! };
}

function isConnected(client: FunneledFastembedClient): boolean {
  return (client as unknown as { conn: { isConnected(): boolean } | null }).conn?.isConnected() ?? false;
}

describe('68a4bf68 — reapDueInMs (unit)', () => {
  const base = { state: 'serving' as const, inFlightWork: 0, poolPending: 0, lastWorkAt: 1_000, now: 1_000, idleWindowMs: 60_000 };
  it.each([
    ['idle, just finished work', base, 60_000],
    ['idle, part of the window elapsed', { ...base, now: 21_000 }, 40_000],
    ['idle, window exactly elapsed', { ...base, now: 61_000 }, 0],
    ['idle, window long past (clamped to 0)', { ...base, now: 999_000 }, 0],
    ['work in flight', { ...base, inFlightWork: 1, now: 999_000 }, null],
    ['pool still has pending requests', { ...base, poolPending: 2, now: 999_000 }, null],
    ['already retiring', { ...base, state: 'retiring' as const, now: 999_000 }, null],
  ])('%s', (_name, args, expected) => {
    expect(reapDueInMs(args)).toBe(expected);
  });

  it('has no connection-count input at all', () => {
    // The signature IS the policy: a connection count cannot be passed.
    expect(reapDueInMs.length).toBe(1);
    expect(Object.keys(base)).not.toContain('activeClients');
  });
});

describe('68a4bf68 — the host retires on work, not connections (integration, W = 500 ms)', () => {
  it('(a) a client that stays CONNECTED does not keep the host alive once its queue drains', async () => {
    const f = sandbox('sox-68a4bf68-a');
    const { client, pid } = await warmClient(f);
    const drainedAt = Date.now();
    expect(isConnected(client), 'the client is still connected').toBe(true);

    await waitFor(() => !pidAlive(pid), W + SLACK_MS, 'host to retire while a client is connected');
    const lived = Date.now() - drainedAt;
    expect(lived).toBeLessThan(W + SLACK_MS);
  }, 60_000);

  it('(b) health probes every 100 ms do not extend its life', async () => {
    const f = sandbox('sox-68a4bf68-b');
    const { client, pid } = await warmClient(f);
    const socketPath = client.hostSocketPath!;
    const probe = dialBackend({ socketPath, onDiagnostic: () => undefined, backoff: { giveUpAfterMs: 1_000 } });
    cleanups.push(() => probe.close());
    let probes = 0;
    const timer = setInterval(() => {
      probes++;
      void probe.send({ jsonrpc: '2.0', id: `h${probes}`, method: 'embedding.health' });
    }, 100);
    cleanups.push(() => clearInterval(timer));

    const drainedAt = Date.now();
    await waitFor(() => !pidAlive(pid), W + SLACK_MS, 'host to retire despite health probes');
    clearInterval(timer);
    expect(probes, 'probes were actually sent while the host lived').toBeGreaterThan(2);
    expect(Date.now() - drainedAt).toBeLessThan(W + SLACK_MS);
  }, 60_000);

  it("(c) the still-connected client's next embed — after the dial give-up — respawns a host and succeeds", async () => {
    const f = sandbox('sox-68a4bf68-c');
    const { client, pid } = await warmClient(f);
    await waitFor(() => !pidAlive(pid), W + SLACK_MS, 'first host to retire');
    // Outlast dialBackend's 10 s give-up so its down-since clock is stale.
    await new Promise((r) => setTimeout(r, 11_000));

    // NO re-init: the successor must load the model itself.
    const res = await client.request<{ embedding: number[] }>({ type: 'embed', text: 'after retire' }, 30_000);
    expect(res.embedding).toEqual([0, 0, 0]);
    const now = hostPids(f.shimPath);
    expect(now).toHaveLength(1);
    expect(now[0]).not.toBe(pid);
  }, 90_000);

  it('(d) requests landing around the retire tick get a vector, never an error', async () => {
    const f = sandbox('sox-68a4bf68-d');
    const offsets = [-40, -20, -5, 0, 5, 20, 40, 80];
    for (const offset of offsets) {
      const client = new FunneledFastembedClient();
      await client.request({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
      await client.request({ type: 'embed', text: 'warm' }, 30_000);
      const drainedAt = Date.now();
      await new Promise((r) => setTimeout(r, Math.max(0, drainedAt + W + offset - Date.now())));
      const res = await client.request<{ embedding: number[] }>({ type: 'embed', text: `t${offset}` }, 30_000);
      expect(res.embedding, `offset ${offset} ms`).toEqual([0, 0, 0]);
    }
  }, 180_000);

  it("(d') a request answered 'embedding host retiring' (-32001) is transparently retried on a successor", async () => {
    const f = sandbox('sox-68a4bf68-d2');
    // Stand a fake retiring host on the exact socket the client will compute.
    const socketPath = embedHostSocketPath(
      resolveEmbedHostConfig(),
      embedHostSingletonKey('stub', 'cpu', f.cache, computeEmbedHostBuildId(f.shimPath)),
    );
    let answeredRetiring = 0;
    const fake = await serveBackend({
      socketPath,
      onDiagnostic: () => undefined,
      handler: async (req) => {
        if (req.method === 'ping') return { jsonrpc: '2.0', id: req.id ?? null, result: {} };
        answeredRetiring++;
        // Like the real host: answer -32001, then stop listening.
        setImmediate(() => void fake.close());
        return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32001, message: 'embedding host retiring' } };
      },
    });
    const client = new FunneledFastembedClient();
    const res = await client.request<Record<string, unknown>>({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
    expect(answeredRetiring).toBe(1);
    expect(res['initOk']).toBe(true);
    expect(hostPids(f.shimPath), 'a real successor served the retry').toHaveLength(1);
    expect(fs.existsSync(socketPath)).toBe(true);
  }, 60_000);

  it('(e) no keep-warm: an idle connected host issues no synthetic fastembed requests', async () => {
    const f = sandbox('sox-68a4bf68-e');
    configureEmbedHostIdleGraceMs(3_000);
    const { pid } = await warmClient(f);
    await waitFor(() => !pidAlive(pid), 3_000 + SLACK_MS, 'host to retire');

    const records = readHostTelemetry(f.home).filter((r) => r['pid'] === pid);
    expect(records.length, 'the host wrote telemetry').toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toMatch(/keep.?warm/i);
    // Exactly the real traffic reached the pool: the eager init + one embed.
    // (The client's own `init` is answered from the host's memoized model.)
    const admitted = records.filter((r) => r['event'] === 'fastembed_process.request.admitted');
    expect(admitted).toHaveLength(2);
  }, 60_000);
});
