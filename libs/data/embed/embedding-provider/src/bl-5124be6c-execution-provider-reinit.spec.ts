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
 * package, cached model (no download in the common case), execution provider
 * forced via env for determinism.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HOST_PATH = resolve(__dirname, 'fastembedProcessHost.ts');
const CACHE_DIR = join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'sox', 'models');
const MODEL = 'bge-small-en-v1.5';

let child: ChildProcess | undefined;
let scratchDir: string | undefined;

afterEach(() => {
  if (child && !child.killed) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  child = undefined;
  if (scratchDir) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* ignore */
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
    const timeout = setTimeout(
      () => reject(new Error(`init id=${id} reply timed out after 90s`)),
      90_000,
    );
    const onMessage = (msg: { id?: number; type?: unknown } & Record<string, unknown>) => {
      if (msg.type === 'telemetry.ready') return;
      if (msg.id !== id) return;
      clearTimeout(timeout);
      c.off('message', onMessage);
      resolveReply(msg);
    };
    c.on('message', onMessage);
    c.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    c.send({ type: 'init', model: MODEL, cacheDir: CACHE_DIR, id });
  });
}

describe('BL-5124be6c — execution_provider persists across re-init of an already-loaded model', () => {
  it(
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

      // Re-init with the exact same model/cacheDir hits the already-loaded
      // branch in loadModel() — this is the branch that mis-reported.
      const second = await sendInit(child, 2);
      expect(second['initOk']).toBe(true);
      expect(second['execution_provider']).toBe('coreml');
      expect(typeof second['work_ms']).toBe('number');
      expect(typeof second['cpu_ms']).toBe('number');
    },
    120_000,
  );
});
