/**
 * 4041c6e0-umask-002-funnel.spec.ts — the embedding funnel repairs a legacy 0775
 * `$SOX_ECOSYSTEM_HOME/run` before it judges it (BL-4041c6e0, BL-6233c1c2).
 *
 * The funnel's host socket lives in `$SOX_ECOSYSTEM_HOME/run` (tier 1/2 when the
 * path fits). A run dir that an older build or a umask-002 mkdir left 0775 is
 * refused by the socket-dir trust check, so without the repair every embed fails
 * with a PermanentEmbeddingError. The funnel calls `tightenOwnedSocketDir` on
 * that dir before its first probe or ensure.
 *
 * Runs under umask 002, restored in `finally`, inside a funnelHarness sandbox
 * (scratch home, stub ONNX host). The prefix is short so the socket stays under
 * the sandbox's run dir rather than the /tmp/sox-<uid> fallback.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetEmbedHostConfigForTests, embedHostSocketPath, embedHostSingletonKey, computeEmbedHostBuildId, resolveEmbedHostConfig } from './embedHostConfig.js';
import { FunneledFastembedClient } from './funnelClient.js';
import { applyEnv, destroyFunnelDir, funnelEnvVars, makeFunnelDir } from './test-support/funnelHarness.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  __resetEmbedHostConfigForTests();
});

describe('BL-4041c6e0 / 6233c1c2: funnel under umask 002', () => {
  it('4041c6e0 6233c1c2: a pre-created 0775 $SOX_ECOSYSTEM_HOME/run still lets an embed succeed', async () => {
    expect(() => process.umask()).not.toThrow(); // precondition: umask is settable here
    const prevUmask = process.umask(0o002);
    try {
      const f = makeFunnelDir('e4');
      cleanups.push(() => destroyFunnelDir(f));
      cleanups.push(applyEnv(funnelEnvVars(f)));

      const run = path.join(f.home, 'run');
      fs.mkdirSync(run); // legacy shape under umask 002
      expect(fs.statSync(run).mode & 0o777).toBe(0o775);

      // The socket must actually live in `run` for this to test anything.
      const key = embedHostSingletonKey('stub', 'cpu', f.cache, computeEmbedHostBuildId(f.shimPath));
      expect(path.dirname(embedHostSocketPath(resolveEmbedHostConfig(), key))).toBe(run);

      const client = new FunneledFastembedClient();
      cleanups.push(() => client.terminate());
      await client.request({ type: 'init', model: 'stub', cacheDir: f.cache }, 30_000);
      const out = await client.request({ type: 'embed', text: 'hello' }, 30_000);
      expect(out).toBeDefined();
      expect(fs.statSync(run).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(prevUmask);
    }
  }, 60_000);
});
