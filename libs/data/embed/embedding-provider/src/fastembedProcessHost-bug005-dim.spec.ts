/**
 * BUG-005 — integration regression test through the REAL forked child
 * process: `init` reply must report a positive dimension matching the model
 * (pre-fix it always reported `dim: 0` because the dim lookup compared the
 * raw configured name against fastembed's enum-value list and never matched).
 *
 * Follows `fastembedProcessHost-bl426-shutdown.spec.ts`'s proven harness:
 * fork the REAL `fastembedProcessHost.ts` (via tsx) and drive a real
 * `init` → `__shutdown` sequence against the real `fastembed` package.
 *
 * `cacheDir` is the run's SCRATCH model cache (BL-230d1d2a): the project
 * globalSetup clones the operator's cache into a `/tmp/sox-ep-*` root, so the
 * model loads with no download and the operator cache is never opened by the
 * host. With nothing seeded (a cold box) the test skips rather than download.
 *
 * Isolation: `SOX_EMBED_EXECUTION_PROVIDER=cpu` (fast, avoids CoreML/ANE
 * contention), `SOX_FASTEMBED_LOCK_PATH` and `SOX_ECOSYSTEM_HOME` pointed at
 * a per-run scratch dir — never the shared default tmpdir lock (BUG-004) and
 * never the real ecosystem home.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { log } from '@adhd/sox-telemetry';
import { MODEL_CONFIGS } from './fastembedModels.js';
import { isModelCached } from './index.js';
import { EMBED_SCRATCH_KEY, embedScratchOrNull } from './test-support/scratchModelCache.js';

const HOST_PATH = resolve(__dirname, 'fastembedProcessHost.ts');

// BL-230d1d2a: the run-scoped scratch model cache (seeded by APFS clone from the
// operator cache in vitest.global-scratch.ts) — NEVER the operator's
// ~/.cache/sox/models, which this spec used to fork the real host at.
const SCRATCH = embedScratchOrNull(inject(EMBED_SCRATCH_KEY));
if (SCRATCH === null) throw new Error('run through the project vitest config: no scratch model cache was provided');
const CACHE_DIR = SCRATCH.modelCache;

let child: ChildProcess | undefined;
let scratchDir: string | undefined;

afterEach(() => {
  if (child && !child.killed) {
    try {
      child.kill('SIGKILL');
    } catch (err) {
      log.warn('embedding_provider.spec.bug005.kill_failed', { error: String(err) });
    }
  }
  child = undefined;
  // Remove the per-run scratch dir (lock file + telemetry home). Never the
  // bl426 cache dir and never the shared default lock path (BUG-004).
  if (scratchDir) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch (err) {
      log.warn('embedding_provider.spec.bug005.rm_scratch_failed', { error: String(err) });
    }
    scratchDir = undefined;
  }
});

/** Fork the real host, send `{ type: 'init', ... }`, return the reply. */
function initRealChild(model: string): Promise<Record<string, unknown>> {
  const scratch = mkdtempSync(join(tmpdir(), 'sox-fastembed-bug005-'));
  scratchDir = scratch;
  child = fork(HOST_PATH, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: {
      ...process.env,
      SOX_EMBED_EXECUTION_PROVIDER: 'cpu',
      SOX_FASTEMBED_LOCK_PATH: join(scratch, 'fastembed-host.lock'),
      SOX_ECOSYSTEM_HOME: join(scratch, 'sox-home'),
    },
  });

  return new Promise((resolveReply, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`BUG-005 init reply timed out after 90s for model "${model}"`)),
      90_000,
    );
    child!.on('message', (msg: { id: number } & Record<string, unknown>) => {
      // BL-618: the host now acks its telemetry state with a `telemetry.ready`
      // message (no request `id`) before replying to the init request — skip it
      // and wait for the actual init reply.
      if ((msg as { type?: unknown }).type === 'telemetry.ready') return;
      clearTimeout(timeout);
      resolveReply(msg);
    });
    child!.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child!.send({ type: 'init', model, cacheDir: CACHE_DIR, id: 1 });
  });
}

describe('BUG-005 — fastembed child init reply reports the REAL model dimension', () => {
  it.runIf(isModelCached(CACHE_DIR, 'fast-bge-base-en-v1.5'))(
    'init with the cached bge-base-en-v1.5 model: initOk true and dim 768 (pre-fix: dim was always 0)',
    async () => {
      const reply = await initRealChild('bge-base-en-v1.5');
      expect(reply['initOk']).toBe(true);
      const dim = reply['dim'] as number;
      expect(dim).toBeGreaterThan(0);
      expect(dim).toBe(MODEL_CONFIGS['bge-base-en-v1.5']!.dim);
      expect(dim).toBe(768);
      // execution_provider is forced to cpu by the test env.
      expect(reply['execution_provider']).toBe('cpu');
    },
    120_000,
  );
});
