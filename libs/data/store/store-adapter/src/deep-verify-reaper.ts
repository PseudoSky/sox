/**
 * deep-verify-reaper.ts — the deep verifier child's OFF-THREAD self-reaper
 * (BL-fc5ab895).
 *
 * The deep verifier (`deep-verify-child.ts`) spends its life inside ONE native
 * call: `PRAGMA integrity_check` → `turso_node::step_sync` → `pread`. Measured
 * in production at 21+ minutes on a 417 MB store under memory pressure. While
 * that call runs, the child's main thread cannot run a timer, cannot receive an
 * IPC `disconnect`, and cannot notice that the process that spawned it is gone.
 *
 * That matters because a non-detached child is NOT killed with its parent on
 * POSIX. The parent's own kill paths (its wall-clock timer, its `exit` hook, its
 * `close()` cancel) all run on the PARENT's main thread, and the parent can
 * itself be SIGKILLed — by the off-thread liveness watchdog this same change
 * adds, by a supervisor's `-pgid` escalation, or by an operator. An M2
 * (detached, PPID→1) backend has no process-group teardown at all
 * (docs/spec/service-lifecycle.md §"M2"). Without this reaper, each of those
 * would strand a 21-minute `integrity_check` holding a read lease on the store.
 *
 * ADR-0020 conformance: the embedding funnel's precedent is "self-reaping, no
 * orphans" — its host tears itself down on its own signal rather than trusting
 * a supervisor. This file is the same rule applied to a child whose main thread
 * is unavailable: the self-teardown runs on a `worker_thread` (which keeps
 * running while the main thread is parked in native code) and ends the process
 * with `process.kill(process.pid, 'SIGKILL')` — the only exit a blocked main
 * thread cannot delay. It departs from ADR-0020 D1 deliberately: the funnel host
 * is `detached: true` and outlives its spawner BY DESIGN (it serves many
 * consumers); a deep verifier serves exactly one open and must die with it, so
 * it is spawned `detached: false` inside the parent's process group, and this
 * reaper is what makes "dies with it" true when the parent dies uncleanly.
 *
 * Three triggers, any one is fatal:
 *  1. the recorded parent pid no longer exists (`kill(pid, 0)` → ESRCH);
 *  2. this process was reparented (`process.ppid` changed from its first value
 *     — the parent died and launchd/init adopted us);
 *  3. the hard deadline passed (the parent's wall-clock bound plus a grace), so
 *     even a parent that is alive but wedged cannot keep this child forever.
 *
 * Clock: `process.hrtime` (monotonic; on macOS it does not advance across
 * system sleep), never `Date.now()` — a wall-clock deadline would fire on the
 * first wake after a laptop lid-close.
 *
 * @module
 */

import { Worker } from 'node:worker_threads';
import { log } from '@adhd/sox-telemetry';

/** Poll period of the reaper loop. */
export const DEEP_VERIFY_REAPER_POLL_MS = 250;

/**
 * Worker source (an `eval` string, so neither the tsc `dist/` nor an esbuild
 * sidecar bundle needs a second file). Runs `for (;;)` on its own thread; it
 * never returns. Every catch reports — the one that cannot report (the host is
 * already being SIGKILLed in its `finally`) still attempts the postMessage
 * channel first.
 */
export const DEEP_VERIFY_REAPER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
const deadline = nowMs() + workerData.hardDeadlineMs;
const initialPpid = process.ppid;
function die(reason) {
  const line = JSON.stringify({
    ts: new Date().toISOString(), level: 'error', event: 'store_adapter.deep_verify.child_self_reap',
    pid: process.pid, parent_pid: workerData.parentPid, reason,
    detail: 'the deep verifier killed itself off-thread; its main thread may be parked inside a native integrity_check step',
  }) + '\\n';
  try {
    fs.writeSync(2, line);
  } catch (e) {
    parentPort.postMessage({ event: 'store_adapter.deep_verify.child_self_reap_write_failed', reason, error: String((e && e.message) || e) });
  } finally {
    process.kill(process.pid, 'SIGKILL');
  }
}
for (;;) {
  Atomics.wait(sleeper, 0, 0, workerData.pollMs);
  if (process.ppid !== initialPpid) die('reparented: ppid ' + initialPpid + ' -> ' + process.ppid);
  try {
    process.kill(workerData.parentPid, 0);
  } catch (e) {
    if (e && e.code === 'ESRCH') die('parent pid ' + workerData.parentPid + ' is gone (ESRCH)');
    else parentPort.postMessage({ event: 'store_adapter.deep_verify.child_parent_probe_failed', error: String((e && e.message) || e) });
  }
  if (nowMs() > deadline) die('hard deadline of ' + workerData.hardDeadlineMs + 'ms passed');
}
`;

export interface DeepVerifyReaperOptions {
  /** The pid whose disappearance ends this process. */
  parentPid: number;
  /** Absolute budget from start, ms. */
  hardDeadlineMs: number;
  /** Poll period, ms. Default {@link DEEP_VERIFY_REAPER_POLL_MS}. */
  pollMs?: number;
}

/**
 * Start the self-reaper for the current process. The worker is `unref()`d: it
 * never keeps a finished child alive, it only kills one that should be dead.
 */
export function startDeepVerifyReaper(opts: DeepVerifyReaperOptions): Worker {
  if (!Number.isInteger(opts.parentPid) || opts.parentPid <= 0) {
    throw new Error(`deep-verify reaper: parentPid must be a positive integer, got ${String(opts.parentPid)}`);
  }
  if (!Number.isFinite(opts.hardDeadlineMs) || opts.hardDeadlineMs <= 0) {
    throw new Error(`deep-verify reaper: hardDeadlineMs must be a positive number, got ${String(opts.hardDeadlineMs)}`);
  }
  const worker = new Worker(DEEP_VERIFY_REAPER_SOURCE, {
    eval: true,
    workerData: {
      parentPid: opts.parentPid,
      hardDeadlineMs: opts.hardDeadlineMs,
      pollMs: opts.pollMs ?? DEEP_VERIFY_REAPER_POLL_MS,
    },
  });
  worker.unref();
  worker.on('error', (err) => {
    log.error('store_adapter.deep_verify.child_reaper_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
  worker.on('message', (msg: { event?: string; error?: string; reason?: string }) => {
    log.warn(msg?.event ?? 'store_adapter.deep_verify.child_reaper_message', {
      error: msg?.error,
      reason: msg?.reason,
    });
  });
  return worker;
}
