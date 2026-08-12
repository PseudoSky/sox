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
 * Deliberately points `cacheDir` at the package's OWN default model cache
 * (`~/.cache/sox/models`, resolved exactly like `joinDefaultCacheDir()` in
 * `index.ts`): the model loads from cache when present (the normal
 * development state — and the state that makes the test fast and hermetic,
 * no download), and downloads on first run in a cold environment, matching
 * the bl426 spec's existing download behavior.
 *
 * Isolation: `SOX_EMBED_EXECUTION_PROVIDER=cpu` (fast, avoids CoreML/ANE
 * contention), `SOX_FASTEMBED_LOCK_PATH` and `SOX_ECOSYSTEM_HOME` pointed at
 * a per-run scratch dir — never the shared default tmpdir lock (BUG-004) and
 * never the real ecosystem home.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from './fastembedModels.js';

const HOST_PATH = resolve(__dirname, 'fastembedProcessHost.ts');

// The package's own default cache dir (mirrors `joinDefaultCacheDir()` in
// index.ts: $XDG_CACHE_HOME/sox/models, else ~/.cache/sox/models).
const CACHE_DIR = join(process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'), 'sox', 'models');

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
  // Remove the per-run scratch dir (lock file + telemetry home). Never the
  // bl426 cache dir and never the shared default lock path (BUG-004).
  if (scratchDir) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* ignore */
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
  it(
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
