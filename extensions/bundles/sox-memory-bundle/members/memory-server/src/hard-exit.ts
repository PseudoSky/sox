/**
 * hard-exit.ts — packet TUR-F (plan 862129b5). The ONE place memory-server is
 * allowed to terminate itself, and the reason `process.exit()` alone is not it.
 *
 * `process.exit(code)` asks Node to tear the process down, but it can only take
 * effect once the JavaScript that is currently executing returns. When the
 * process is wedged inside a blocked native step — the shape
 * mainthread-monitor.ts's incident notes measure at up to 21 minutes — an
 * `process.exit()` queued from a timer or signal handler sits behind that step
 * and never runs. A SIGKILL to self cannot be deferred: the kernel terminates
 * the process immediately, whatever the main thread is doing.
 *
 * So the policy is:
 *   - driver IDLE       → `process.exit(code)`. Nothing is blocked; the clean
 *                         path is honoured.
 *   - driver op IN FLIGHT → write a fatal JSON line straight to fd 2, then
 *                         `process.kill(process.pid, 'SIGKILL')`. A graceful
 *                         exit would wait for the blocked step (measured up to
 *                         21 min), so it is not a graceful situation.
 *
 * This is deliberately a thin function with injectable deps: it is called from
 * the process-exit seams (`backend.ts`'s `runBackend`, `liveness-watchdog.ts`'s
 * default exit, `driver-stall-watchdog.ts`) and from the driver-stall spec,
 * which must assert the SIGKILL decision WITHOUT killing the test process.
 */

import * as fs from 'node:fs';
import { log } from '@adhd/sox-memory-core';
import { getTursoDriverStatus, type TursoDriverStatus } from '@adhd/sox-store-adapter';

/** Injectable seams — production uses every default below. */
export interface HardExitDeps {
  /** Synchronous driver snapshot. Default: the real host reader (zero worker touch). */
  status?: (stallAfterMs?: number) => TursoDriverStatus;
  /** Raw stderr writer. Default: `fs.writeSync(2, text)`. */
  writeStderr?: (text: string) => void;
  /** Signal sender. Default: `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Graceful exit. Default: `process.exit`. */
  exit?: (code: number) => never;
}

/**
 * Terminate the process, SIGKILLing when a driver op is in flight so a blocked
 * native step cannot delay the exit. Returns `never`.
 */
export function forceExit(code: number, reason: string, deps: HardExitDeps = {}): never {
  const status: (stallAfterMs?: number) => TursoDriverStatus = deps.status ?? getTursoDriverStatus;
  const exit: (code: number) => never = deps.exit ?? ((c: number): never => process.exit(c));
  const kill: (pid: number, signal: NodeJS.Signals) => void =
    deps.kill ?? ((pid: number, signal: NodeJS.Signals): void => { process.kill(pid, signal); });
  const writeStderr: (text: string) => void =
    deps.writeStderr ?? ((text: string): void => { fs.writeSync(2, text); });

  const driver = status();

  if (driver.inFlight <= 0) {
    // Driver idle — a clean exit is honoured immediately; there is no blocked
    // native step for it to wait behind.
    return exit(code);
  }

  try {
    writeStderr(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'fatal',
        event: 'hard_exit.forced',
        pid: process.pid,
        code,
        reason,
        driver_state: driver.state,
        driver_in_flight: driver.inFlight,
        driver_oldest_op: driver.oldestOpLabel,
        driver_oldest_op_age_ms: driver.oldestOpAgeMs,
        detail:
          'terminating with SIGKILL: a driver operation is in flight and a graceful exit would ' +
          'wait for the blocked native step (measured up to 21 min).',
      }) + '\n',
    );
  } catch (err) {
    // fd 2 is closed/unwritable. This runs on the main thread (the only caller
    // context), so the structured logger is still reachable — record the failure
    // rather than swallowing it (AGENTS.md: never an untraced catch).
    log.error('hard_exit.stderr_write_failed', {
      code,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  kill(process.pid, 'SIGKILL');
  // SIGKILL cannot be caught, blocked, or ignored — the process ends on the
  // line above. This throw is reachable ONLY when a test injects `kill` (so the
  // runner survives) and exists solely to satisfy the `never` return type.
  throw new Error(`forceExit(${code}, ${reason}): injected kill did not terminate the process`);
}
