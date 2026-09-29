/**
 * BL-5124be6c — fastembedProcessHost's cache-hit (already-loaded) `init`
 * branch reported `execution_provider: 'cpu'` unconditionally, even when the
 * model was originally loaded with a non-cpu provider (coreml/cuda). Root
 * cause: `loadModel()` declared `let execution_provider = 'cpu'` fresh on
 * every call and only reassigned it inside the "not yet loaded" branch, so a
 * second `init` for an already-loaded model fell through to the hardcoded
 * default. Fix persists the active provider in module state
 * (`_currentExecutionProvider`) and returns it unconditionally.
 *
 * Also covers the adjacent hostCpuSplit fix landed in the same diff: `init`
 * replies now carry `work_ms`/`cpu_ms` (from `measureWork()`), so a
 * page-in-vs-compute split is attributable per request instead of being
 * indistinguishable from queue/IPC time.
 *
 * Forks the REAL `fastembedProcessHost.ts` (via tsx), following the proven
 * harness in `fastembedProcessHost-bug005-dim.spec.ts`: real fastembed
 * package, the run's scratch-cloned model (BL-230d1d2a; never a download), execution provider
 * forced via env for determinism.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { log } from '@adhd/sox-telemetry';
import { isModelCached } from './index.js';
import { EMBED_SCRATCH_KEY, embedScratchOrNull } from './test-support/scratchModelCache.js';

const HOST_PATH = resolve(__dirname, 'fastembedProcessHost.ts');
// BL-230d1d2a: the run-scoped scratch model cache (seeded by APFS clone from the
// operator cache in vitest.global-scratch.ts) — NEVER the operator's
// ~/.cache/sox/models, which this spec used to fork the real host at.
const SCRATCH = embedScratchOrNull(inject(EMBED_SCRATCH_KEY));
if (SCRATCH === null) throw new Error('run through the project vitest config: no scratch model cache was provided');
const CACHE_DIR = SCRATCH.modelCache;
// Skip-not-fail when nothing was seeded: the alternative is a download.
const MODEL_SEEDED = isModelCached(CACHE_DIR, 'fast-bge-small-en-v1.5');
const MODEL = 'bge-small-en-v1.5';

let child: ChildProcess | undefined;
let scratchDir: string | undefined;

afterEach(() => {
  if (child && !child.killed) {
    try {
      child.kill('SIGKILL');
    } catch (err) {
      log.warn('embedding_provider.spec.bl5124be6c.kill_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  child = undefined;
  if (scratchDir) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch (err) {
      log.warn('embedding_provider.spec.bl5124be6c.rm_scratch_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    scratchDir = undefined;
  }
});

function forkHost(forcedProvider: string): ChildProcess {
  const scratch = mkdtempSync(join(tmpdir(), 'sox-fastembed-5124be6c-'));
  scratchDir = scratch;
  return fork(HOST_PATH, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: {
      ...process.env,
      SOX_EMBED_EXECUTION_PROVIDER: forcedProvider,
      SOX_FASTEMBED_LOCK_PATH: join(scratch, 'fastembed-host.lock'),
      SOX_ECOSYSTEM_HOME: join(scratch, 'sox-home'),
    },
  });
}

function sendInit(c: ChildProcess, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolveReply, reject) => {
    // All three listeners are removed on every exit path (resolve, reject-by-
    // error, reject-by-timeout) so a later event on this same long-lived
    // child (the caller re-uses `child` across two sendInit calls) never
    // fires a listener for an already-settled promise.
    const cleanup = (): void => {
      clearTimeout(timeout);
      c.off('message', onMessage);
      c.off('error', onError);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`init id=${id} reply timed out after 90s`));
    }, 90_000);
    const onMessage = (msg: { id?: number; type?: unknown } & Record<string, unknown>) => {
      if (msg.type === 'telemetry.ready') return;
      if (msg.id !== id) return;
      cleanup();
      resolveReply(msg);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    c.on('message', onMessage);
    c.on('error', onError);
    c.send({ type: 'init', model: MODEL, cacheDir: CACHE_DIR, id });
  });
}

describe('BL-5124be6c — execution_provider persists across re-init of an already-loaded model', () => {
  // coreml is only a valid onnxruntime-node execution provider on darwin;
  // forcing it unconditionally made this fail on Linux CI for reasons
  // unrelated to BL-5124be6c (no CoreML EP present, so the load either
  // throws or silently falls back). Gate to darwin so the provider name is
  // always valid on the platform running it.
  it.runIf(process.platform === 'darwin' && MODEL_SEEDED)(
    'second init for the SAME already-loaded model reports the ORIGINAL forced provider, not hardcoded cpu (pre-fix: always cpu)',
    async () => {
      // Force a non-cpu provider name so the pre-fix hardcoded-'cpu' default
      // is distinguishable from the real persisted value.
      child = forkHost('coreml');

      const first = await sendInit(child, 1);
      expect(first['initOk']).toBe(true);
      expect(first['execution_provider']).toBe('coreml');
      expect(typeof first['work_ms']).toBe('number');
      expect(first['work_ms'] as number).toBeGreaterThanOrEqual(0);
      expect(typeof first['cpu_ms']).toBe('number');
      expect(first['cpu_ms'] as number).toBeGreaterThanOrEqual(0);
      // host_queue_ms is optional (platform/timing-dependent) but must be a
      // non-negative number whenever present — the telemetry addition this
      // suite's header claims to cover.
      if (first['host_queue_ms'] !== undefined) {
        expect(typeof first['host_queue_ms']).toBe('number');
        expect(first['host_queue_ms'] as number).toBeGreaterThanOrEqual(0);
      }
      if (first['host_majflt'] !== undefined) expect(typeof first['host_majflt']).toBe('number');
      if (first['host_minflt'] !== undefined) expect(typeof first['host_minflt']).toBe('number');

      // Re-init with the exact same model/cacheDir hits the already-loaded
      // branch in loadModel() — this is the branch that mis-reported.
      const second = await sendInit(child, 2);
      expect(second['initOk']).toBe(true);
      expect(second['execution_provider']).toBe('coreml');
      expect(typeof second['work_ms']).toBe('number');
      expect(typeof second['cpu_ms']).toBe('number');
      // The second init is a cache hit (model already loaded) — it must not
      // redo the real load work the first init did.
      expect(second['work_ms'] as number).toBeLessThan(first['work_ms'] as number);
    },
    120_000,
  );
});
