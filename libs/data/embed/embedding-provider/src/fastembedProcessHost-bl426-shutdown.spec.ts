/**
 * fastembedProcessHost-bl426-shutdown.spec.ts — BL-426.
 *
 * Symptom (found while proving BL-412/BL-405 red→green): stderr immediately
 * after `[memory-server backend] SIGTERM — shutting down`:
 *
 *   libc++abi: terminating due to uncaught exception of type
 *   std::__1::system_error: mutex lock failed: Invalid argument
 *
 * a native (C++, not JS) crash. Isolated to `fastembedProcessHost.ts`'s
 * `__shutdown` message handler by forking THIS FILE DIRECTLY (no
 * memory-server, no backend.ts, no Turso, no ONNX rerank
 * worker/`sharedOnnxWorker.ts`) and driving it through a real
 * `init` → (`embed`) → `__shutdown` sequence:
 *
 *   - Reproduced on the `coreml` EP (the default on darwin) AND with
 *     `SOX_EMBED_EXECUTION_PROVIDER=cpu` forced — not CoreML-specific.
 *   - Reproduced with `init` alone, with zero `embed` calls ever made — not
 *     tied to in-flight embed work.
 *   - The pre-fix handler called `process.exit(0)` on `__shutdown`, which
 *     forces an ABRUPT teardown (skips draining the event loop, runs native
 *     atexit/static-destructor unwinding immediately). Once an
 *     onnxruntime-node `InferenceSession` has been created in this process,
 *     its own native background thread pool is still alive/tearing down
 *     when that abrupt unwind runs and the two race on a native mutex,
 *     aborting the child with SIGABRT instead of exiting 0.
 *   - Replacing `process.exit(0)` with `process.disconnect()` (let any
 *     queued request settle, then let Node's own normal exit sequence run
 *     once the loop is empty, rather than forcing an abrupt unwind)
 *     eliminates the crash in the same isolated repro.
 *
 * This suite forks the REAL `fastembedProcessHost.ts` (via `tsx`, matching
 * `bl410-standalone-exit-survives-load.spec.ts`'s pattern) and does REAL
 * `init`/`embed` calls against the real `fastembed` package — no mocks, no
 * stub host — because the crash is a genuine native race that a stub
 * host/mocked onnxruntime session cannot reproduce at all.
 */
import { fork, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const HOST_PATH = path.resolve(__dirname, 'fastembedProcessHost.ts');
const CACHE_DIR = path.join(os.tmpdir(), 'sox-fastembed-bl426-cache');
const MUTEX_CRASH_RE = /mutex lock failed|libc\+\+abi: terminating/;

let child: ChildProcess | undefined;

afterEach(() => {
  if (child && !child.killed) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  child = undefined;
});

interface ShutdownResult {
  stderr: string;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

/**
 * Fork the real host, run the given interaction (a callback given a typed
 * `send()`), then send `__shutdown` and wait for the child to actually exit
 * (or time out, which itself is a failure — a hang is not acceptable
 * either).
 */
function runShutdownScenario(
  interact: (send: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<void>,
  env: NodeJS.ProcessEnv = {},
): Promise<ShutdownResult> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    let nextId = 1;
    const pending = new Map<number, (msg: Record<string, unknown>) => void>();

    child = fork(HOST_PATH, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ...env },
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('message', (msg: { id: number } & Record<string, unknown>) => {
      const resolver = pending.get(msg.id);
      if (!resolver) return;
      pending.delete(msg.id);
      resolver(msg);
    });

    child.on('error', (err) => reject(err));

    const send = (msg: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const id = nextId++;
      return new Promise((res) => {
        pending.set(id, res);
        child!.send({ ...msg, id });
      });
    };

    const timeout = setTimeout(() => {
      reject(new Error(`BL-426 scenario timed out; stderr so far:\n${stderr}`));
    }, 30_000);

    child.on('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ stderr, exitCode: code, exitSignal: signal });
    });

    interact(send)
      .then(() => {
        child!.send({ __shutdown: true });
      })
      .catch((err: unknown) => {
        clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

describe('BL-426 — fastembedProcessHost shutdown must not crash the native onnxruntime session', () => {
  it(
    'init + embed, then __shutdown: no libc++abi/mutex crash, exits code 0 (not SIGABRT)',
    async () => {
      const result = await runShutdownScenario(async (send) => {
        const initResp = await send({ type: 'init', model: 'bge-small-en-v1.5', cacheDir: CACHE_DIR });
        expect(initResp['initOk']).toBe(true);

        const embedResp = await send({ type: 'embed', text: 'BL-426 regression: real embed before shutdown' });
        expect(Array.isArray(embedResp['embedding'])).toBe(true);
        expect((embedResp['embedding'] as number[]).length).toBeGreaterThan(0);
      });

      expect(result.stderr).not.toMatch(MUTEX_CRASH_RE);
      expect(result.exitSignal).toBeNull();
      expect(result.exitCode).toBe(0);
    },
    60_000,
  );

  it(
    'init alone (no embed call), then __shutdown: no crash — the hazard is NOT tied to in-flight embed work',
    async () => {
      const result = await runShutdownScenario(async (send) => {
        const initResp = await send({ type: 'init', model: 'bge-small-en-v1.5', cacheDir: CACHE_DIR });
        expect(initResp['initOk']).toBe(true);
      });

      expect(result.stderr).not.toMatch(MUTEX_CRASH_RE);
      expect(result.exitSignal).toBeNull();
      expect(result.exitCode).toBe(0);
    },
    60_000,
  );

  it(
    'forced CPU execution provider, then __shutdown: no crash — NOT CoreML-specific',
    async () => {
      const result = await runShutdownScenario(
        async (send) => {
          const initResp = await send({ type: 'init', model: 'bge-small-en-v1.5', cacheDir: CACHE_DIR });
          expect(initResp['initOk']).toBe(true);
          expect(initResp['execution_provider']).toBe('cpu');
        },
        { SOX_EMBED_EXECUTION_PROVIDER: 'cpu' },
      );

      expect(result.stderr).not.toMatch(MUTEX_CRASH_RE);
      expect(result.exitSignal).toBeNull();
      expect(result.exitCode).toBe(0);
    },
    60_000,
  );

  it('the shipped source uses process.disconnect(), not process.exit(0), on __shutdown', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const src = fs.readFileSync(HOST_PATH, 'utf8');
    const shutdownBlock = src.slice(src.indexOf("'__shutdown' in msg"));
    expect(shutdownBlock).toContain('process.disconnect()');
    expect(shutdownBlock).not.toMatch(/process\.exit\(0\)/);
  });
});
