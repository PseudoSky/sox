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

import * as fs from 'node:fs';
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
    // .unref()'d deliberately: this timer must never by itself keep the event
    // loop alive. It relies on the live `child` ChildProcess handle (held by
    // the caller) to keep the loop running until the grandchild actually
    // exits — once nothing else references the process, Node is free to exit
    // even with this timer still pending.
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
    // .unref()'d deliberately: this timer must never by itself keep the event
    // loop alive. It relies on the live `child` ChildProcess handle (held by
    // the caller) to keep the loop running until the grandchild actually
    // exits — once nothing else references the process, Node is free to exit
    // even with this timer still pending.
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

/**
 * BL 5b2fc7a2: shared wiring for the two `cmdServe` no-proxy branches
 * (log-tee default and `--no-log`/`SOX_SERVE_LOG=0` opt-out) so the
 * SIGTERM/SIGHUP/SIGINT-forward + exit-time safety-net logic exists in one
 * place instead of being duplicated per branch. Both branches spawn (not
 * exec) their grandchild with stdio inherited/piped and otherwise differ only
 * in whether stderr is teed to a log file — the signal-handling contract is
 * identical.
 *
 * Installs:
 *  - `process.on('SIGTERM'|'SIGHUP'|'SIGINT', ...)` → `forwarder.forward(sig)`.
 *  - `process.once('exit', ...)` best-effort safety net: if this process is
 *    torn down by anything that still lets the JS event loop run an 'exit'
 *    handler (uncaught exception, explicit `process.exit` elsewhere, normal
 *    fall-through) make sure the grandchild doesn't outlive it. A direct
 *    `kill -9` on this pid cannot be intercepted from user space on any
 *    platform — that gap is unclosable, not unhandled; the child is spawned
 *    non-detached (same process group/session as this process) so an
 *    OS-delivered group signal (Ctrl-C, terminal hangup) still reaches it
 *    directly regardless of this handler.
 *
 * The caller MUST call the returned `dispose()` from its own child
 * `'close'`/`'error'` handlers before `process.exit(...)` — `dispose()` is
 * idempotent, so calling it from both the exit-time safety net and the
 * normal close/error path is safe.
 */
export function installServeChildSignalHandling(
  child: ServeChildLike,
  opts: { graceMs: number; log: (msg: string) => void },
): { dispose: () => void } {
  const forwarder = createServeChildSignalForwarder(child, {
    graceMs: opts.graceMs,
    log: opts.log,
  });
  const onParentSignal = (sig: NodeJS.Signals): void => forwarder.forward(sig);
  process.on('SIGTERM', onParentSignal);
  process.on('SIGHUP', onParentSignal);
  process.on('SIGINT', onParentSignal);
  const offParentSignals = (): void => {
    process.off('SIGTERM', onParentSignal);
    process.off('SIGHUP', onParentSignal);
    process.off('SIGINT', onParentSignal);
  };

  const onProcessExit = (): void => {
    offParentSignals();
    forwarder.dispose();
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch (e) {
        // 'exit' handlers cannot rely on async stream flushing — process.stderr
        // is a normal (possibly async, pipe-backed) writable and a write queued
        // here can be dropped when the process exits before it flushes. Use a
        // synchronous fd write instead so the diagnostic is guaranteed to land.
        const msg = `[soxe serve] exit-time SIGKILL of grandchild pid ${child.pid} failed: ${(e as Error).message}\n`;
        fs.writeSync(2, msg);
      }
    }
  };
  process.once('exit', onProcessExit);

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    offParentSignals();
    forwarder.dispose();
    process.off('exit', onProcessExit);
  };

  return { dispose };
}
