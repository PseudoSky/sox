/**
 * vitest.setup-scratch.ts — per-worker half of embedding-provider's scratch
 * harness (BL-230d1d2a, BL-0b0573f8). Runs before every spec file.
 *
 * Points the product's EXISTING path config inside the run's scratch root
 * (these are locations, not feature switches — ADR-0013), so every default
 * resolution a spec falls through to (os.tmpdir(), the model cache, the
 * ecosystem data root and its socket dir) lands in scratch, and arms the
 * funnel's TYPED spawn-time guard so no in-process funnel client can probe,
 * spawn or dial a host whose --cache-dir/--socket is outside that root.
 */
import * as path from 'node:path';
import { inject } from 'vitest';
import { __setFunnelSpawnGuardForTests } from './src/spawnScratchGuard';
import { EMBED_SCRATCH_KEY, embedScratchOrNull } from './src/test-support/scratchModelCache';

const scratch = embedScratchOrNull(inject(EMBED_SCRATCH_KEY));
if (scratch === null) {
  throw new Error('[embedding-provider scratch] no scratch root was provided — run through vitest.config.ts (globalSetup)');
}
process.env['TMPDIR'] = scratch.tmp;
process.env['XDG_CACHE_HOME'] = path.join(scratch.root, 'xdg-cache');
process.env['SOX_EMBED_CACHE_DIR'] = scratch.modelCache;
process.env['SOX_ECOSYSTEM_HOME'] = scratch.soxHome;
__setFunnelSpawnGuardForTests({ scratchRoot: scratch.root });
