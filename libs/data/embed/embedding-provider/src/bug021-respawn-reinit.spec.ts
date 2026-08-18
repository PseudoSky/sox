/**
 * bug021-respawn-reinit.spec.ts — BUG-021 (live incident, 2026-08-18).
 *
 * ROOT CAUSE: `SharedFastembedProcessClient.ensureProcess()`'s `c.on('exit')`/
 * `c.on('error')` handlers null out `this.child`/`this.startingPromise` on an
 * unexpected child death, but (before this fix) nothing told the client the
 * NEXT real (`embed`/`embedBatch`) request would transparently fork a BRAND
 * NEW, un-initialized child via `ensureProcess()`. The higher layer
 * (`FastembedProvider.ready` in `fastembed.ts`) is latched `true` from the
 * ORIGINAL successful `init` and never re-sends it once `ready`, so the
 * respawned child received real requests with no model loaded — the host's
 * own `handleRequest()` (`fastembedProcessHost.ts`) replies `{ error: 'Model
 * not initialized' }` to every one of them, forever, until a full process
 * restart.
 *
 * Live evidence this matches exactly: the advisory lock file showed the
 * fastembed child had been forked mere SECONDS before every request against
 * it failed — a transparent respawn-without-reinit, not a stale/orphaned
 * lock from a killed predecessor (that hypothesis was explicitly ruled out
 * in the filed incident).
 *
 * This suite drives the REAL `SharedFastembedProcessClient` (not a
 * hand-rolled parity re-implementation) against a stub fork target that
 * mimics `fastembedProcessHost.ts`'s exact wire contract: replies `initOk`
 * to `init`, replies `{ error: 'Model not initialized' }` to `embed` when it
 * has not (yet, or again) been initialized, and can be told to simulate an
 * unexpected crash (`process.exit(1)`, mirroring the native SIGABRT/
 * std::bad_alloc/EPIPE crash hazards documented throughout this file) after
 * which a respawned instance of the SAME script starts fresh with no model
 * state — precisely reproducing the live failure shape without loading a
 * real ONNX model.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedFastembedProcessClient } from './sharedFastembedProcess.js';

let tmpDir: string;
let hostPath: string;

afterEach(() => {
  if (tmpDir) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/**
 * Stub fork target mirroring `fastembedProcessHost.ts`'s protocol:
 *   - `init`  -> sets an in-process "model loaded" flag, replies `initOk`.
 *   - `embed` -> replies `{ embedding: [...] }` if the flag is set, else the
 *                EXACT error string the real host sends: `'Model not
 *                initialized'`.
 *   - `crash` -> `process.exit(1)` immediately, no reply — simulates the
 *                child dying out from under the client mid-lifecycle. A
 *                freshly forked replacement (same script) starts with the
 *                flag unset, exactly like a real respawned
 *                `fastembedProcessHost.js` with an empty `_embedder`.
 */
function writeStubHost(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug021-'));
  const p = path.join(tmpDir, 'stub-host.mjs');
  fs.writeFileSync(
    p,
    [
      `let modelLoaded = false;`,
      `process.on('message', (msg) => {`,
      `  if (msg.type === 'crash') { process.exit(1); return; }`,
      `  if (msg.type === 'init') {`,
      `    modelLoaded = true;`,
      `    if (process.connected) process.send({ id: msg.id, initOk: true, dim: 3, execution_provider: 'cpu' });`,
      `    return;`,
      `  }`,
      `  if (msg.type === 'embed') {`,
      `    if (!modelLoaded) {`,
      `      if (process.connected) process.send({ id: msg.id, error: 'Model not initialized' });`,
      `      return;`,
      `    }`,
      `    if (process.connected) process.send({ id: msg.id, embedding: [0.1, 0.2, 0.3] });`,
      `    return;`,
      `  }`,
      `});`,
      '',
    ].join('\n'),
  );
  return p;
}

describe('BUG-021 — a respawned fastembed child is transparently re-initialized', () => {
  it('replays the last init payload before serving a request to a freshly respawned child', async () => {
    hostPath = writeStubHost();
    const client = new SharedFastembedProcessClient(hostPath);

    // 1) Normal startup: init succeeds, embed works.
    const initRes = await client.request<{ initOk: true; dim: number }>(
      { type: 'init', model: 'stub', cacheDir: '/tmp' },
      5000,
    );
    expect(initRes.initOk).toBe(true);

    const firstEmbed = await client.request<{ embedding: number[] }>({ type: 'embed', text: 'hello' }, 5000);
    expect(firstEmbed.embedding).toEqual([0.1, 0.2, 0.3]);

    // 2) Simulate the exact live-incident failure: the child dies
    // unexpectedly (crash/OOM/native abort — NOT a graceful `terminate()`).
    // `child.send({ type: 'crash' })`-triggered `process.exit(1)` fires the
    // client's own `c.on('exit')` handler, nulling `this.child` — the same
    // path a real crash takes.
    await client.request({ type: 'crash' }, 2000).catch(() => undefined);
    // Give the exit handler a tick to run before the next request.
    await new Promise((r) => setTimeout(r, 100));

    // 3) A real request arrives AFTER the crash, with no explicit re-init
    // from the caller — exactly what `fastembed.ts`'s `FastembedProvider`
    // does: its `ready` flag is already `true` from step 1, so
    // `ensureReady()` short-circuits and never re-sends `init`.
    //
    // BEFORE THE FIX: `ensureProcess()` silently forks a brand-new,
    // un-initialized child; this request reaches it directly and the stub
    // (mirroring the real host) replies `{ error: 'Model not initialized' }`
    // — the client rejects with exactly that message, reproducing BUG-021.
    //
    // AFTER THE FIX: the client detects the fresh child has no model loaded
    // (`childInitialized === false` while `lastInitPayload` is set) and
    // transparently replays `init` before this request is ever sent.
    const secondEmbed = await client.request<{ embedding: number[] }>({ type: 'embed', text: 'world' }, 5000);
    expect(secondEmbed.embedding).toEqual([0.1, 0.2, 0.3]);

    await client.terminate();
  }, 15_000);
});
