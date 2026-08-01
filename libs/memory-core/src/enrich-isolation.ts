/**
 * enrich-isolation.ts — BL-348 committed-stage boundary, PARENT-process side.
 *
 * See `enrich-process-host.ts` for the full rationale (event-loop-blocking
 * synchronous SQL + unhandled-rejection crash risk, both structurally ruled
 * out by a real OS process boundary). This module is the one entry point the
 * rest of memory-server should call instead of `runBatchEnrich()` directly
 * for the periodic/write-triggered clustering pass.
 *
 * `runEnrichIsolated()` NEVER throws and NEVER rejects — every outcome
 * (success, thrown error inside the child, timeout, unexpected exit/crash) is
 * reported as a `{ ok: true, result }` or `{ ok: false, error }` value. This
 * is deliberate: a floating `void runPeriodicEnrichPassGuarded()` call
 * upstream must never see a rejection, because an unhandled rejection is
 * fatal to the parent process by default — exactly the hazard this file
 * exists to eliminate. Do not "simplify" this to throw-on-error.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BatchEnrichOptions, BatchEnrichResult } from './enrich-batch.js';
import type { EnrichRequest, EnrichResponse } from './enrich-process-host.js';

export interface EnrichIsolatedOk {
  ok: true;
  result: BatchEnrichResult;
}
export interface EnrichIsolatedErr {
  ok: false;
  /** Human-readable cause: child-reported error message, 'timeout', or
   *  'exit:<code>'/'signal:<signal>' for a crash with no reported error. */
  error: string;
}
export type EnrichIsolatedResult = EnrichIsolatedOk | EnrichIsolatedErr;

/** Own directory, resolved in a way that is safe both under the esbuild CJS
 *  bundle (where `__dirname` is a real global injected by esbuild — never use
 *  `import.meta.url` here, it is `{}` in that context, BL-155) and under
 *  Vite/vitest's SSR execution of TS source (which also provides `__dirname`
 *  for CJS-shaped modules like this one, since the package has no `"type":
 *  "module"` and compiles to CommonJS). */
function resolveOwnDir(): string {
  if (typeof __dirname === 'string' && __dirname.length > 0) return __dirname;
  throw new Error('enrich-isolation: __dirname unavailable — unexpected execution context');
}

/**
 * Resolve the forkable entry point for `enrich-process-host`, and the node
 * flags needed to run it, across three execution contexts:
 *   1. Compiled dist sibling (production: `nx build memory-server` inlines
 *      memory-core, and the sidecar bundler emits `enrich-process-host.js`
 *      next to the main bundle — see `sox.sidecars` in this package's
 *      package.json and docs/standards/extension-bundling.md).
 *   2. Compiled dist fallback one level up (mirrors
 *      `sharedFastembedProcess.ts`'s `resolveFastembedHostPath` — vitest runs
 *      `.ts` files directly via SSR transform, so `__dirname` resolves to
 *      `src/`, which never contains a compiled `.js`, but a stale/partial
 *      `dist/` may still exist one directory up).
 *   3. Source TS directly, via `tsx`'s CJS register hook (dev/test only —
 *      never reachable in a bundled extension, where (1) always wins).
 */
function resolveEnrichHostFork(): { modulePath: string; execArgv: string[] } {
  const ownDir = resolveOwnDir();

  const sibling = join(ownDir, 'enrich-process-host.js');
  if (existsSync(sibling)) return { modulePath: sibling, execArgv: [] };

  const distFallback = join(ownDir, '..', 'dist', 'enrich-process-host.js');
  if (existsSync(distFallback)) return { modulePath: distFallback, execArgv: [] };

  const srcPath = join(ownDir, 'enrich-process-host.ts');
  if (existsSync(srcPath)) {
    const tsxRegister = require.resolve('tsx/cjs');
    return { modulePath: srcPath, execArgv: ['-r', tsxRegister] };
  }

  // Last resort: return the original candidate so the resulting error names
  // the path that was actually attempted, mirroring resolveFastembedHostPath.
  return { modulePath: sibling, execArgv: [] };
}

/** Test seam: force a specific resolution instead of the real lookup. */
let _forkResolverOverride: (() => { modulePath: string; execArgv: string[] }) | null = null;
export function _setEnrichHostForkResolverForTest(
  fn: (() => { modulePath: string; execArgv: string[] }) | null,
): void {
  _forkResolverOverride = fn;
}

let _nextId = 1;

/**
 * Run one `runBatchEnrich` pass in an isolated child process and await its
 * result. Never throws, never rejects.
 *
 * @param timeoutMs Hard wall-clock budget. On expiry the child is SIGTERM'd
 *   (then SIGKILL'd after a grace period if it doesn't exit) and the call
 *   resolves `{ ok: false, error: 'timeout' }`. A hung clustering pass can
 *   therefore never hold isolation resources indefinitely, and — critically —
 *   never blocks the parent event loop for even a moment, since the parent
 *   is only ever `await`ing a promise, not running the work itself.
 */
export async function runEnrichIsolated(
  dbPath: string,
  opts: BatchEnrichOptions,
  timeoutMs = 120_000,
): Promise<EnrichIsolatedResult> {
  const { modulePath, execArgv } = _forkResolverOverride
    ? _forkResolverOverride()
    : resolveEnrichHostFork();

  const id = _nextId++;
  const req: EnrichRequest = { id, dbPath, opts };

  return new Promise<EnrichIsolatedResult>((resolve) => {
    let settled = false;
    let child: ChildProcess;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const settle = (r: EnrichIsolatedResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve(r);
    };

    try {
      child = fork(modulePath, [], {
        execArgv: [...execArgv, ...process.execArgv.filter((a) => a.startsWith('--max-old-space-size'))],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        detached: false,
      });
    } catch (err) {
      settle({ ok: false, error: `spawn failed: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    child.unref();

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 3000);
      if (killTimer.unref) killTimer.unref();
      settle({ ok: false, error: 'timeout' });
    }, timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();

    child.on('message', (msg: EnrichResponse) => {
      if (msg.id !== id) return;
      if ('result' in msg) settle({ ok: true, result: msg.result });
      else settle({ ok: false, error: msg.error });
    });

    child.on('error', (err: Error) => {
      settle({ ok: false, error: `child process error: ${err.message}` });
    });

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      // Only a problem if we never got a message — a clean exit(0) after the
      // message already resolved this promise is the normal successful path.
      if (settled) return;
      settle({ ok: false, error: signal ? `signal:${signal}` : `exit:${code ?? 'null'}` });
    });

    child.send(req);
  });
}
