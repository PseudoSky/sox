/**
 * BL-230d1d2a — embedding-provider's specs must never touch the operator's
 * model cache (`~/.cache/sox/models`).
 *
 * Before the fix, `bl-5124be6c`, `fastembedProcessHost-bug005-dim` and
 * `fastembedProcessHost-bl426-shutdown` built their cache path from
 * `$XDG_CACHE_HOME|~/.cache` and forked the real `fastembedProcessHost` at it,
 * and `sharedFastembedProcess.spec`/`cfe12302` let `createEmbeddingProvider`
 * fall through to the same default. A missing model would have been downloaded
 * INTO the operator cache.
 *
 * The fix is the project harness (`vitest.global-scratch.ts` +
 * `vitest.setup-scratch.ts`): one run-scoped `/tmp/sox-ep-*` root whose model
 * cache is seeded by APFS clone from the operator cache (read-only there), with
 * the path config of every worker pointed inside it. These tests pin that:
 *   1. the product's DEFAULT cache resolution lands inside the scratch root,
 *      never in the operator cache;
 *   2. a real `fastembedProcessHost` fed the scratch cache loads the model with
 *      no download and leaves the operator cache byte- and mtime-identical.
 * The globalSetup teardown repeats (2) over the whole run.
 */
import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { log } from '@adhd/sox-telemetry';
import { createEmbeddingProvider, isModelCached } from './index.js';
import {
  EMBED_SCRATCH_KEY,
  diffSnapshots,
  embedScratchOrNull,
  findDownloadMarkers,
  pathInside,
  resolveOperatorModelCache,
  snapshotTree,
} from './test-support/scratchModelCache.js';

const scratch = embedScratchOrNull(inject(EMBED_SCRATCH_KEY));
// Outside the harness there is no provided context; fall back to resolving the
// operator cache from HOME only, so the assertion below is still meaningful.
const operatorCache = scratch?.operatorModelCache ?? resolveOperatorModelCache({});
const HF_REPO_ID = 'fast-bge-small-en-v1.5';
const MODEL_SEEDED = scratch !== null && isModelCached(scratch.modelCache, HF_REPO_ID);

let child: ChildProcess | undefined;
afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch (err) {
      log.warn('embedding_provider.spec.bl230d1d2a.kill_failed', { error: String(err) });
    }
  }
  child = undefined;
});

describe('BL-230d1d2a — specs resolve a scratch model cache, never the operator cache', () => {
  it('createEmbeddingProvider() with no cacheDir resolves inside the run scratch root, not the operator cache', async () => {
    const provider = await createEmbeddingProvider({ type: 'fastembed', model: 'bge-small-en-v1.5' });
    // Construction is inert (no host, no model load); read the resolved path.
    const resolved = (provider as unknown as { cacheDir: string }).cacheDir;
    expect(
      pathInside(resolved, operatorCache),
      `default model cache ${resolved} resolves into the operator cache ${operatorCache}`,
    ).toBe(false);
    expect(scratch, 'the project globalSetup must provide a scratch root').not.toBeNull();
    expect(pathInside(resolved, scratch!.root), `${resolved} is outside scratch root ${scratch!.root}`).toBe(true);
  });

  it('os.tmpdir(), XDG_CACHE_HOME and SOX_ECOSYSTEM_HOME all resolve inside the scratch root', async () => {
    const os = await import('node:os');
    expect(scratch, 'the project globalSetup must provide a scratch root').not.toBeNull();
    const root = scratch!.root;
    expect(pathInside(os.tmpdir(), root), `tmpdir ${os.tmpdir()}`).toBe(true);
    expect(pathInside(process.env['XDG_CACHE_HOME'] ?? '', root), 'XDG_CACHE_HOME').toBe(true);
    expect(pathInside(process.env['SOX_ECOSYSTEM_HOME'] ?? '', root), 'SOX_ECOSYSTEM_HOME').toBe(true);
    expect(pathInside(scratch!.modelCache, operatorCache)).toBe(false);
  });

  // Skip-not-fail when the operator has no model to clone from (a cold box):
  // the alternative is a download, which is exactly what this item forbids.
  it.runIf(MODEL_SEEDED)(
    'a real fastembedProcessHost loads bge-small from the scratch cache with zero downloads; operator cache bytes+mtime unchanged',
    async () => {
      const s = scratch!;
      const before = snapshotTree(s.operatorModelCache);
      const lockDir = fs.mkdtempSync(path.join(s.tmp, 'bl230-'));
      child = fork(path.resolve(__dirname, 'fastembedProcessHost.ts'), [], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        env: {
          ...process.env,
          SOX_EMBED_EXECUTION_PROVIDER: 'cpu',
          SOX_FASTEMBED_LOCK_PATH: path.join(lockDir, 'fastembed-host.lock'),
        },
      });
      const c = child;
      const reply = await new Promise<Record<string, unknown>>((resolveReply, reject) => {
        const timer = setTimeout(() => reject(new Error('init reply timed out after 90s')), 90_000);
        c.on('message', (m: Record<string, unknown>) => {
          if (m['id'] !== 1) return;
          clearTimeout(timer);
          resolveReply(m);
        });
        c.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        c.send({ type: 'init', model: 'bge-small-en-v1.5', cacheDir: s.modelCache, id: 1 });
      });
      expect(reply['initOk'], JSON.stringify(reply)).toBe(true);
      expect(reply['dim']).toBe(384);

      expect(findDownloadMarkers(s.root, s.seededSnapshot), 'download markers under the scratch root').toEqual([]);
      expect(diffSnapshots(s.seededSnapshot, snapshotTree(s.modelCache)), 'scratch model cache drifted from its seed').toEqual([]);
      expect(diffSnapshots(before, snapshotTree(s.operatorModelCache)), 'operator model cache changed').toEqual([]);
      expect(diffSnapshots(s.operatorSnapshot, snapshotTree(s.operatorModelCache)), 'operator cache changed since run start').toEqual([]);
    },
    120_000,
  );
});
