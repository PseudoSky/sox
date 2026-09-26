/**
 * dc73d9b6 + 2fe52b0f — embedding host protocol v2 (ADR-0022 §3, §4).
 *
 * dc73d9b6: requests carry `{model, cacheDir}` and the HOST owns model init.
 *   A host that has never seen an `embedding.init` still answers an embed; a
 *   peer's `embedding.reset` never leaves other clients on an uninitialized
 *   pool; a request for a different model is refused -32602 →
 *   PermanentEmbeddingError.
 * 2fe52b0f: the singleton key carries a content build id. Two host builds that
 *   differ by one byte get two keys, two sockets and two hosts — a consumer
 *   never dials a foreign build. A host spawned with a forged build id exits 3.
 *
 * Real processes: the host is the real `embedHostMain.ts` behind a tsx shim;
 * its private pool is a STATEFUL stub that answers "Model not initialized"
 * until it receives `init`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dialBackend } from '@adhd/sox-service-proxy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetEmbedHostBuildIdMemoForTests,
  computeEmbedHostBuildId,
  embedHostSingletonKey,
  embedHostSocketPath,
  encodeEmbedHostArgs,
  resolveEmbedHostConfig,
} from './embedHostConfig.js';
import { PermanentEmbeddingError } from './errors.js';
import { FunneledFastembedClient } from './funnelClient.js';
import {
  applyEnv,
  destroyFunnelDir,
  funnelEnvVars,
  hostPids,
  makeFunnelDir,
  waitFor,
  type FunnelDir,
} from './test-support/funnelHarness.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  __resetEmbedHostBuildIdMemoForTests();
});

function sandbox(prefix: string, shimTag = ''): FunnelDir {
  const f = makeFunnelDir(prefix, {}, shimTag);
  cleanups.push(() => destroyFunnelDir(f));
  return f;
}

/** Spawn a host directly (no funnel client, so no client-side init ever happens). */
function spawnHostDirect(
  f: FunnelDir,
  opts: { buildId?: string } = {},
): { child: ChildProcess; socketPath: string; exit: Promise<number | null> } {
  const restore = applyEnv(funnelEnvVars(f));
  const buildId = opts.buildId ?? computeEmbedHostBuildId(f.shimPath);
  const socketPath = embedHostSocketPath(
    resolveEmbedHostConfig(),
    embedHostSingletonKey('stub', 'cpu', f.cache, buildId),
  );
  const args = encodeEmbedHostArgs({
    socketPath,
    model: 'stub',
    cacheDir: f.cache,
    ep: 'cpu',
    buildId,
    idleWindowMs: 60_000,
    spawner: { pid: process.pid, serviceId: null, entry: null, deniedEnv: [] },
  });
  const child = spawn(process.execPath, [f.shimPath, ...args], {
    env: { ...process.env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  restore();
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
  const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  cleanups.push(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  void exit.then(() => {
    if (stderr) process.stderr.write(`[host stderr] ${stderr}`);
  });
  return { child, socketPath, exit };
}

async function rpc(socketPath: string, method: string, params?: Record<string, unknown>) {
  const conn = dialBackend({ socketPath, onDiagnostic: () => undefined });
  try {
    return (await conn.send({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })) as {
      result?: Record<string, unknown>;
      error?: { code: number; message: string };
    };
  } finally {
    conn.close();
  }
}

describe('dc73d9b6 — requests carry model identity; the host owns init', () => {
  it('(a) a fresh host answers an embed that was never preceded by an init', async () => {
    const f = sandbox('sox-dc73d9b6-a');
    const { socketPath } = spawnHostDirect(f);
    await waitFor(() => fs.existsSync(socketPath), 20_000, 'host socket');

    const resp = await rpc(socketPath, 'embedding.embed', {
      type: 'embed',
      text: 'hello',
      model: 'stub',
      cacheDir: f.cache,
    });
    expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
    expect(resp.result?.['embedding']).toEqual([0, 0, 0]);
  }, 60_000);

  it("(b) after client A resets the host, client B's next embed succeeds", async () => {
    const f = sandbox('sox-dc73d9b6-b');
    cleanups.push(applyEnv(funnelEnvVars(f)));
    const a = new FunneledFastembedClient();
    const b = new FunneledFastembedClient();
    const init = { type: 'init', model: 'stub', cacheDir: f.cache };
    await a.request(init, 20_000);
    await b.request(init, 20_000);
    expect(await b.request({ type: 'embed', text: 'before' }, 20_000)).toMatchObject({ embedding: [0, 0, 0] });

    await a.resetHost();

    const after = await b.request({ type: 'embed', text: 'after reset' }, 20_000);
    expect(after).toMatchObject({ embedding: [0, 0, 0] });
  }, 60_000);

  it('(c) a request for a different model is refused -32602 → PermanentEmbeddingError', async () => {
    const f = sandbox('sox-dc73d9b6-c');
    const { socketPath } = spawnHostDirect(f);
    await waitFor(() => fs.existsSync(socketPath), 20_000, 'host socket');

    const resp = await rpc(socketPath, 'embedding.embed', {
      type: 'embed',
      text: 'x',
      model: 'some-other-model',
      cacheDir: f.cache,
    });
    expect(resp.error?.code).toBe(-32602);

    const client = new FunneledFastembedClient();
    const mapped = (client as unknown as { mapError(e: { code: number; message: string }): Error }).mapError(
      resp.error!,
    );
    expect(mapped).toBeInstanceOf(PermanentEmbeddingError);
  }, 60_000);
});

describe('2fe52b0f — the singleton key carries a content build id', () => {
  it('(d) two host builds differing by one byte get two keys, two sockets, two hosts', async () => {
    const f1 = sandbox('sox-2fe52b0f-d', 'build one');
    const f2 = makeFunnelDir('sox-2fe52b0f-d2', {}, 'build two');
    cleanups.push(() => destroyFunnelDir(f2));
    // Both builds share ONE data root, so only the build id can separate them.
    const shared = { ...funnelEnvVars(f1), SOX_ECOSYSTEM_HOME: f1.home };
    const init = { type: 'init', model: 'stub', cacheDir: f1.cache };

    cleanups.push(applyEnv(shared));
    const c1 = new FunneledFastembedClient();
    await c1.request(init, 20_000);
    await c1.request({ type: 'embed', text: 'one' }, 20_000);

    const restore2 = applyEnv({ SOX_EMBED_HOST_MAIN: f2.shimPath });
    cleanups.push(restore2);
    const c2 = new FunneledFastembedClient();
    await c2.request(init, 20_000);
    await c2.request({ type: 'embed', text: 'two' }, 20_000);

    expect(computeEmbedHostBuildId(f1.shimPath)).not.toBe(computeEmbedHostBuildId(f2.shimPath));
    expect(c1.hostSocketPath).not.toBeNull();
    expect(c2.hostSocketPath).not.toBe(c1.hostSocketPath);
    expect(fs.existsSync(c1.hostSocketPath!)).toBe(true);
    expect(fs.existsSync(c2.hostSocketPath!)).toBe(true);
    const pids1 = hostPids(f1.shimPath);
    const pids2 = hostPids(f2.shimPath);
    expect(pids1, 'build one runs exactly one host').toHaveLength(1);
    expect(pids2, 'build two spawned its OWN host instead of dialling build one').toHaveLength(1);
    expect(pids1[0]).not.toBe(pids2[0]);
  }, 90_000);

  it('(e) a host spawned with a forged --build-id exits 3 and never binds', async () => {
    const f = sandbox('sox-2fe52b0f-e');
    const { socketPath, exit } = spawnHostDirect(f, { buildId: '000000000000' });
    expect(await exit).toBe(3);
    expect(fs.existsSync(socketPath)).toBe(false);
  }, 60_000);

  it('the build id is 12 hex, stable for identical bytes, and covers every .js sibling', () => {
    const f = sandbox('sox-2fe52b0f-id');
    const id1 = computeEmbedHostBuildId(f.shimPath);
    expect(id1).toMatch(/^[0-9a-f]{12}$/);
    __resetEmbedHostBuildIdMemoForTests();
    expect(computeEmbedHostBuildId(f.shimPath)).toBe(id1);
    fs.writeFileSync(path.join(path.dirname(f.shimPath), 'sibling.cjs'), 'module.exports = 1;\n');
    __resetEmbedHostBuildIdMemoForTests();
    expect(computeEmbedHostBuildId(f.shimPath)).not.toBe(id1);
  });
});
