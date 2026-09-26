/**
 * 2fe52b0f-rebuild-under-running-spawner.spec.ts — a long-lived spawner survives
 * an in-place `dist/` rebuild of the host it spawns (ADR-0022 §4).
 *
 * `computeEmbedHostBuildId()` used to memoize its result per host-main path for
 * the life of the calling process, on the stated assumption that "a new build
 * is a new process" — false here, since every sox service runs straight out of
 * a `dist/` that is rebuilt IN PLACE (see the repo AGENTS.md "a revert is not
 * finished until you rebuild"). Failure sequence this reproduces end-to-end
 * with REAL processes (no mocked build-id math):
 *
 *   1. A long-lived `FunneledFastembedClient` spawns a host and embeds
 *      successfully — its in-process build-id memo is now warm.
 *   2. The host retires (work-driven idle reap, ADR-0022).
 *   3. The host dir is rewritten in place (a rebuild).
 *   4. The SAME client, still holding the stale memoized build id, tries to
 *      embed again. Pre-fix: it spawns a host with the stale id in argv; the
 *      freshly-rebuilt host computes its OWN id fresh (no memo, first call in
 *      a new process), sees a mismatch, and exits 3 (`embedHostMain.ts`'s
 *      build-id guard) — forever, because nothing ever invalidates the
 *      client's memo. Post-fix: `computeEmbedHostBuildId()` re-checks a cheap
 *      stat fingerprint on every call and rehashes when it changed, so the
 *      client computes the CORRECT id before ever spawning.
 */
import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetEmbedHostBuildIdMemoForTests, configureEmbedHostIdleGraceMs } from './embedHostConfig.js';
import { FunneledFastembedClient } from './funnelClient.js';
import {
  applyEnv,
  destroyFunnelDir,
  EMBED_HOST_TS_URL,
  funnelEnvVars,
  hostShimSource,
  hostPids,
  makeFunnelDir,
  waitFor,
  type FunnelDir,
} from './test-support/funnelHarness.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
  configureEmbedHostIdleGraceMs(undefined);
  __resetEmbedHostBuildIdMemoForTests();
});

function sandbox(prefix: string): FunnelDir {
  const f = makeFunnelDir(prefix);
  cleanups.push(() => destroyFunnelDir(f));
  return f;
}

describe('2fe52b0f — a rebuild under a running spawner does not wedge the funnel forever', () => {
  it(
    'the SAME long-lived client embeds again, successfully, after the host dir is rewritten while it was holding a stale memoized build id',
    async () => {
      const f = sandbox('sox-2fe52b0f-rebuild');
      // Short idle window: the host retires quickly so the test does not wait
      // the 60s ADR-0022 default. Typed config, not an env toggle.
      configureEmbedHostIdleGraceMs(1_000);
      cleanups.push(applyEnv(funnelEnvVars(f)));

      const client = new FunneledFastembedClient();
      const init = { type: 'init', model: 'stub', cacheDir: f.cache };

      // 1) Spawn a host and embed once — the client's build-id memo is warm now.
      await client.request(init, 20_000);
      const before = await client.request({ type: 'embed', text: 'before rebuild' }, 20_000);
      expect(before).toMatchObject({ embedding: [0, 0, 0] });
      const socketPath = client.hostSocketPath;
      expect(socketPath).not.toBeNull();

      // 2) Let the host retire (work-driven idle reap).
      await waitFor(() => hostPids(f.shimPath).length === 0, 20_000, 'host retirement');
      await waitFor(() => !fs.existsSync(socketPath!), 5_000, 'socket unlinked after retirement');

      // 3) Rewrite the host dir in place — a rebuild. Same filename, different
      // bytes (a fresh marker comment), which is exactly what an esbuild
      // rebuild does to `dist/embedHostMain.js`.
      fs.writeFileSync(f.shimPath, hostShimSource(EMBED_HOST_TS_URL, `rebuilt at ${Date.now()}`));

      // 4) The SAME client — never recreated, memo never reset by the test —
      // embeds again. This is RED pre-fix: the client spawns a host with its
      // stale cached build id, the freshly-rebuilt host computes a NEW id for
      // itself and exits 3 on the mismatch, and the client has no way to
      // notice its id is stale, so this throws and stays broken.
      const after = await client.request({ type: 'embed', text: 'after rebuild' }, 20_000);
      expect(after).toMatchObject({ embedding: [0, 0, 0] });

      // The rebuild produced a NEW build id, hence a new singleton key and a
      // new socket — a fresh host was spawned rather than the client wedging
      // on the old one.
      expect(client.hostSocketPath).not.toBeNull();
      expect(client.hostSocketPath).not.toBe(socketPath);
      expect(hostPids(f.shimPath)).toHaveLength(1);
    },
    90_000,
  );
});
