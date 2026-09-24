/**
 * apps/sox/src/serve-shutdown.ts — BL-592 / docs/spec/service-lifecycle.md §8.1a
 * part D.
 *
 * `cmdServe`'s `--port` branch SIGTERM/SIGHUP wait, factored into its own
 * side-effect-free module so it is independently unit-testable with an
 * injectable `FrontShimHandle` test double. `main.ts` runs `void main()` at
 * import time (it is a CLI entrypoint, not a library), so nothing exported
 * from it can be imported directly by a unit test without invoking the whole
 * CLI — this module has no such side effect.
 *
 * `handle.close()` MUST be called before the returned promise resolves,
 * matching the non-port branch's own BL-310 fix a few lines below it in
 * `cmdServe`. Previously this wait resolved on SIGTERM/SIGINT WITHOUT ever
 * calling `handle.close()`, orphaning the shim's UDS connection to its backend
 * on every port-configured proxy-mode `mcp-server` shutdown (`FrontShimHandle.
 * close()` tears down that connection — `libs/service-proxy/src/shim.ts`).
 */

import type { ListenOutcome } from '@adhd/sox-listen-guard';

export function waitForServePortSignal(handle: { close: () => void }): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = () => {
      handle.close();
      resolve();
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  });
}

/**
 * BL-619: translate a guarded-listen outcome to a process exit code.
 *
 * A port collision (EADDRINUSE → disposition 'already-running') means another
 * instance is already serving the port — that is NOT a fault, so exit 0 (the
 * launchd-held port is left alone and the duplicate shim exits cleanly). Any
 * other bind error ('other') is a genuine fault — exit 1.
 */
export function exitCodeForListenOutcome(outcome: ListenOutcome): 0 | 1 {
  if (outcome.ok) return 0;
  return outcome.disposition === 'already-running' ? 0 : 1;
}

/**
 * Minimal surface of `child_process.ChildProcess` this module depends on —
 * kept narrow so a test double doesn't have to fake the real class.
 */
export interface ServeChildLike {
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'exit', listener: () => void): void;
}

/**
 * BL 5b2fc7a2 / docs/spec/service-lifecycle.md `[contract:signal]`.
 *
 * In no-proxy (log-tee) mode, `cmdServe` spawns the served extension as a
 * genuine OS grandchild of the terminal that ran `soxe serve` — the grandchild
 * has stdio wired to the parent but the parent installs NO signal handler, so
 * `kill <serve-pid>` (or a terminal close that reaches only that pid) leaves
 * the grandchild running and holding its store lease forever. The `--port`
 * proxy branch (`waitForServePortSignal`, above) already forwards; this is the
 * pure-stdio/no-proxy sibling.
 *
 * `createServeChildSignalForwarder` returns a `forward()` you call from a
 * `process.on('SIGTERM'|'SIGHUP'|'SIGINT', ...)` handler installed around the
 * spawn in `cmdServe`. On first call it SIGTERMs (or forwards whatever signal
 * arrived to) the child, arms a `graceMs` timer, and SIGKILLs if the child has
 * not exited by then — mirroring `killAndVerify`'s SIGTERM→grace→SIGKILL shape
 * (`libs/host-runtime/src/reaper.ts`) without depending on OS process-group
 * semantics, since this child is not spawned `detached`. Idempotent: a second
 * signal while a forward is already in flight is a no-op.
 */
export function createServeChildSignalForwarder(
  child: ServeChildLike,
  opts: { graceMs?: number; log?: (msg: string) => void } = {},
): { forward: (sig: NodeJS.Signals) => void; dispose: () => void } {
  const graceMs = opts.graceMs ?? 5000;
  const log = opts.log ?? ((): void => { /* no-op */ });
  let forwarding = false;
  let killTimer: NodeJS.Timeout | undefined;

  const forward = (sig: NodeJS.Signals): void => {
    if (forwarding) return;
    forwarding = true;
    if (child.pid === undefined) return;
    log(`${sig} received — forwarding to grandchild pid ${child.pid} (grace ${graceMs}ms)`);
    try {
      child.kill(sig);
    } catch (e) {
      log(`failed to signal grandchild pid ${child.pid}: ${(e as Error).message}`);
    }
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        log(`grandchild pid ${child.pid} survived ${sig} after ${graceMs}ms — SIGKILL`);
        try {
          child.kill('SIGKILL');
        } catch (e) {
          log(`failed to SIGKILL grandchild pid ${child.pid}: ${(e as Error).message}`);
        }
      }
    }, graceMs);
    killTimer.unref();
    child.once('exit', () => {
      if (killTimer) clearTimeout(killTimer);
    });
  };

  const dispose = (): void => {
    if (killTimer) clearTimeout(killTimer);
  };

  return { forward, dispose };
}
