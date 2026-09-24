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
  off(event: 'exit', listener: () => void): void;
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
 * not exited by then. After SIGKILL it POLLS the child's `exitCode`/
 * `signalCode` over `killWaitMs` and, if the child is still alive once that
 * window elapses, logs a CRITICAL "still alive after SIGKILL" diagnostic
 * naming the pid — mirroring `killAndVerify`'s Phase 2→3 escalate-then-verify
 * shape (`libs/host-runtime/src/reaper.ts:112-138`) rather than the
 * fire-and-forget SIGKILL this module shipped with previously. `reaper.ts`'s
 * own verification (`waitForDeath`, `pidAlive`) probes the real OS process
 * table via `process.kill(pid, 0)` and is not reused directly here: this
 * child is not spawned `detached`/in its own process group, and — more
 * importantly — an OS-table probe can't be driven by the injectable
 * `ServeChildLike` test double the way `exitCode`/`signalCode` can, which is
 * how the "still alive after SIGKILL" path gets deterministic unit coverage
 * (`bl-5b2fc7a2-serve-child-forwarder.spec.ts`). Idempotent: a second signal
 * while a forward is already in flight is a no-op.
 */
export function createServeChildSignalForwarder(
  child: ServeChildLike,
  opts: { graceMs?: number; killWaitMs?: number; pollMs?: number; log?: (msg: string) => void } = {},
): { forward: (sig: NodeJS.Signals) => void; dispose: () => void } {
  const graceMs = opts.graceMs ?? 5000;
  const killWaitMs = opts.killWaitMs ?? 2000;
  const pollMs = opts.pollMs ?? 100;
  const log = opts.log ?? ((): void => { /* no-op */ });
  let forwarding = false;
  let killTimer: NodeJS.Timeout | undefined;
  let verifyTimer: NodeJS.Timeout | undefined;
  let onExit: (() => void) | undefined;

  const childDead = (): boolean => child.exitCode !== null || child.signalCode !== null;

  const clearTimers = (): void => {
    if (killTimer) clearTimeout(killTimer);
    if (verifyTimer) clearTimeout(verifyTimer);
    killTimer = undefined;
    verifyTimer = undefined;
  };

  /** Poll for death after SIGKILL, over a bounded `killWaitMs` window. */
  const verifyAfterSigkill = (sig: NodeJS.Signals, deadline: number): void => {
    if (childDead()) return;
    if (Date.now() >= deadline) {
      log(`CRITICAL: grandchild pid ${child.pid} still alive after SIGKILL (sent following ${sig}, grace ${graceMs}ms)`);
      return;
    }
    verifyTimer = setTimeout(() => verifyAfterSigkill(sig, deadline), pollMs);
    verifyTimer.unref();
  };

  const forward = (sig: NodeJS.Signals): void => {
    if (forwarding) return;
    // Check for a missing pid BEFORE latching `forwarding = true` — an early
    // call (spawn failed, or fired before the child process object even has
    // a pid assigned) must not permanently disable forwarding for every
    // subsequent signal; a later call with a real pid still needs to go
    // through.
    if (child.pid === undefined) return;
    forwarding = true;
    log(`${sig} received — forwarding to grandchild pid ${child.pid} (grace ${graceMs}ms)`);
    try {
      child.kill(sig);
    } catch (e) {
      log(`failed to signal grandchild pid ${child.pid}: ${(e as Error).message}`);
    }
    killTimer = setTimeout(() => {
      if (!childDead()) {
        log(`grandchild pid ${child.pid} survived ${sig} after ${graceMs}ms — SIGKILL`);
        try {
          child.kill('SIGKILL');
        } catch (e) {
          log(`failed to SIGKILL grandchild pid ${child.pid}: ${(e as Error).message}`);
        }
        verifyAfterSigkill(sig, Date.now() + killWaitMs);
      }
    }, graceMs);
    killTimer.unref();
    onExit = (): void => {
      clearTimers();
    };
    child.once('exit', onExit);
  };

  const dispose = (): void => {
    clearTimers();
    if (onExit) {
      child.off('exit', onExit);
      onExit = undefined;
    }
  };

  return { forward, dispose };
}
