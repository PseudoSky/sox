/**
 * 819a416b — an honest "is the next embed warm?" signal from the funnel client.
 *
 * Recall sizes its query-embed budget from provider readiness. Under the funnel
 * (ADR-0022) the host retires after its idle window while the consumer's
 * `FastembedProvider.ready` stays true and the dial layer quietly re-arms, so
 * neither `ready` nor `started` can say whether the next request must spawn a
 * host and load a model. `FunneledFastembedClient.warm` is true only while a
 * LIVE connection has served a successful embed since connecting.
 *
 * Real host (`embedHostMain.ts`) behind a stub private pool — no model loaded.
 * RED observed (`warm` reduced to `started && connected`, i.e. without the
 * served-since-connect proof): 1 failed / 3 passed — the "connected is not
 * warm" case reads a host that is still loading its model as warm.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { __resetEmbedHostConfigForTests, configureEmbedHostIdleGraceMs } from './embedHostConfig.js';
import { FastembedProvider } from './fastembed.js';
import { FunneledFastembedClient } from './funnelClient.js';
import {
  applyEnv,
  destroyFunnelDir,
  funnelEnvVars,
  hostPids,
  makeFunnelDir,
  pidAlive,
  waitFor,
  type FunnelDir,
} from './test-support/funnelHarness.js';

const W = 500;
/** Scheduling slack on a heavily loaded box. */
const SLACK_MS = 4_500;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  __resetEmbedHostConfigForTests();
});

function sandbox(prefix: string): FunnelDir {
  const f = makeFunnelDir(prefix);
  cleanups.push(() => destroyFunnelDir(f));
  cleanups.push(applyEnv(funnelEnvVars(f)));
  configureEmbedHostIdleGraceMs(W);
  return f;
}

describe('819a416b — FunneledFastembedClient.warm tracks host liveness, not client history', () => {
  it('cold before any request; warm after a served embed; cold again once the host retires', async () => {
    const f = sandbox('sox-819a416b-warm');
    const client = new FunneledFastembedClient();
    expect(client.warm, 'never spawned → cold').toBe(false);

    await client.request({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
    await client.request({ type: 'embed', text: 'warm' }, 30_000);
    expect(client.warm, 'live host served an embed → warm').toBe(true);
    expect(client.pendingCount).toBe(0);

    const pids = hostPids(f.shimPath);
    expect(pids).toHaveLength(1);
    await waitFor(() => !pidAlive(pids[0]!), W + SLACK_MS, 'host to retire after its idle window');
    await waitFor(() => client.warm === false, SLACK_MS, 'client to observe the retirement');
    expect(client.warm, 'host retired → cold, although this client was initialized').toBe(false);

    // The next request re-spawns a host; once it has served, the client is warm again.
    await client.request({ type: 'embed', text: 'after retire' }, 30_000);
    expect(client.warm).toBe(true);
  }, 60_000);

  it('FastembedProvider.readiness(): ready stays true across a host retirement, readiness.warm does not', async () => {
    const f = sandbox('sox-819a416b-provider');
    const client = new FunneledFastembedClient();
    const provider = new FastembedProvider('stub', 3, f.cache, client);
    expect(provider.readiness()).toEqual({ warm: false, pending: 0 });

    await provider.embedSingle('first');
    expect(provider.health().state).toBe('real');
    expect(provider.readiness()).toEqual({ warm: true, pending: 0 });

    const pids = hostPids(f.shimPath);
    await waitFor(() => !pidAlive(pids[0]!), W + SLACK_MS, 'host to retire after its idle window');
    await waitFor(() => provider.readiness().warm === false, SLACK_MS, 'provider to report the retired host');
    expect(provider.health().state, 'the provider still believes it is initialized').toBe('real');
    expect(provider.readiness().warm, '…but the next embed is a cold start').toBe(false);
  }, 60_000);

  it('connected is not warm: a freshly dialed host that has not answered yet is still cold', async () => {
    const f = makeFunnelDir('sox-819a416b-fresh', { initDelayMs: 1_500 });
    cleanups.push(() => destroyFunnelDir(f));
    cleanups.push(applyEnv(funnelEnvVars(f)));
    configureEmbedHostIdleGraceMs(W);
    const client = new FunneledFastembedClient();
    const init = client.request({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
    const internals = client as unknown as { conn: { isConnected(): boolean } | null };
    await waitFor(
      () => client.started && (internals.conn?.isConnected() ?? false),
      30_000,
      'client to connect to the spawned host',
    );
    expect(client.warm, 'host spawned and connected, model still loading → cold').toBe(false);
    await init;
    expect(client.warm, 'host answered init (model loaded) → warm').toBe(true);
  }, 60_000);

  it('pendingCount reports embeds a new request would queue behind', async () => {
    const f = sandbox('sox-819a416b-pending');
    const client = new FunneledFastembedClient();
    await client.request({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
    const inflight = client.request({ type: 'embed', text: 'a' }, 30_000);
    expect(client.pendingCount).toBe(1);
    await inflight;
    expect(client.pendingCount).toBe(0);
  }, 60_000);
});
